"""Validate persisted real-model study evidence without opening evaluator parameters or generating conclusions."""
import argparse
import csv
import datetime
import json
import pathlib
import re
import sys
import urllib.parse


class VerificationError(Exception):
    """A concrete evidence requirement was not met."""


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def load(path):
    return json.loads(path.read_text())


def jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def session_logs(root):
    selected = {}
    for path in (root / 'host-home' / 'sessions').glob('**/session.v*.jsonl'):
        version = int(path.name.split('.')[1][1:])
        if path.parent not in selected or version > selected[path.parent][0]:
            selected[path.parent] = (version, path)
    return [path for _, path in selected.values()]


def millis(value):
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000


def arguments(value):
    return json.loads(value) if isinstance(value, str) else value


def content_text(blocks):
    return ''.join(block['text'] for block in blocks if block.get('type') == 'text')


def result_id(value):
    """Read the retained leading artifact id when native tool-output retention pruned the middle."""
    if isinstance(value, dict):
        return value.get('id')
    if isinstance(value, str) and '[... tool result middle pruned ...]' in value:
        match = re.match(r'^\{"id":("[^"\\]*")', value)
        if match:
            return json.loads(match.group(1))
    return None


def verify(root, checks, inspect_incomplete=False):
    project, result, launch = [load(root / file) for file in ('project.json', 'run-result.json', 'launch.json')]
    if not inspect_incomplete:
        require(result.get('success') is True and result.get('exitCode') == 0 and project.get('status') == 'completed' and not project.get('failure'),
                f"Run is not complete: status={project.get('status')}, success={result.get('success')}, failure={project.get('failure')}")
    approved = {'d347e703908d0406b7a7ef80e3a0e594d86b2215':'1290e8e568dd9770d0079c85dd425bd8c2c13a5ba0b530de3df1e4bfea617beb'}
    manifest_path = pathlib.Path(__file__).resolve().parents[3] / 'UPSTREAM.json'
    if manifest_path.exists():
        current = load(manifest_path)
        approved[current['upstreamCommit']] = current['hostPatchSHA256']
    require(project['baseline'] == launch['baseline'] and launch['baseline'] in approved, 'Unexpected Harness baseline')
    require(project['communicationPatch'] == launch['communicationPatchSHA256'] == approved[launch['baseline']], 'Unexpected recorded communication patch')
    checks.append('fixed upstream and explicit communication patch' if inspect_incomplete else 'completed launch, fixed upstream and explicit communication patch')
    people = {p['id']: p for p in project['participants']}
    require(len(people) == len(project['participants']) == 5, 'Exactly five distinct participants are required')
    lead = [p for p in people.values() if p['role'] == 'lead']
    require(len(lead) == 1, 'Expected one lead')
    lead = lead[0]
    roles = {(p['role'], p.get('branch')): p for p in people.values()}
    require(set(roles) == {('lead', None), ('research', 'A'), ('research', 'B'), ('midbrain', 'A'), ('midbrain', 'B')}, 'Unexpected role or branch roster')
    sessions = {}
    for path in session_logs(root):
        rows = jsonl(path)
        require(rows and rows[0]['type'] == 'session', f'Missing native session header: {path.name}')
        header = rows[0]
        require(header['id'] not in sessions, 'Duplicate native session log')
        sessions[header['id']] = rows
    require(set(sessions) == set(people), 'Native session ids do not equal the five participant ids')
    for id, person in people.items():
        header = sessions[id][0]
        expected = None if person['role'] == 'lead' else lead['id'] if person['role'] == 'research' else roles[('research', person['branch'])]['id']
        require(person.get('parentId') == header.get('parentSession') == expected, f'Real parentage mismatch for {id}')
        require(header['delegationDepth'] == {'lead': 0, 'research': 1, 'midbrain': 2}[person['role']] and header.get('isSeeded') is False, f'Unexpected seeded identity/depth for {id}')
    checks.append('five native unseeded sessions retain lead → research A/B → own midbrain parentage')
    events = jsonl(root / 'project-events.jsonl')
    requests = [e for e in events if e['kind'] == 'model-request']
    require(len(requests) == project['modelRequests'] > 0 and [e['data']['number'] for e in requests] == list(range(1, len(requests) + 1)), 'Model admission count mismatch')
    require(all(e['data']['processId'] == project['processId'] for e in requests), 'Model calls used multiple host processes')
    require(all(e['data']['provider'] == 'stepfun-science' and e['data']['model'] == 'step-3.7-flash' for e in requests), 'Unexpected model request provider/id')
    all_calls, tool_diagnostics = [], []
    for id, rows in sessions.items():
        headers = [e['data']['header']['config'] for e in rows if e['type'] == 'request/header']
        require(headers and all(h['provider'] == 'stepfun-science' and h['model'] == 'step-3.7-flash' for h in headers), f'Native request headers missing/wrong for {id}')
        issued = {b['id']: b for e in rows if e['type'] == 'assistant/message' for b in e['data']['message']['content'] if b['type'] == 'tool-call'}
        returns = {e['data']['message']['toolCallId']: (e, e['data']['message']) for e in rows if e['type'] == 'tool/result'}
        for e in rows:
            if e['type'] != 'tool/call':
                continue
            data = e['data']
            require(data['callId'] in issued, f"Tool call lacks actual assistant tool-call block: {data['callId']}")
            block = issued[data['callId']]
            require(block['name'] == data['name'] and arguments(block['arguments']) == arguments(data['arguments']), 'Assistant and executed tool call mismatch')
            returned = returns.get(data['callId'])
            if not returned or returned[1].get('isError', False):
                tool_diagnostics.append({'owner': id, 'name': data['name'], 'callId': data['callId'],
                                         'status': 'no-result' if not returned else 'error',
                                         'detail': None if not returned else content_text(returned[1]['content'])[:1000]})
            if returned and not returned[1].get('isError', False):
                text = content_text(returned[1]['content'])
                try:
                    value = json.loads(text)
                except json.JSONDecodeError:
                    value = text
                all_calls.append({'owner': id, 'name': data['name'], 'args': arguments(data['arguments']), 'value': value,
                                  'time': e['time'], 'seq': e['seq'], 'resultTime': returned[0]['time'], 'resultSeq': returned[0]['seq']})
    checks.append('every executed tool call matches a model assistant block; all five use native StepFun request headers in one host process')
    delegations = [c for c in all_calls if c['name'] == 'science_delegate_role' and not c['value'].get('alreadyCreated')]
    require(len(delegations) == 4, 'Expected four successful model-issued native child creations')
    require({c['value']['participant']['id'] for c in delegations} == set(people) - {lead['id']}, 'Created native children do not match roster')
    for call in delegations:
        child = call['value']['participant']
        require(child['parentId'] == call['owner'] and child == people[child['id']], 'Delegation is not attributed to real parent')
        require(load(root / 'briefs' / (child['id'] + '.json')) == child, 'Prespecified branch brief differs from model-issued creation')
    consents = [c for c in all_calls if c['name'] == 'science_authorize_peer']
    require(len(consents) >= 2 and set(project['consents']) == {'A', 'B'}, 'Expected successful consent from each research parent')
    valid_consent_count = 0
    for branch in ('A', 'B'):
        other = 'B' if branch == 'A' else 'A'
        own, peer = roles[('midbrain', branch)], roles[('midbrain', other)]
        matches = [c for c in consents if c['owner'] == own['parentId'] and c['args'] == {'worker_id': own['id'], 'peer_id': peer['id'], 'peer_parent_id': peer['parentId']}]
        require(matches, f'Branch {branch} lacks exact bilateral parent authorization')
        valid_consent_count += len(matches)
    require(valid_consent_count == len(consents), 'A successful consent uses a different parent or communication pair')
    checks.append('four model-issued delegations; both real research parents authorize the same exact pair, allowing repeated identical consent')
    runs = {r['runId']: r for r in (load(p) for p in (root / 'instrument' / 'runs').glob('*.json'))}
    operations = {o['operationId']: o for o in (load(p) for p in (root / 'instrument' / 'operations').glob('*.json'))}
    require(runs and all(r['status'] == 'completed' for r in runs.values()), 'Incomplete or absent instrument runs')
    raw = []
    seen_keys = set()
    for run in runs.values():
        require(run['ownerId'] == roles[('midbrain', run['branch'])]['id'], 'Instrument run is not owned by its actual midbrain')
        key = (run['ownerId'], run['requestKey'])
        require(key not in seen_keys, 'A request key executed more than once')
        seen_keys.add(key)
        rows = load(root / 'instrument' / 'raw' / (run['runId'] + '.json'))
        csv_rows = list(csv.DictReader((root / 'instrument' / 'raw' / (run['runId'] + '.csv')).open()))
        require(len(rows) == run['acquiredReadings'] == run['requestedReadings'] == len(csv_rows), 'Raw/readings/budget counts differ')
        for row, csv_row in zip(rows, csv_rows):
            require(all((float(csv_row[k]) == v if isinstance(v, (int, float)) else csv_row[k] == v) for k, v in row.items()), 'CSV and JSON raw observations differ')
        require(1 <= len(run['operationIds']) <= 3, 'Run operation limit exceeded')
        for op_id in run['operationIds']:
            op = operations[op_id]
            op_rows = [r for r in rows if r['operationId'] == op_id]
            require(op['runId'] == run['runId'] and op['status'] == 'completed' and len(op_rows) == op['count'] == op['acquiredReadings'], 'Operation completion or acquired count mismatch')
            require(1 <= op['count'] <= 8 and -1 <= op['condition'] <= 1, 'Instrument execution bound exceeded')
            require(all(r['runId'] == run['runId'] and r['requestedCondition'] == r['appliedCondition'] == op['condition'] for r in op_rows), 'Raw applied condition differs from operation')
        require(len(rows) == sum(operations[id]['count'] for id in run['operationIds']), 'Raw rows contain an unlisted operation')
        submits = [c for c in all_calls if c['name'] == 'instrument_submit' and c['owner'] == run['ownerId'] and isinstance(c['value'], dict) and c['value'].get('runId') == run['runId']]
        require(submits and any(c['args']['operations'] == [{'condition': operations[id]['condition'], 'count': operations[id]['count']} for id in run['operationIds']] for c in submits), 'Executed run lacks matching model-issued submission')
        raw.extend(rows)
    require(set(operations) == {id for r in runs.values() for id in r['operationIds']}, 'Unreferenced operation records')
    raw.sort(key=lambda row: row['order'])
    require([r['order'] for r in raw] == list(range(1, len(raw) + 1)) and 0 < len(raw) <= 96, 'Raw acquisition order repeats/gaps or budget exceeded')
    budget = load(root / 'instrument' / 'budget.json')
    accounting = ('limit', 'acquired', 'reserved', 'remaining', 'activeRunId')
    require(all(budget[k] == project['instrumentBudget'][k] for k in accounting) and budget['limit'] == 96 and budget['acquired'] == len(raw) and budget['reserved'] == 0 and budget['remaining'] == 96 - len(raw) and budget['activeRunId'] is None, 'Final instrument budget accounting inconsistent')
    ledger = jsonl(root / 'instrument' / 'events.jsonl')
    require([e['data'] for e in ledger if e['type'] == 'reading-acquired'] == raw, 'Acquisition event ledger differs from published raw data')
    active, starts, completions = None, set(), set()
    for event in ledger:
        kind, data = event['type'], event['data']
        if kind == 'started':
            require(active is None and data['runId'] not in starts, 'Conflicting or duplicate instrument execution start')
            active = data['runId']; starts.add(active)
        elif kind in ('condition-applied', 'reading-acquired', 'operation-completed'):
            require(active == data['runId'], 'Acquisition event outside exclusive active run')
        elif kind in ('completed', 'failed'):
            require(kind == 'completed' and active == data['runId'], 'Failed or mismatched terminal acquisition event')
            completions.add(active); active = None
    require(active is None and starts == completions == set(runs), 'Instrument starts/ends do not reconcile')
    checks.append('model-issued bounded runs, raw JSON/CSV/operations/event ledger equality, global acquisition order, 96-reading budget and exclusive execution')
    initial = {r['branch']: r for r in runs.values() if r['phase'] == 'initial'}
    require(set(initial) == {'A', 'B'} and sum(r['phase'] == 'initial' for r in runs.values()) == 2, 'Expected one completed initial run per branch')
    messages = {}
    for id, rows in sessions.items():
        for e in rows:
            if e['type'] == 'user/message' and e['data']['source']['kind'] == 'science-result':
                data = e['data']; envelope = json.loads(content_text(data['content'])); source = data['source']
                require(data['id'] == envelope['messageId'] and data['id'] not in messages, 'Duplicate/mismatched processed message id')
                sender = people[envelope['senderSessionId']]
                require(sender['role'] == people[id]['role'] == 'midbrain' and sender['branch'] != people[id]['branch'], 'Message does not connect different research branches')
                require(source['senderSessionId'] == sender['id'] and source['senderParentSessionId'] == sender['parentId'] and source['recipientParentSessionId'] == people[id]['parentId'], 'Original sender or real parent identity was lost')
                require(source['project'] == envelope['project'] == project['project'], 'Message escaped single project')
                messages[data['id']] = {'recipient': id, 'envelope': envelope, 'seq': e['seq'], 'time': e['time']}
    exchanges = {e['messageId']: e for e in project['exchanges']}
    require(len(exchanges) == len(project['exchanges']) and set(messages) <= set(exchanges) and set(messages) == {m['messageId'] for m in project['processed']}, 'Processed message lacks unique acceptance or native processing record')
    sent_calls = {}
    for id, exchange in exchanges.items():
        sender, target = people[exchange['senderId']], people[exchange['targetId']]
        require(sender['role'] == target['role'] == 'midbrain' and sender['branch'] != target['branch'], 'Accepted message is outside the exact cross-branch pair')
        if id in messages:
            message = messages[id]; envelope = message['envelope']
            require(exchange['senderId'] == envelope['senderSessionId'] and exchange['targetId'] == message['recipient'] and exchange['resultId'] == envelope['resultId'] and exchange['kind'] == envelope['kind'], 'Message acceptance record differs from actual recipient input')
        sends = [c for c in all_calls if c['name'] == 'science_send_result' and c['owner'] == exchange['senderId'] and c['value'].get('messageId') == id]
        require(len(sends) == 1 and sends[0]['args']['target_id'] == exchange['targetId'] and sends[0]['args']['result_id'] == exchange['resultId'] and sends[0]['args']['kind'] == exchange['kind'], 'Accepted message lacks matching model-issued send')
        sent_calls[id] = sends[0]
    required_reference_ids = []
    for branch in ('A', 'B'):
        own = roles[('midbrain', branch)]['id']
        refs = [m for m in messages.values() if m['envelope']['kind'] == 'reference' and m['envelope']['senderSessionId'] == own and m['envelope']['resultId'] == initial[branch]['runId']]
        require(refs, f'Branch {branch} must send its own initial reference and its peer must process it')
        required_reference_ids.extend(ref['envelope']['messageId'] for ref in refs)
    processed_replies = 0
    for id, exchange in exchanges.items():
        if exchange['kind'] != 'reply':
            continue
        call = sent_calls[id]
        ref_id = call['args'].get('in_reply_to')
        require(ref_id in messages, 'Accepted reply does not correlate to a processed reference')
        ref = messages[ref_id]
        require(ref['envelope']['kind'] == 'reference' and ref['recipient'] == exchange['senderId'] and ref['envelope']['senderSessionId'] == exchange['targetId'] and ref['envelope']['resultId'] == exchange['resultId'], 'Reply correlation reverses neither the original participants nor the same result')
        read_calls = [c for c in all_calls if c['owner'] == ref['recipient'] and c['name'] == 'instrument_read' and exchange['resultId'] in c['args']['run_ids'] and c['seq'] > ref['seq']]
        require(any(c['resultSeq'] < call['seq'] for c in read_calls), 'Correlated reply was not preceded by actual peer result read after message processing started')
        if id in messages:
            require(messages[id]['envelope'].get('inReplyTo') == ref_id, 'Delivered reply changed its original correlation')
            processed_replies += 1
    require(processed_replies >= 1, 'No valid correlated peer reply was actually processed')
    checks.append('both own initial references accepted and processed across different parents; original sender retained; every accepted reply follows a peer read and at least one correlated reply is delivered back')
    analyses = {a['id']: load(root / a['artifactPath']) for a in project['analyses']}
    require(analyses and len(analyses) == len(list((root / 'analyses').glob('*.json'))), 'Analysis inventory mismatch')
    for analysis in analyses.values():
        expected = [row for row in raw if row['runId'] in analysis['runIds']]
        require(analysis['inputs'] == expected and set(analysis['runIds']) <= set(runs), 'Analysis inputs differ from original raw readings')
        require(all(millis(runs[id]['finishedAt']) <= millis(analysis['createdAt']) for id in analysis['runIds']), 'Analysis predates acquisition completion')
        calls = [c for c in all_calls if c['name'] == 'science_analyze' and c['owner'] == analysis['ownerId'] and result_id(c['value']) == analysis['id']]
        require(len(calls) == 1 and calls[0]['args']['method'] == analysis['method'] and calls[0]['args']['rationale'] == analysis['rationale'] and calls[0]['time'] <= millis(analysis['createdAt']) <= calls[0]['resultTime'], 'Analysis lacks model-selected method and rationale within its actual tool execution')
    for branch in ('A', 'B'):
        require(any(a['ownerId'] == roles[('research', branch)]['id'] and initial[branch]['runId'] in a['runIds'] for a in analyses.values()), f'Research {branch} did not analyze own initial observations')
    decisions = {d['id']: load(root / d['artifactPath']) for d in project['decisions']}
    followups = [r for r in runs.values() if r['phase'] == 'followup']
    require(decisions and followups, 'No evidence-linked follow-up decision and completed additional experiment')
    for decision in decisions.values():
        require(decision['ownerId'] == lead['id'] and decision['rationale'] and decision['discrimination'], 'Follow-up decision lacks lead authorship or reasoning')
        cited = [analyses[id] for id in decision['analysisIds']]
        require(cited and all(millis(a['createdAt']) < millis(decision['createdAt']) for a in cited), 'Decision does not cite existing earlier analyses')
        require(all(any(initial[b]['runId'] in a['runIds'] for a in cited) for b in ('A', 'B')), 'Decision does not cite both initial branches')
        calls = [c for c in all_calls if c['owner'] == lead['id'] and c['name'] == 'science_choose_followup' and result_id(c['value']) == decision['id']]
        require(len(calls) == 1 and calls[0]['args']['operations'] == decision['operations'] and calls[0]['args']['rationale'] == decision['rationale'] and calls[0]['args']['analysis_ids'] == decision['analysisIds'], 'Saved follow-up differs from actual model choice')
        require(any(r.get('decisionId') == decision['id'] for r in followups), 'Lead decision was never executed')
    for run in followups:
        decision = decisions[run['decisionId']]
        actual = [{'condition': operations[id]['condition'], 'count': operations[id]['count']} for id in run['operationIds']]
        require(run['branch'] == decision['branch'] and actual == decision['operations'] and millis(run['createdAt']) > millis(decision['createdAt']), 'Follow-up operations/branch/time do not match prior lead decision')
        require(any(run['runId'] in a['runIds'] for a in analyses.values()), 'Follow-up observations have no numerical analysis')
    checks.append('analyses use unchanged raw observations; real lead chooses evidence-linked follow-up after both branches; exact operations execute afterwards and enter analysis')
    report = project['report']
    require(report and report == result['report'], 'Published report metadata mismatch')
    text = (root / report['artifactPath']).read_text()
    calls = [c for c in all_calls if c['owner'] == lead['id'] and c['name'] == 'science_write_report']
    require(len(calls) == 1 and calls[0]['args']['markdown'] == text, 'Saved report differs from successful real-model Markdown tool argument')
    links = re.findall(r'(?<!!)\[[^\]]*\]\(([^)]+)\)', text)
    local = set()
    for link in links:
        url = urllib.parse.urlsplit(link.strip('<>'))
        if url.scheme or url.netloc or not url.path:
            continue
        path = (root / report['artifactPath']).parent / urllib.parse.unquote(url.path)
        path = path.resolve()
        require(path.is_relative_to(root) and path.is_file(), f'Broken or outside-project report link: {url.path}')
        local.add(path.relative_to(root).as_posix())
    required = set(report['analysisPaths'] + report['rawPaths'] + report['decisionPaths'])
    require(required <= local and all(id in text for id in runs), f'Report lacks working required evidence links: {sorted(required - local)}')
    require(all(millis(a['createdAt']) <= millis(report['createdAt']) for a in analyses.values()), 'An analysis was created after the report')
    shutdown = [e for e in events if e['kind'] == 'controlled-shutdown']
    require(len(shutdown) == 1 and set(shutdown[0]['data']['remainingAgents']) <= {lead['id']}, 'Native controlled child shutdown did not complete')
    require(not any(e['kind'] == 'stopped' for e in events), 'Completed run contains an unresolved stop event')
    checks.append('saved report is exact successful model tool input with working evidence links; native descendant drain completed')
    return {'participants': 5, 'modelRequests': len(requests), 'successfulModelToolCalls': len(all_calls), 'delegations': len(delegations), 'consents': len(consents),
            'runs': len(runs), 'operations': len(operations), 'readings': len(raw), 'crossBranchMessages': len(messages), 'analyses': len(analyses),
            'decisions': len(decisions), 'followupRuns': len(followups), 'report': report['artifactPath'], 'reportLocalLinks': len(local),
            'consentingParents': 2, 'processedReplies': processed_replies,
            'diagnostics': {'acceptedMessagesNotProcessed': sorted(set(exchanges) - set(messages)), 'requiredInitialReferenceIds': required_reference_ids, 'toolErrorsOrMissingResults': tool_diagnostics}}


