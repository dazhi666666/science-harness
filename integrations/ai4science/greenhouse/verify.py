"""Read-only verification of a greenhouse team snapshot; not a scientific-quality or architecture-benefit score."""
import argparse
from contextlib import closing
import hashlib
import json
import pathlib
import sqlite3


def read_database(path, offline=False):
    wal = pathlib.Path(str(path) + '-wal')
    if offline and wal.exists() and wal.stat().st_size:
        raise ValueError('Offline verification requires a closed, checkpointed database without a WAL file')
    return sqlite3.connect(path.resolve().as_uri() + ('?mode=ro&immutable=1' if offline else '?mode=ro'), uri=True)


def verify(directory, sessions=None, offline=False):
    directory = pathlib.Path(directory).resolve()
    sessions = pathlib.Path(sessions).resolve() if sessions else directory / 'sessions'
    with closing(read_database(directory / 'device' / 'greenhouse.sqlite', offline)) as device:
        scenario_text, state_text = device.execute('SELECT config,state FROM world WHERE id=1').fetchone()
        scenario, state = json.loads(scenario_text), json.loads(state_text)
        device_events = [json.loads(raw) | {'kind': kind} for kind, raw in device.execute('SELECT kind,payload FROM events ORDER BY seq')]
    with closing(read_database(directory / 'execution' / 'execution.sqlite', offline)) as execution:
        execution.row_factory = sqlite3.Row
        operations = {row['id']: dict(row) for row in execution.execute('SELECT * FROM operations')}
        artifacts = [dict(row) for row in execution.execute('SELECT * FROM artifacts')]
        facts = [json.loads(row[0]) for row in execution.execute("SELECT data_json FROM events WHERE type='fact' ORDER BY seq")]
    board = json.loads((directory / 'router' / 'board.json').read_text())
    checks = []

    def check(name, passed):
        checks.append({'name': name, 'passed': bool(passed)})

    registrations = {fact['data']['name']: fact['data'] for fact in facts if fact['kind'] == 'greenhouse-member-registered'}
    lead = registrations.get('lead', {})
    run_configs = [fact['data'] for fact in facts if fact['kind'] == 'greenhouse-run-config']
    mode = run_configs[-1]['mode'] if run_configs else 'multi-agent'
    check('declared_native_roles', set(registrations) == ({'lead'} if mode == 'single-agent' else {'lead', 'chamber-A', 'chamber-B', 'chamber-C'}))
    parent_links = bool(lead)
    native_sessions = {}
    for name, member in registrations.items():
        paths = [path for path in sessions.glob(f'**/{member["id"]}/session.v*.jsonl') if path.stem.split('.v')[-1].isdigit()]
        if not paths:
            parent_links = False
            continue
        header_path = max(paths, key=lambda path: int(path.stem.split('.v')[-1]))
        with header_path.open() as handle:
            rows = [json.loads(line) for line in handle]
        header = rows[0]
        native_sessions[name] = rows
        parent_links &= header.get('id') == member['id']
        parent_links &= header.get('parentSession') == (None if name == 'lead' else lead.get('id'))
    check('persisted_native_parent_links', parent_links)
    requests = [fact['data'] for fact in facts if fact['kind'] == 'greenhouse-model-request']
    sources = sorted({request['source'] for request in requests})
    check('model_source_recorded_without_mixing', len(sources) == 1 and bool(requests))
    if sources == ['scripted']:
        check('scripted_route_is_labelled', {request['provider'] for request in requests} <= {'teams-probe', 'greenhouse-scripted'})
    elif sources == ['real-model']:
        pool = run_configs[-1].get('providerPool', ['intern-greenhouse']) if run_configs else ['intern-greenhouse']
        check('real_model_route', all(request['model'] == 'intern-s2' and request['provider'] in pool for request in requests))
    else:
        check('known_model_source', False)
    tasks = {task['id']: task for task in state['tasks']}
    check('all_scheduled_task_requests_available', all(event['kind'] != 'task' or event['id'] in state['appliedEvents'] for event in scenario['events']))
    check('available_experiments_completed', bool(tasks) and set(tasks) <= set(state['completedTasks']))
    assignments = board['tasks']
    check('assignments_cover_experiments', {json.loads(task['spec'])['id'] for task in assignments} == set(tasks))
    linked = bool(assignments)
    for task in assignments:
        experiment = json.loads(task['spec'])
        operation = operations.get(task['result'])
        if not operation:
            linked = False
            continue
        command = json.loads(operation['input_json'])
        linked &= task['status'] == 'done' and operation['state'] == 'succeeded'
        linked &= command.get('action') == 'analyze' and command.get('taskId') == experiment['id']
        linked &= task['assignee'] == ('lead' if mode == 'single-agent' else 'chamber-' + experiment['chamber'])
        linked &= operation['actor_id'] == registrations.get(task['assignee'], {}).get('id')
        linked &= bool(task['artifacts']) and set(task['artifacts']) <= {artifact['id'] for artifact in artifacts if artifact['operation_id'] == operation['id']}
    check('task_analysis_links', linked)
    jobs = {job['id']: job for job in state['jobs']}
    starts = [event['id'] for event in device_events if event['kind'] == 'operation-started']
    check('device_start_ids_unique', len(starts) == len(set(starts)))
    check('all_platform_operations_match_device_outcomes', bool(operations) and all(
        operation['id'] in jobs and operation['state'] == jobs[operation['id']]['state'] for operation in operations.values()))
    check('device_samples_are_distinct', len(state['samples']) == len({sample['id'] for sample in state['samples']}) ==
          sum(job['command']['action'] == 'sample' and job['state'] == 'succeeded' for job in jobs.values()))
    intact = bool(artifacts)
    for artifact in artifacts:
        path = (directory / 'execution' / artifact['path']).resolve()
        if not path.is_relative_to(directory / 'execution') or not path.is_file():
            intact = False
            continue
        content = path.read_bytes()
        intact &= len(content) == artifact['bytes'] and hashlib.sha256(content).hexdigest() == artifact['sha256']
    check('artifact_sizes_and_hashes', intact)
    deliveries = {fact['data']['messageId']: fact['data'] for fact in facts if fact['kind'] == 'greenhouse-mail-delivered'}
    written = {fact['data']['messageId']: fact['data'] for fact in facts if fact['kind'] == 'greenhouse-mail-written'}
    def authentic_message(message):
        envelope = written.get(message['id'], {})
        return message['id'] in deliveries and all(envelope.get(key) == message[value] for key, value in [
            ('from', 'from'), ('to', 'to'), ('taskId', 'task_id'), ('content', 'content')])
    check('messages_have_native_acceptance', (mode == 'single-agent' or bool(board['messages'])) and all(authentic_message(message) for message in board['messages']))

    def native_mail_position(message):
        rows = native_sessions.get(message['to'], [])
        for index, event in enumerate(rows):
            if event.get('type') != 'user/message':
                continue
            for block in event['data'].get('content', []):
                if block.get('type') != 'text':
                    continue
                try:
                    envelope = json.loads(block['text'])
                except json.JSONDecodeError:
                    continue
                if not isinstance(envelope, dict) or envelope.get('kind') != 'greenhouse-mail':
                    continue
                if all(envelope.get(key) == message[value] for key, value in [
                        ('messageId', 'id'), ('from', 'from'), ('to', 'to'), ('content', 'content')]):
                    return index
        return None

    def reached_model(message):
        index = native_mail_position(message)
        return index is not None and any(event.get('type') == 'assistant/message' and not event.get('data', {}).get('interrupted')
                                         for event in native_sessions[message['to']][index + 1:])

    notices = [message for message in board['messages'] if message['to'] == 'lead' and message['task_id'] and message['content'].startswith('Task ')]
    check('completion_notices_reached_owner_model', len(notices) == (0 if mode == 'single-agent' else len(assignments)) and all(reached_model(message) for message in notices))
    result_reads = {}
    for role, rows in native_sessions.items():
        calls, reads = {}, []
        for index, event in enumerate(rows):
            data = event.get('data', {})
            if event.get('type') == 'tool/call' and data['name'] == 'greenhouse_result':
                try:
                    calls[data['callId']] = json.loads(data['arguments'])
                except json.JSONDecodeError:
                    continue  # A rejected model argument is not a verified result read.
            if event.get('type') != 'tool/result':
                continue
            message = data['message']
            args = calls.get(message['toolCallId'])
            if not isinstance(args, dict) or message.get('isError'):
                continue
            value = json.loads(''.join(block['text'] for block in message['content'] if block['type'] == 'text'))
            operation = value['operation']
            if operation['state'] != 'succeeded' or operation['id'] != args.get('operation_id') or operations.get(operation['id'], {}).get('state') != 'succeeded':
                continue
            for output in value['outputs']:
                result = output['data'].get('result')
                if not isinstance(result, dict):
                    continue
                command = json.loads(operations[operation['id']]['input_json'])
                if command.get('action') == 'assay' and result.get('id') == 'assay:' + operation['id']:
                    reads.append((index, result['id']))
                elif command.get('action') == 'analyze' and result.get('taskId') == command.get('taskId') and result.get('assayIds') == command.get('assayIds'):
                    reads.extend((index, identifier) for identifier in result['assayIds'])
        result_reads[role] = reads

    reference_evidence = []
    for task in state['tasks']:
        if 'referenceTaskId' not in task:
            continue
        target_role = 'lead' if mode == 'single-agent' else 'chamber-' + task['chamber']
        source_role = 'chamber-' + tasks[task['referenceTaskId']]['chamber']
        reference_ids = {assay['id'] for assay in state['assays'] if assay['taskId'] == task['referenceTaskId']}
        assignment = next((item for item in assignments if json.loads(item['spec'])['id'] == task['id']), None)
        candidates = [operation for operation in operations.values() if operation['state'] == 'succeeded'
                      and json.loads(operation['input_json']).get('action') == 'analyze'
                      and json.loads(operation['input_json']).get('taskId') == task['id']
                      and (not assignment or not assignment['result'] or operation['id'] == assignment['result'])]
        evidence = {'taskId': task['id'], 'referenceTaskId': task['referenceTaskId'], 'analysisCompleted': bool(candidates),
                    'referenceInputObserved': False, 'peerMessageBeforeAnalysis': False,
                    'routerMessageBeforeAnalysis': False, 'sharedResultReadBeforeAnalysis': False}
        rows = native_sessions.get(target_role, [])
        for operation in candidates:
            command = json.loads(operation['input_json'])
            cited = set(command['assayIds']) & reference_ids
            for index, event in enumerate(rows):
                if event.get('type') != 'assistant/message' or event['data'].get('interrupted'):
                    continue
                for call in event['data']['message']['content']:
                    if call.get('type') != 'tool-call' or call.get('name') != 'greenhouse_analyze':
                        continue
                    try:
                        args = json.loads(call['arguments'])
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(args, dict) or args.get('requestKey') != operation['request_key'] or args.get('taskId') != task['id'] or args.get('assayIds') != command['assayIds']:
                        continue
                    evidence['sharedResultReadBeforeAnalysis'] |= any(position < index and identifier in cited for position, identifier in result_reads.get(target_role, []))
                    for message in board['messages']:
                        if message['to'] != target_role or message['from'] not in registrations or not authentic_message(message) or not any(identifier in message['content'] for identifier in cited):
                            continue
                        position = native_mail_position(message)
                        if position is not None and position < index:
                            evidence['routerMessageBeforeAnalysis'] = True
                            evidence['peerMessageBeforeAnalysis'] |= message['from'] == source_role
        evidence['referenceInputObserved'] = evidence['routerMessageBeforeAnalysis'] or evidence['sharedResultReadBeforeAnalysis']
        reference_evidence.append(evidence)
    check('reference_evidence_used_in_actual_analysis', all(item['referenceInputObserved'] for item in reference_evidence))
    return {'success': all(item['passed'] for item in checks), 'scope': 'current-team-snapshot', 'mode': mode,
            'modelSources': sources, 'scientificQuality': 'not-assessed', 'architectureAdvantage': 'not-assessed',
            'tick': state['tick'], 'tasks': len(tasks), 'completedTasks': len(state['completedTasks']),
            'operations': len(operations), 'messages': len(board['messages']), 'modelRequests': len(requests),
            'explicitMailboxReads': {'read': sum(bool(message['read']) for message in board['messages']), 'total': len(board['messages'])},
            'referenceEvidence': reference_evidence,
            'directPeerReferenceBeforeEveryAnalysis': (all(item['peerMessageBeforeAnalysis'] for item in reference_evidence) if mode == 'multi-agent' else None),
            'operatingMetrics': state['metrics'], 'checks': checks}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=pathlib.Path)
    parser.add_argument('--sessions', type=pathlib.Path, help='Explicit session root for native test compositions')
    parser.add_argument('--offline', action='store_true', help='Assert the host has stopped and its databases are checkpointed; never use on a live run')
    args = parser.parse_args()
    try:
        result = verify(args.directory, args.sessions, args.offline)
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error) as error:
        result = {'success': False, 'scope': 'current-team-snapshot', 'error': str(error)}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result['success'] else 1)


if __name__ == '__main__':
    main()
