"""Conservatively identify physical task outcomes from material lineage and current methods."""


def classify(scenario, state, verified_measurements):
    samples = {sample['id']: sample for sample in state['samples']}
    delivered = {delivery['taskId'] for delivery in state['deliveries'] if delivery['valid']}
    revoked = {revocation['resultId'] for revocation in state['revocations']}
    methods = {method['id']: method for method in state['methods']}
    method_versions = {(method['id'], method['version']): method for method in scenario.get('methods', state['methods'])}
    tasks = {task['id']: task for task in state['tasks']}
    remaining = {id: task for id, task in tasks.items() if id not in delivered}
    active = [operation['id'] for operation in state['operations'] if operation['state'] == 'running']
    events_complete = set(state['appliedFaults']) == {event['id'] for event in scenario['faults']} and set(state['appliedRevisions']) == {event['id'] for event in scenario['revisions']}

    events_complete &= all(task.get('releaseTick', 0) <= state['tick'] for task in scenario.get('tasks', state['tasks']))

    def root_of(sample):
        visited = set()
        while sample and sample.get('parentId'):
            if sample['id'] in visited:
                return None
            visited.add(sample['id'])
            sample = samples.get(sample['parentId'])
        return sample['id'] if sample else None

    def reachable(start, target):
        seen, pending = set(), [start]
        while pending:
            value = pending.pop()
            if value == target:
                return True
            if value in seen:
                continue
            seen.add(value)
            pending.extend(method['outputState'] for method in methods.values() if method['inputState'] == value)
        return False

    proofs = {}
    for id, task in remaining.items():
        possible = set()
        for result_id, result in verified_measurements.items():
            if result_id not in revoked and result['methodId'] == task['methodId'] and result['methodVersion'] == task['methodVersion'] and result['rootSampleId'] in task['rootSampleIds']:
                possible.add(result['rootSampleId'])
        method = methods[task['methodId']]
        for sample in samples.values():
            if sample['volumeUl'] <= 0 or sample['disposition'] != 'available' or sample['expiresAt'] < state['tick']:
                continue
            root = root_of(sample)
            if root in task['rootSampleIds'] and reachable(sample['state'], method['inputState']):
                possible.add(root)
        for operation in state['operations']:
            command = operation.get('command', {})
            if operation['state'] != 'running' or command.get('action') not in ['process', 'aliquot']:
                continue
            processing_method = method_versions.get((command.get('methodId'), command.get('methodVersion')))
            for sample_id in [command.get('sampleId'), *command.get('additionalSampleIds', [])]:
                sample = samples.get(sample_id)
                root = root_of(sample)
                if root not in task['rootSampleIds']:
                    continue
                same_measurement = command.get('action') == 'process' and command.get('methodId') == task['methodId'] and command.get('methodVersion') == task['methodVersion']
                output_state = processing_method['outputState'] if processing_method else sample['state'] if sample else None
                if same_measurement or output_state is not None and reachable(output_state, method['inputState']):
                    possible.add(root)
        if len(possible) < task['requiredResults']:
            proofs[id] = {'taskId': id, 'projectId': task['projectId'], 'reason': 'insufficient-recoverable-originals',
                          'requiredOriginals': task['requiredResults'], 'optimisticallyRecoverableOriginals': sorted(possible),
                          'missingOriginals': sorted(set(task['rootSampleIds']) - possible)}
    changed = True
    while changed:
        changed = False
        for id, task in remaining.items():
            blocked = [dependency for dependency in task['prerequisites'] if dependency in proofs]
            if id not in proofs and blocked:
                proofs[id] = {'taskId': id, 'projectId': task['projectId'], 'reason': 'unrecoverable-prerequisite', 'prerequisites': blocked}
                changed = True
    recoverable = sorted(set(remaining) - set(proofs))
    status = 'running'
    if events_complete and not active:
        if not remaining:
            status = 'completed'
        elif not recoverable:
            status = 'irrecoverable-material-loss'
    return {'status': status, 'terminal': status != 'running', 'allScenarioEventsApplied': events_complete,
            'activePhysicalOperations': active, 'remainingTasks': sorted(remaining), 'potentiallyRecoverableTasks': recoverable,
            'unrecoverableTasks': list(proofs.values()),
            'method': 'Optimistic material reachability ignores scheduling, containers and resource shortages. Terminal failure requires every remaining task to be impossible even under that relaxation, with no physical work or scheduled revisions remaining.'}