def archive_attempts(root, destination):
    """Archive every model-proposed report verbatim; none receives completed-report status."""
    project = load(root / 'project.json')
    lead_ids = {p['id'] for p in project['participants'] if p['role'] == 'lead'}
    proposals = []
    for path in session_logs(root):
        rows = jsonl(path)
        if rows[0]['id'] not in lead_ids:
            continue
        issued = {b['id']: b for e in rows if e['type'] == 'assistant/message' for b in e['data']['message']['content'] if b['type'] == 'tool-call'}
        returns = {e['data']['message']['toolCallId']: e['data']['message'] for e in rows if e['type'] == 'tool/result'}
        for event in rows:
            if event['type'] != 'tool/call' or event['data']['name'] != 'science_write_report':
                continue
            data = event['data']; block = issued.get(data['callId'])
            require(block and block['name'] == data['name'] and arguments(block['arguments']) == arguments(data['arguments']), 'Report attempt lacks matching model assistant block')
            markdown = arguments(data['arguments'])['markdown']
            require(isinstance(markdown, str), 'Attempted report Markdown is not text')
            returned = returns.get(data['callId'])
            proposals.append({'time': event['time'], 'sessionId': rows[0]['id'], 'callId': data['callId'], 'markdown': markdown,
                              'toolResult': returned, 'sourceSession': path.relative_to(root).as_posix(), 'sourceSeq': event['seq']})
    require(proposals, 'No model-issued report attempts to archive')
    destination.mkdir(parents=True, exist_ok=False)
    manifest = []
    for index, proposal in enumerate(sorted(proposals, key=lambda p: p['time']), 1):
        filename = f'attempted-report-{index:02}.md'
        (destination / filename).write_text(proposal.pop('markdown'))
        manifest.append({'artifactPath': filename, 'status': 'attempted-not-published', **proposal})
    (destination / 'attempted-reports.json').write_text(json.dumps({'status': 'attempted-not-published', 'projectStatus': project['status'],
                                                                  'sourceRoot': str(root), 'attempts': manifest}, indent=2, ensure_ascii=False) + '\n')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=pathlib.Path)
    parser.add_argument('--inspect-incomplete', action='store_true', help='Inspect available evidence until the first gap; never produce an acceptance pass')
    parser.add_argument('--archive-attempted-reports', type=pathlib.Path, help='Archive all model-proposed report strings in a new directory; never publish them as completed reports')
    args = parser.parse_args()
    root = args.root.resolve()
    checks = []
    try:
        if args.archive_attempted_reports:
            attempts = archive_attempts(root, args.archive_attempted_reports.resolve())
            print(json.dumps({'status': 'archived-attempts-only', 'acceptance': False, 'attempts': len(attempts), 'directory': str(args.archive_attempted_reports.resolve())}, indent=2))
            sys.exit(0)
        counts = verify(root, checks, args.inspect_incomplete)
        print(json.dumps({'status': 'incomplete-evidence' if args.inspect_incomplete else 'passed', 'acceptance': not args.inspect_incomplete,
                          'root': str(root), 'checks': checks, 'counts': counts,
                          'limits': ['Evidence consistency does not independently audit provider HTTP transport or scientific prose.',
                                     'Evaluator parameters were not read. Offline numerical replay is a separate recompute.ts command.']}, indent=2, ensure_ascii=False))
    except (VerificationError, OSError, KeyError, TypeError, ValueError, IndexError) as error:
        print(json.dumps({'status': 'incomplete-evidence' if args.inspect_incomplete else 'failed', 'acceptance': False,
                          'root': str(root), 'completedChecks': checks, 'error': str(error)}, indent=2, ensure_ascii=False))
        sys.exit(0 if args.inspect_incomplete else 1)
