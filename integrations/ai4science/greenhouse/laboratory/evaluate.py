"""Independently verify laboratory deliveries, native reads, device identities and immutable outputs."""
import argparse
from contextlib import closing
import hashlib
import json
import pathlib
import sqlite3
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from verify import read_database
from observations import resource_observation, incoming
from continuity import observe_continuity
from outcomes import classify


def evaluate(directory, sessions=None, offline=False):
    directory = pathlib.Path(directory).resolve()
    sessions = pathlib.Path(sessions).resolve() if sessions else directory / 'sessions'
    with closing(read_database(directory / 'device' / 'laboratory.sqlite', offline)) as db:
        db.execute('BEGIN')
        scenario_text, state_text = db.execute('SELECT config,state FROM world WHERE id=1').fetchone()
        scenario, state = json.loads(scenario_text), json.loads(state_text)
        device_events = [{'seq': seq, 'tick': tick, 'kind': kind, 'payload': json.loads(payload)} for seq, tick, kind, payload in db.execute('SELECT seq,tick,kind,payload FROM events ORDER BY seq')]
    with closing(read_database(directory / 'execution' / 'execution.sqlite', offline)) as db:
        db.row_factory = sqlite3.Row
        db.execute('BEGIN')
        operations = {row['id']: dict(row) for row in db.execute('SELECT * FROM operations')}
        artifacts = [dict(row) for row in db.execute('SELECT * FROM artifacts')]
        facts = [json.loads(row[0]) for row in db.execute("SELECT data_json FROM events WHERE type='fact' ORDER BY seq")]
    board = json.loads((directory / 'router' / 'board.json').read_text())
    checks = []

    def check(name, passed):
        checks.append({'name': name, 'passed': bool(passed)})

    configs = [fact['data'] for fact in facts if fact['kind'] == 'laboratory-run-config']
    config = configs[-1] if configs else {}
    mode = config.get('mode')
    members = {fact['data']['name']: fact['data'] for fact in facts if fact['kind'] == 'laboratory-member-registered'}
    expected = {'lead'} if mode == 'single-agent' else {'lead', 'facilities', 'experiments', 'quality'}
    check('declared_native_roles', mode in ['single-agent', 'multi-agent'] and set(members) == expected)
    native, parent_links = {}, bool(members.get('lead'))
    for role, member in members.items():
        paths = list(sessions.glob(f'**/{member["id"]}/session.v*.jsonl'))
        if not paths:
            parent_links = False
            continue
        path = max(paths, key=lambda value: int(value.stem.split('.v')[-1]))
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        native[role] = rows
        parent_links &= rows[0].get('id') == member['id'] and rows[0].get('parentSession') == (None if role == 'lead' else members['lead']['id'])
    check('native_parent_links', parent_links)
    requests = [fact['data'] for fact in facts if fact['kind'] == 'laboratory-model-request']
    installation_path = directory / 'installation.json'
    installed_sources = config.get('source') == 'scripted'
    if installation_path.exists():
        installation = json.loads(installation_path.read_text())
        snapshots = installation.get('sourceHashes', {})
        installed_sources = bool(snapshots) and installation.get('modelSource') == config.get('source')
        for name, digest in snapshots.items():
            path = (directory / 'source-snapshot' / name).resolve()
            if not path.is_relative_to((directory / 'source-snapshot').resolve()):
                installed_sources = False
                continue
            installed_sources &= path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == digest
    check('installed_source_records_or_explicit_script_fixture', installed_sources)
    check('scenario_hash_matches_native_run_configuration', hashlib.sha256(scenario_text.encode()).hexdigest() == config.get('scenarioHash'))
    check('one_declared_model_source', bool(requests) and {request['source'] for request in requests} == {config.get('source')})
    check('real_model_or_explicit_script', config.get('source') == 'scripted' or config.get('source') == 'real-model' and
          all(request['model'] == 'intern-s2' and request['provider'] in config.get('providerPool', []) for request in requests))
    physical = {operation['id']: operation for operation in state['operations']}
    operator_submissions = sum(operation['actor_id'] == 'laboratory-operator' for operation in operations.values())
    check('no_operator_device_submissions', operator_submissions == 0)
    check('engine_device_identity_and_outcomes', set(operations) == set(physical) and all(
        operation['project_id'] == physical[id]['projectId'] and json.loads(operation['input_json']) == physical[id]['command'] and
        operation['state'] == physical[id]['state'] for id, operation in operations.items()))
    measurements = {result['id']: result for result in state['results']}
    verified_measurements, artifacts_valid = {}, True
    for artifact in artifacts:
        path = (directory / 'execution' / artifact['path']).resolve()
        if not path.is_relative_to((directory / 'execution' / 'artifacts').resolve()):
            artifacts_valid = False
            continue
        data = path.read_bytes()
        if len(data) != artifact['bytes'] or hashlib.sha256(data).hexdigest() != artifact['sha256']:
            artifacts_valid = False
            continue
        output = json.loads(data)
        if output.get('operation') != physical.get(artifact['operation_id']):
            artifacts_valid = False
            continue
        results = output.get('results', [output['result']] if output.get('result') else [])
        for result in results:
            if result != measurements.get(result['id']):
                artifacts_valid = False
            else:
                verified_measurements[result['id']] = result
    check('immutable_artifact_hashes_and_measurements', artifacts_valid and set(measurements) <= set(verified_measurements) and all(any(artifact['operation_id'] == id for artifact in artifacts) for id, operation in physical.items() if operation['state'] == 'succeeded'))
    samples = {sample['id']: sample for sample in state['samples']}
    lineage_valid = True
    for result in measurements.values():
        current, ancestry = samples.get(result['sampleId']), set()
        while current:
            if current['id'] in ancestry:
                lineage_valid = False
                break
            ancestry.add(current['id'])
            if not current.get('parentId'):
                lineage_valid &= current['id'] == result['rootSampleId']
                break
            current = samples.get(current['parentId'])
        output = samples.get(result.get('outputSampleId', 'sample:' + result['operationId']))
        lineage_valid &= bool(current and output and output.get('parentId') == result['sampleId'])
    check('measurement_sample_lineage', lineage_valid)
    tasks = {task['id']: task for task in state['tasks']}
    valid_deliveries = {delivery['taskId']: delivery for delivery in state['deliveries'] if delivery['valid']}
    check('all_declared_tasks_validly_delivered', bool(tasks) and set(tasks) == set(valid_deliveries) and
          all(task['releaseTick'] <= state['tick'] for task in tasks.values()))
    check('all_declared_exceptions_observed', set(state['appliedFaults']) == {fault['id'] for fault in scenario['faults']} and
          set(state['appliedRevisions']) == {revision['id'] for revision in scenario['revisions']})
    revoked = {revocation['resultId'] for revocation in state['revocations']}
    evidence_valid = True
    for task_id, delivery in valid_deliveries.items():
        task, roots = tasks[task_id], set()
        references = delivery.get('referenceResultIds', [])
        if scenario.get('externalReferences') or references:
            expected_references = {id for prerequisite_id in task['prerequisites'] if tasks[prerequisite_id]['projectId'] != task['projectId']
                for id in valid_deliveries.get(prerequisite_id, {}).get('resultIds', [])}
            evidence_valid &= len(references) == len(set(references)) and set(references) == expected_references and not set(references) & revoked
        for result_id in delivery['resultIds']:
            result = verified_measurements.get(result_id)
            if not result or result_id in revoked or result['methodId'] != task['methodId'] or result['methodVersion'] != task['methodVersion'] or result['rootSampleId'] not in task['rootSampleIds']:
                evidence_valid = False
                continue
            roots.add(result['rootSampleId'])
            for prerequisite_id in task['prerequisites']:
                prerequisite = valid_deliveries.get(prerequisite_id)
                if not prerequisite or prerequisite['tick'] > delivery['tick']:
                    evidence_valid = False
                    continue
                if tasks[prerequisite_id]['projectId'] != task['projectId']:
                    continue
                ancestry, current = set(), samples[result['sampleId']]
                while current and current['id'] not in ancestry:
                    ancestry.add(current['id'])
                    current = samples.get(current.get('parentId'))
                evidence_valid &= any(measurements[id].get('outputSampleId', 'sample:' + measurements[id]['operationId']) in ancestry for id in prerequisite['resultIds'])
        evidence_valid &= len(roots) >= task['requiredResults'] and len(set(delivery['resultIds'])) == len(delivery['resultIds'])
    check('current_method_distinct_roots_and_prerequisite_evidence', evidence_valid)
    actual_deliveries = set()
    for role, rows in native.items():
        calls, read_ids = {}, set()
        for event in rows:
            data = event.get('data', {})
            if event.get('type') == 'tool/call':
                try:
                    calls[data['callId']] = (data['name'], json.loads(data['arguments']))
                except (ValueError, TypeError):
                    continue
            if event.get('type') != 'tool/result':
                continue
            message = data['message']
            if message.get('isError') or message['toolCallId'] not in calls:
                continue
            name, args = calls[message['toolCallId']]
            value = json.loads(''.join(block['text'] for block in message['content'] if block['type'] == 'text'))
            if name == 'laboratory_result' and value['operation']['state'] == 'succeeded' and value['operation']['id'] == args['operation_id']:
                for output in value['outputs']:
                    results = output['data'].get('results', [])
                    for result in results:
                        if result == verified_measurements.get(result['id']):
                            read_ids.add(result['id'])
            if name == 'laboratory_deliver' and value.get('valid') and set(args['result_ids'] + args.get('reference_result_ids', [])) <= read_ids:
                if args.get('reference_result_ids', []) == value.get('referenceResultIds', []):
                    actual_deliveries.add((value['taskId'], tuple(value['resultIds']), tuple(value.get('referenceResultIds', [])), value['tick']))
    check('verified_reads_precede_actual_native_deliveries', all(
        (delivery['taskId'], tuple(delivery['resultIds']), tuple(delivery.get('referenceResultIds', [])), delivery['tick']) in actual_deliveries for delivery in valid_deliveries.values()))
    assignment_valid = {assignment['title'] for assignment in board['tasks']} == set(tasks)
    for assignment in board['tasks']:
        try:
            delivery = json.loads(assignment['result'])
            assignment_valid &= assignment['status'] == 'done' and delivery == valid_deliveries.get(assignment['title'])
        except (ValueError, TypeError):
            assignment_valid = False
    check('router_assignments_match_valid_deliveries', assignment_valid)
    router_valid = True
    for assignment in board['tasks']:
        spec = json.loads(assignment['spec'])
        router_valid &= assignment['title'] in tasks and spec.get('id') == assignment['title'] and assignment['assignee'] in members
        if assignment['status'] == 'done':
            try:
                router_valid &= json.loads(assignment['result']) == valid_deliveries.get(assignment['title'])
            except (ValueError, TypeError):
                router_valid = False
    check('router_records_match_released_task_evidence', router_valid)

    written = {fact['data']['messageId']: fact['data'] for fact in facts if fact['kind'] == 'laboratory-mail-written'}
    accepted = {fact['data']['messageId']: fact['data'] for fact in facts if fact['kind'] == 'laboratory-mail-delivered'}
    mail_valid = True
    for message in board['messages']:
        envelope = written.get(message['id'], {})
        mail_valid &= accepted.get(message['id'], {}).get('status') == 'accepted' and all(envelope.get(key) == message[field] for key, field in [
            ('from', 'from'), ('to', 'to'), ('taskId', 'task_id'), ('content', 'content')])
        entered = False
        for row in native.get(message['to'], []):
            if row.get('type') != 'user/message':
                continue
            for block in row['data'].get('content', []):
                if block.get('type') == 'text':
                    try:
                        value = json.loads(block['text'])
                    except ValueError:
                        continue
                    entered |= isinstance(value, dict) and value.get('messageId') == message['id'] and value.get('content') == message['content']
        mail_valid &= entered
    check('router_mail_has_native_input_and_delivery_receipts', mail_valid)
    completion_receipts = []
    for assignment in board['tasks']:
        if assignment['status'] != 'done' or assignment['assignee'] == assignment['created_by']:
            continue
        delivery = valid_deliveries.get(assignment['title'])
        matched = False
        for message in board['messages']:
            if message.get('task_id') != assignment['id'] or message['from'] != assignment['assignee'] or message['to'] != assignment['created_by']:
                continue
            try:
                content = json.loads(message['content'])
            except ValueError:
                continue
            if not isinstance(content, dict) or content.get('kind') != 'laboratory-delivery' or content.get('delivery') != delivery:
                continue
            owner = native.get(assignment['created_by'], [])
            received = incoming(owner, message, 'laboratory-mail')
            response = next((event for event in owner if received and event.get('seq', -1) > received['seq'] and
                event.get('type') == 'assistant/message' and not event['data'].get('interrupted')), None)
            matched |= bool(received and response and accepted.get(message['id'], {}).get('status') == 'accepted')
        completion_receipts.append(matched)
    check('latest_completion_notices_reached_owner_response', all(completion_receipts))

    expected_volumes = {sample['id']: sample['volumeUl'] for sample in scenario['samples']}
    for operation in physical.values():
        command = operation['command']
        if command['action'] not in ['process', 'aliquot']:
            continue
        inputs = [command['sampleId']] + command.get('additionalSampleIds', [])
        if operation['consumedUl']:
            for sample_id in inputs:
                expected_volumes[sample_id] = expected_volumes.get(sample_id, 0) - command['volumeUl']
        if operation['state'] == 'succeeded':
            for index, sample_id in enumerate(operation.get('outputSampleIds', [operation['outputSampleId']])):
                expected_volumes[sample_id] = expected_volumes.get(sample_id, 0) + command['volumeUl']
    check('all_sample_deductions_match_stage_effects', set(expected_volumes) == set(samples) and
          all(samples[id]['volumeUl'] == volume for id, volume in expected_volumes.items()))
    expected_stock = {batch['id']: batch['units'] for batch in scenario['batches']}
    for shipment in state['shipments']:
        if shipment['delivered']:
            expected_stock[shipment['id']] = shipment['units']
    for operation in physical.values():
        for selected in operation['consumedBatches']:
            expected_stock[selected['batchId']] = expected_stock.get(selected['batchId'], 0) - selected['units']
    check('supply_stock_matches_deliveries_and_consumption', expected_stock == {batch['id']: batch['units'] for batch in state['batches']})
    expected_water = scenario['facilities']['initialWaterUl'] + sum(operation['command']['volumeUl'] for operation in physical.values()
        if operation['state'] == 'succeeded' and operation['command']['action'] == 'refill') - sum(operation['consumedWaterUl'] for operation in physical.values())
    check('water_stock_matches_refills_and_committed_use', expected_water == state['facilities']['waterUl'])
    intervals, overlapping = {}, False
    for operation in physical.values():
        start, end = operation['acceptedTick'], operation.get('completedTick', state['tick'])
        if end <= start:
            continue
        command = operation['command']
        resources = ['device:' + command['deviceId']]
        if 'sampleId' in command:
            resources += ['sample:' + id for id in [command['sampleId']] + command.get('additionalSampleIds', [])]
        for resource in resources:
            overlapping |= any(start < finish and begin < end for begin, finish in intervals.get(resource, []))
            intervals.setdefault(resource, []).append((start, end))
    resources = resource_observation({'tick': state['tick'], 'jobs': [
        {'startedTick': operation['acceptedTick'], 'completedTick': operation.get('completedTick', state['tick']),
         'resources': ['laboratory:device:' + operation['command']['deviceId']] +
            ['laboratory:sample:' + sample_id for sample_id in ([operation['command']['sampleId']] + operation['command'].get('additionalSampleIds', []) if 'sampleId' in operation['command'] else [])]}
        for operation in physical.values()]})
    effects = {}
    for result in measurements.values():
        identity = (result['rootSampleId'], result['methodId'], result['methodVersion'])
        effects[identity] = effects.get(identity, 0) + 1
    action_names = {'laboratory_' + action for action in ['process', 'aliquot', 'transfer', 'clean', 'calibrate', 'repair', 'configure', 'refill', 'order']}
    attempted, corrected, invalid_arguments = {}, {}, 0
    for role, rows in native.items():
        for event in rows:
            if event.get('type') != 'tool/call' or event['data']['name'] not in action_names:
                continue
            try:
                args = json.loads(event['data']['arguments'])
            except ValueError:
                invalid_arguments += 1
                continue
            if not isinstance(args, dict):
                invalid_arguments += 1
                continue
            key = (role, event['data']['name'], json.dumps(args, sort_keys=True))
            attempted[key] = attempted.get(key, 0) + 1
            corrected.setdefault((role, args.get('project_id'), args.get('requestKey')), set()).add(key[2])
    repeats = {'additionalSameRootMethodVersionMeasurements': sum(max(0, count - 1) for count in effects.values()),
               'identicalActionToolCallRepeats': sum(max(0, count - 1) for count in attempted.values()),
               'requestKeysUsedWithDifferentArguments': sum(len(values) > 1 for values in corrected.values()),
               'invalidJsonToolArguments': invalid_arguments}
    check('exclusive_devices_and_samples_do_not_overlap', not overlapping)
    usage = {}
    for fact in facts:
        if fact['kind'] == 'laboratory-model-request':
            route = usage.setdefault(fact['data']['provider'], {'requests': 0, 'inputTokens': 0, 'outputTokens': 0})
            route['requests'] += 1
        if fact['kind'] == 'laboratory-model-usage':
            data = fact['data']
            route = usage.setdefault(data['provider'], {'requests': 0, 'inputTokens': 0, 'outputTokens': 0})
            route['inputTokens'] += data['inputTokens'] + data.get('cacheReadTokens', 0) + data.get('cacheWriteTokens', 0)
            route['outputTokens'] += data['outputTokens']
    compactions = {role: {kind: sum(row.get('type') == 'compaction/' + kind for row in rows) for kind in ['start', 'summary', 'end']} for role, rows in native.items()}
    authentic_mail = [message for message in board['messages'] if accepted.get(message['id'], {}).get('status') == 'accepted' and all(
        written.get(message['id'], {}).get(key) == message[field] for key, field in [
            ('from', 'from'), ('to', 'to'), ('taskId', 'task_id'), ('content', 'content')])]
    continuity = observe_continuity(native, board, state, verified_measurements, authentic_mail)
    check('no_negative_physical_stock', all(sample['volumeUl'] >= 0 for sample in samples.values()) and all(batch['units'] >= 0 for batch in state['batches']) and state['facilities']['waterUl'] >= 0)
    evaluator_sources = [pathlib.Path(__file__), pathlib.Path(__file__).with_name('continuity.py'), pathlib.Path(__file__).with_name('outcomes.py'), pathlib.Path(__file__).resolve().parent.parent / 'observations.py', pathlib.Path(__file__).resolve().parent.parent / 'verify.py']
    outcome = classify(scenario, state, verified_measurements)
    outcome_checks = {'all_declared_tasks_validly_delivered', 'router_assignments_match_valid_deliveries', 'no_operator_device_submissions'}
    operator_ids = {id for id, operation in operations.items() if operation['actor_id'] == 'laboratory-operator'}
    operator_events = [event for event in device_events if event['kind'] in ['operation-accepted', 'operation-refused'] and event['payload'].get('id') in operator_ids]
    check('operator_interventions_have_device_event_boundaries', all(
        len([event for event in operator_events if event['payload']['id'] == id]) == 1 and all(
            event['payload'].get('projectId') == operation['project_id'] and event['payload'].get('command') == json.loads(operation['input_json'])
            for event in operator_events if event['payload']['id'] == id)
        for id, operation in operations.items() if id in operator_ids))
    evidence_valid = all(check['passed'] for check in checks if check['name'] not in outcome_checks)
    first_intervention = next(iter(operator_events), None)
    autonomous_delivered = set()
    if first_intervention:
        for event in device_events:
            if event['seq'] >= first_intervention['seq']:
                break
            if event['kind'] == 'task-delivered':
                autonomous_delivered.add(event['payload']['taskId'])
            if event['kind'] == 'deliveries-withdrawn':
                autonomous_delivered.difference_update(event['payload']['taskIds'])
    else:
        autonomous_delivered = set(valid_deliveries)
    denominator = len(tasks)
    completion_rate = len(valid_deliveries) / denominator if denominator else None
    assistance = {'used': bool(operator_ids), 'interventionCount': len(operator_ids), 'countingUnit': 'one accepted operator execution action', 'operatorOperationIds': sorted(operator_ids),
        'firstInterventionDeviceSeq': first_intervention['seq'] if first_intervention else None,
        'firstInterventionTick': first_intervention['tick'] if first_intervention else None,
        'autonomousPhaseClosed': bool(first_intervention), 'autonomousValidDeliveries': len(autonomous_delivered),
        'autonomousTaskIds': sorted(autonomous_delivered), 'declaredTasks': denominator,
        'releasedTasksAtBoundary': sum(task['releaseTick'] <= (first_intervention['tick'] if first_intervention else state['tick']) for task in tasks.values()),
        'autonomousCompletionRate': len(autonomous_delivered) / denominator if denominator else None,
        'completionRateAfterAssistance': completion_rate if first_intervention else None}
    released_at_boundary = assistance['releasedTasksAtBoundary']
    assistance['autonomousReleasedCompletionRate'] = len(autonomous_delivered) / released_at_boundary if released_at_boundary else None
    workflow_completed = all(check['passed'] for check in checks if check['name'] != 'no_operator_device_submissions')
    return {'completionRate': completion_rate, 'workflowCompleted': workflow_completed, 'assistance': assistance, 'evidenceValid': evidence_valid, 'outcome': outcome, 'evaluatorSourceHashes': {str(path.relative_to(pathlib.Path(__file__).resolve().parent.parent)): hashlib.sha256(path.read_bytes()).hexdigest() for path in evaluator_sources},
            'success': all(check['passed'] for check in checks), 'scope': 'current-laboratory-team-snapshot', 'mode': mode, 'model': config.get('model'),
            'source': config.get('source'), 'scientificQuality': 'not-assessed', 'architectureAdvantage': 'not-assessed',
            'timeReference': 'simulation-ticks-and-native-session-sequence', 'tick': state['tick'], 'tasks': len(tasks),
            'validDeliveries': len(valid_deliveries), 'operations': len(operations), 'measurements': len(measurements),
            'messages': len(board['messages']), 'operatorSubmittedOperations': operator_submissions, 'perRoute': usage, 'compactionEventsByRole': compactions,
            'taskLatencyTicks': {id: delivery['tick'] - tasks[id]['releaseTick'] for id, delivery in valid_deliveries.items()},
            'allTaskCompletionTick': max((delivery['tick'] for delivery in valid_deliveries.values()), default=None) if set(valid_deliveries) == set(tasks) else None,
            'resources': resources, 'repeats': repeats, 'compactionContinuity': continuity, 'operatingMetrics': state['facilityMetrics'], 'checks': checks}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=pathlib.Path)
    parser.add_argument('--sessions', type=pathlib.Path)
    parser.add_argument('--offline', action='store_true', help='Assert a stopped host and checkpointed databases')
    args = parser.parse_args()
    try:
        result = evaluate(args.directory, args.sessions, args.offline)
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error) as error:
        result = {'success': False, 'scope': 'current-laboratory-team-snapshot', 'error': str(error)}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result['success'] else 1)


if __name__ == '__main__':
    main()
