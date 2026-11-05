"""Derive physical occupancy, repeated effects and compaction continuity from existing run evidence."""
from collections import Counter, defaultdict
from contextlib import closing
import hashlib
import json
from pathlib import Path
from verify import read_database


def session_rows(path):
    rows = []
    with path.open() as handle:
        for line in handle:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                if line.endswith('\n'):
                    raise
                break  # An in-flight last record is not a completed event.
    return rows


def arguments(event):
    try:
        value = json.loads(event['data']['arguments'])
    except (KeyError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def completion_calls(rows, task):
    good = {event['data']['message']['toolCallId'] for event in rows
            if event['type'] == 'tool/result' and not event['data']['message'].get('isError')}
    return [event for event in rows if event['type'] == 'tool/call'
            and event['data']['name'] == 'lab_complete' and event['data']['callId'] in good
            and arguments(event) == {'task_id': task['id'], 'operation_id': task['result']}]


def incoming(rows, message, kind='greenhouse-mail'):
    for event in rows:
        if event['type'] != 'user/message':
            continue
        for block in event['data'].get('content', []):
            if block.get('type') != 'text':
                continue
            try:
                envelope = json.loads(block['text'])
            except json.JSONDecodeError:
                continue
            if isinstance(envelope, dict) and envelope.get('kind') == kind and all(
                    envelope.get(key) == message[value] for key, value in [
                        ('messageId', 'id'), ('from', 'from'), ('to', 'to'), ('taskId', 'task_id'), ('content', 'content')]):
                return event
    return None


def observe(directory, offline=False, sessions=None):
    """Read tick intervals and native event order; offline requires closed checkpointed stores."""
    root = Path(directory).resolve()
    session_root = Path(sessions) if sessions else root / "sessions"
    def database(relative):
        return read_database(root / relative, offline)
    with closing(database('device/greenhouse.sqlite')) as db:
        world = json.loads(db.execute('SELECT state FROM world WHERE id=1').fetchone()[0])
    with closing(database('execution/execution.sqlite')) as db:
        facts = [json.loads(row[0]) for row in db.execute("SELECT data_json FROM events WHERE type='fact' ORDER BY seq")]
        operations = {row[0]: {'actorId': row[1], 'state': row[2], 'input': json.loads(row[3])}
                      for row in db.execute('SELECT id,actor_id,state,input_json FROM operations')}
        artifacts = [dict(zip(('operationId', 'path', 'sha256', 'bytes'), row)) for row in
                     db.execute('SELECT operation_id,path,sha256,bytes FROM artifacts')]
    registrations = {f['data']['name']: f['data']['id'] for f in facts if f['kind'] == 'greenhouse-member-registered'}
    sessions = {role: session_rows(next(session_root.glob('**/' + actor + '/session.v4.jsonl')))
                for role, actor in registrations.items()}
    written = {f['data']['messageId']: f['data'] for f in facts if f['kind'] == 'greenhouse-mail-written'}
    accepted = {f['data']['messageId'] for f in facts if f['kind'] == 'greenhouse-mail-delivered'}
    board = json.loads((root / 'router/board.json').read_text())
    mail = [message for message in board['messages'] if message['id'] in accepted and all(
            written.get(message['id'], {}).get(key) == message[value] for key, value in [
                ('from', 'from'), ('to', 'to'), ('taskId', 'task_id'), ('content', 'content')])]
    results = []
    for role, rows in sessions.items():
        for start in (e for e in rows if e['type'] == 'compaction/start'):
            cid = start['data']['compactionId']
            related = [e for e in rows if e['type'].startswith('compaction/') and e['data']['compactionId'] == cid]
            summary = next((e for e in related if e['type'] == 'compaction/summary'), None)
            end = next((e for e in related if e['type'] == 'compaction/end'), None)
            record = {'role': role, 'actorId': registrations[role], 'compactionId': cid,
                      'startSeq': start['seq'], 'summarySeq': summary['seq'] if summary else None,
                      'endSeq': end['seq'] if end else None,
                      'summarySucceeded': bool(summary and end and 'error' not in end['data']), 'pendingTasks': []}
            for task in (t for t in board['tasks'] if t['assignee'] == role):
                # A recorded assignment must have actually reached this participant before the summary.
                announcements = [incoming(rows, m) for m in mail if m.get('task_id') == task['id']
                                 and m['to'] == role and m['content'].startswith('Assignment ')]
                positions = [e['seq'] for e in announcements if e]
                if task['created_by'] == role:
                    successful = {e['data']['message']['toolCallId']: e for e in rows if e['type'] == 'tool/result'
                                  and not e['data']['message'].get('isError')}
                    for call in rows:
                        if call['type'] != 'tool/call' or call['data']['name'] != 'lab_assign':
                            continue
                        result = successful.get(call['data']['callId'])
                        if result:
                            text = ''.join(b['text'] for b in result['data']['message']['content'] if b['type'] == 'text')
                            value = json.loads(text)
                            if isinstance(value, dict) and value.get('task', {}).get('id') == task['id']:
                                positions.append(result['seq'])
                closes = completion_calls(rows, task)
                if not positions or min(positions) >= start['seq'] or any(c['seq'] < start['seq'] for c in closes):
                    continue
                post = [c for c in closes if end and c['seq'] > end['seq']]
                operation = operations.get(task['result'])
                owned = [a for a in artifacts if a['operationId'] == task['result']]
                intact = bool(owned)
                for artifact in owned:
                    path = (root / 'execution' / artifact['path']).resolve()
                    intact = intact and path.is_relative_to(root / 'execution') and path.is_file()
                    if intact:
                        content = path.read_bytes()
                        intact = len(content) == artifact['bytes'] and hashlib.sha256(content).hexdigest() == artifact['sha256']
                notices = [m for m in mail if m.get('task_id') == task['id'] and m['to'] == task['created_by']
                           and m['content'].startswith('Task ') and task['result'] and task['result'] in m['content']]
                owner_rows = sessions[task['created_by']]
                owner_evidence = []
                for notice in notices:
                    received = incoming(owner_rows, notice)
                    response = next((e for e in owner_rows if received and e.get('seq', -1) > received['seq']
                                     and e['type'] == 'assistant/message' and not e['data'].get('interrupted')), None)
                    if received and response:
                        owner_evidence.append({'messageId': notice['id'], 'inputSeq': received['seq'], 'nextResponseSeq': response['seq']})
                experiment = json.loads(task['spec'])['id']
                checks = {'successfulSummary': record['summarySucceeded'], 'successfulClosureCallAfterEnd': bool(post),
                          'sameActorSuccessfulAnalysis': bool(operation and operation['actorId'] == registrations[role]
                              and operation['state'] == 'succeeded' and operation['input'].get('action') == 'analyze'
                              and operation['input'].get('taskId') == experiment),
                          'artifactHashes': intact,
                          'ownerReceiptOrSelfExecution': task['created_by'] == role or bool(owner_evidence)}
                history = [e['seq'] for e in rows if end and e.get('seq', -1) > end['seq'] and e['type'] == 'tool/call'
                           and e['data']['name'] == 'greenhouse_history' and (arguments(e) or {}).get('task_id') == experiment]
                record['pendingTasks'].append({'routerTaskId': task['id'], 'experimentTaskId': experiment,
                    'assignmentInputSeq': min(positions), 'closureCallSeqs': [e['seq'] for e in post],
                    'historyCallSeqsAfterSummary': history, 'analysisOperationId': task['result'],
                    'ownerEvidence': owner_evidence, 'checks': checks, 'verifiedContinuity': all(checks.values())})
            results.append(record)
    return {'timeReference': 'simulation-ticks-and-native-session-sequence',
            'resources': resource_observation(world), 'repeats': repeat_observation(operations, sessions),
            'compactionContinuity': {'pendingTaskOpportunities': sum(len(c['pendingTasks']) for c in results),
                'verifiedPendingTaskClosures': sum(t['verifiedContinuity'] for c in results for t in c['pendingTasks']),
                'events': results},
            'interpretation': 'Native sequence numbers are local to each Session; handoffs use authenticated message IDs. Repeats are descriptive, not a scientific-value score. Observed continuation does not establish information loss or architecture superiority.'}



def resource_observation(world):
    """Count actual operation intervals once per operation and separately per exclusive resource."""
    horizon = world['tick']
    resources, transitions = defaultdict(list), Counter()
    for job in world['jobs']:
        start, end = job['startedTick'], min(job.get('completedTick', horizon), horizon)
        if start >= horizon or end <= start:
            continue
        transitions[start] += 1
        transitions[end] -= 1
        for name in job['resources']:
            resources[name].append((start, end))
    measured = {}
    for name, intervals in resources.items():
        busy = overlap = previous_end = 0
        for start, end in sorted(intervals):
            overlap += max(0, min(end, previous_end) - start)
            busy += max(0, end - max(start, previous_end))
            previous_end = max(previous_end, end)
        measured[name] = {'busyTicks': busy, 'overlappingExclusiveOperationTicks': overlap}
    active = previous = any_busy = parallel = peak = 0
    for tick, delta in sorted(transitions.items()):
        span = tick - previous
        any_busy += span if active else 0
        parallel += span if active > 1 else 0
        active += delta
        peak = max(peak, active)
        previous = tick
    return {'throughTick': horizon, 'anyOperationBusyTicks': any_busy,
            'twoOrMoreOperationsBusyTicks': parallel, 'peakConcurrentOperations': peak, 'byResource': measured}


def repeat_observation(operations, sessions):
    """Separate distinct successful effects from repeated model calls and corrected arguments."""
    assays, analyses = defaultdict(list), defaultdict(list)
    for identity, op in operations.items():
        if op['state'] != 'succeeded':
            continue
        command = op['input']
        if command['action'] == 'assay':
            assays[command['sampleId']].append(identity)
        elif command['action'] == 'analyze':
            analyses[command['taskId']].append(identity)
    calls, keys, invalid_json = Counter(), defaultdict(set), 0
    for role, rows in sessions.items():
        for event in rows:
            if event['type'] != 'tool/call' or not event['data']['name'].startswith('greenhouse_'):
                continue
            args = arguments(event)
            if args is None:
                invalid_json += 1
                continue
            if not isinstance(args.get('requestKey'), str):
                continue
            canonical = json.dumps(args, sort_keys=True, separators=(',', ':'))
            pair = (event['data']['name'], canonical)
            calls[(role, *pair)] += 1
            keys[(role, args['requestKey'])].add(pair)
    return {'additionalSameSampleAssays': sum(len(ids) - 1 for ids in assays.values()),
            'additionalSameTaskAnalyses': sum(len(ids) - 1 for ids in analyses.values()),
            'identicalActionToolCallRepeats': sum(count - 1 for count in calls.values()),
            'requestKeysUsedWithDifferentArguments': sum(len(values) > 1 for values in keys.values()),
            'invalidJsonToolArguments': invalid_json}
