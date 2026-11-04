"""Describe matched single/multi-Agent records without scoring scientific claims or assuming an advantage."""
import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime
import hashlib
import json
import pathlib
from verify import read_database, verify


def collect(directory, offline=False, sessions=None):
    directory = pathlib.Path(directory).resolve()
    verification = verify(directory, sessions=sessions, offline=offline)
    with closing(read_database(directory / 'device/greenhouse.sqlite', offline)) as db:
        config, state = db.execute('SELECT config,state FROM world WHERE id=1').fetchone()
        scenario, state = json.loads(config), json.loads(state)
    with closing(read_database(directory / 'execution/execution.sqlite', offline)) as db:
        facts = [json.loads(row[0]) for row in db.execute("SELECT data_json FROM events WHERE type='fact' ORDER BY seq")]
        interventions = db.execute("SELECT count(*) FROM operations WHERE actor_id='greenhouse-operator'").fetchone()[0]
        started_at, last_record_at = db.execute('SELECT min(at),max(at) FROM events').fetchone()
        analyses = [(json.loads(command), at) for command, at in db.execute("SELECT input_json,updated_at FROM operations WHERE state='succeeded'")]
    configurations = [fact['data'] for fact in facts if fact['kind'] == 'greenhouse-run-config']
    if not configurations:
        raise ValueError('Run lacks a recorded model/scenario configuration; preserve it as legacy evidence, start a fresh comparison run')
    run = configurations[-1]
    per_route = {}
    legacy_usage = any(fact['kind'] == 'greenhouse-model-usage' and 'provider' not in fact['data'] for fact in facts)
    def usage_into(route, usage):
        totals = per_route.setdefault(route, {'requests': 0, 'inputTokens': 0, 'outputTokens': 0})
        totals['inputTokens'] += usage['inputTokens'] + usage.get('cacheReadTokens', 0) + usage.get('cacheWriteTokens', 0)
        totals['outputTokens'] += usage['outputTokens']
    for fact in facts:
        if fact['kind'] not in ['greenhouse-model-request', 'greenhouse-model-usage']:
            continue
        if legacy_usage and fact['kind'] == 'greenhouse-model-usage':
            continue
        data = fact['data']
        route = data.get('provider', 'unattributed-legacy-usage')
        totals = per_route.setdefault(route, {'requests': 0, 'inputTokens': 0, 'outputTokens': 0})
        if fact['kind'] == 'greenhouse-model-request':
            totals['requests'] += 1
        else:
            usage_into(route, data)
    released = {task['id']: 0 for task in scenario['tasks']}
    released.update({event['task']['id']: event['tick'] for event in scenario['events'] if event['kind'] == 'task'})
    completed = {}
    for job in state['jobs']:
        if job['state'] == 'succeeded' and job['command']['action'] == 'analyze':
            task = job['command']['taskId']
            completed[task] = min(completed.get(task, job['completedTick']), job['completedTick'])
    session_events = []
    shared_tools = {}
    tool_conflicts = set()
    for path in (pathlib.Path(sessions) if sessions else directory / 'sessions').glob('**/session.v4.jsonl'):
        current_provider = run['model']['provider']
        with path.open() as handle:
            for line in handle:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    # A live writer may have one unfinished trailing line; it contributes no evidence.
                    if line.endswith('\n') or handle.read():
                        raise
                    continue
                session_events.append(event)
                data = event.get('data', {})
                if event.get('type') == 'request/header':
                    current_provider = data['header']['config']['provider']
                    for tool in data['header']['tools']:
                        if not tool['name'].startswith(('greenhouse_', 'lab_')):
                            continue
                        previous = shared_tools.get(tool['name'])
                        if previous is not None and previous != tool:
                            tool_conflicts.add(tool['name'])
                        shared_tools[tool['name']] = tool
                if not legacy_usage:
                    continue
                if event.get('type') in ['assistant/message', 'compaction/summary'] and data.get('usage'):
                    provider = data.get('provider') or data.get('message', {}).get('source', {}).get('provider') or current_provider
                    usage_into(provider, data['usage'])
                if event.get('type') == 'assistant/attempt':
                    usages = [item['chunk']['usage'] for item in data.get('stream', []) if item['type'] == 'chunk' and item['chunk']['type'] == 'usage']
                    if usages:
                        usage_into(current_provider, usages[-1])
    compaction = Counter(event['type'] for event in session_events if event.get('type', '').startswith('compaction/'))
    retries = sum(event.get('type') == 'llm/retry-started' for event in session_events)
    shared_tool_hash = hashlib.sha256(json.dumps(sorted(shared_tools.values(), key=lambda tool: tool['name']), sort_keys=True).encode()).hexdigest() if shared_tools and not tool_conflicts else None
    def seconds_since_start(at):
        return round((datetime.fromisoformat(at.replace('Z', '+00:00')) - datetime.fromisoformat(started_at.replace('Z', '+00:00'))).total_seconds(), 3)
    analysis_times = {}
    for command, at in analyses:
        if command['action'] == 'analyze':
            analysis_times[command['taskId']] = min(analysis_times.get(command['taskId'], at), at)
    analysis_at = max(analysis_times.values()) if len(analysis_times) == len(released) else None
    installation_path = directory / 'installation.json'
    installation = json.loads(installation_path.read_text()) if installation_path.exists() else None
    stop_path = directory / 'baseline-stop.json'
    owner_stop = json.loads(stop_path.read_text()) if stop_path.exists() else None
    audits = [json.loads(path.read_text()) for path in directory.glob('network-audit-*.json')]
    transport = installation.get('transportPolicy') if installation else None
    network_verified = bool(transport) and bool(audits) and any(audit['status'] == 'verified' for audit in audits) and all(
        audit['transportPolicy'] == transport and audit['status'] in ['verified', 'no-model-socket'] for audit in audits)
    return {'directory': str(directory), 'mode': run['mode'], 'source': run['source'], 'model': run['model'],
            'providerPool': run.get('providerPool', [run['model']['provider']]),
            'scenarioHash': hashlib.sha256(config.encode()).hexdigest(), 'tickMs': scenario['tickMs'],
            'sharedToolHash': shared_tool_hash, 'installation': installation,
            'sharedToolDeclarationConflicts': sorted(tool_conflicts),
            'networkAudit': {'verified': network_verified, 'observations': audits},
            'wallClock': {'startedAt': started_at, 'lastExecutionRecordAt': last_record_at,
                          'activitySpanSeconds': seconds_since_start(last_record_at),
                          'analysisCompleteAt': analysis_at, 'analysisLatencySeconds': seconds_since_start(analysis_at) if analysis_at else None},
            'verification': verification, 'perRoute': per_route, 'actualRequestRetries': retries,
            'usageSource': 'native-session-events' if legacy_usage else 'execution-usage-facts',
            'ownerStop': owner_stop,
            'operatorSubmittedOperations': interventions,
            'taskCompletionTick': completed,
            'taskLatencyTicks': {task: tick - released[task] for task, tick in completed.items()},
            'allTaskCompletionTick': max(completed.values()) if len(completed) == len(released) else None,
            'compactionEvents': dict(compaction),
            'failedCompactions': sum(event['type'] == 'compaction/end' and 'error' in event['data'] for event in session_events if event.get('type') == 'compaction/end'),
            'usageLimit': 'Provider-reported usage only; failed requests may consume tokens without returning usage.'}


def compare(single, multi):
    matching = {
        'one_single_and_one_multi': single['mode'] == 'single-agent' and multi['mode'] == 'multi-agent',
        'identical_scenario_and_clock': single['scenarioHash'] == multi['scenarioHash'],
        'identical_model_settings': single['model'] == multi['model'],
        'identical_provider_pool': single['providerPool'] == multi['providerPool'],
        'identical_shared_tool_declarations': bool(single['sharedToolHash']) and single['sharedToolHash'] == multi['sharedToolHash'],
        'recorded_source_and_model_policies': bool(single['installation']) and bool(multi['installation']),
        'identical_recorded_sources': bool(single['installation']) and bool(multi['installation']) and single['installation']['sourceHashes'] == multi['installation']['sourceHashes'],
        'identical_recorded_model_policies': bool(single['installation']) and bool(multi['installation']) and single['installation']['modelPolicy'] == multi['installation']['modelPolicy'],
        'identical_recorded_transport_policies': bool(single['installation']) and bool(multi['installation']) and single['installation'].get('transportPolicy') == multi['installation'].get('transportPolicy'),
        'direct_model_interfaces_observed': single['networkAudit']['verified'] and multi['networkAudit']['verified'],
        'both_real_model': single['source'] == multi['source'] == 'real-model',
        'both_independently_verified': single['verification']['success'] and multi['verification']['success'],
        'no_operator_device_submissions': single['operatorSubmittedOperations'] == multi['operatorSubmittedOperations'] == 0,
    }
    return {'scope': 'descriptive-pair', 'comparisonReady': all(matching.values()), 'matchingChecks': matching,
            'single': single, 'multi': multi, 'scientificQuality': 'not-assessed', 'architectureAdvantage': 'not-assessed',
            'interpretation': 'A pair describes these runs only. Repeat matched trials, inspect failures and compare completion, latency, care and compaction recovery; token totals are measurements, not budgets.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--single', type=pathlib.Path, required=True)
    parser.add_argument('--multi', type=pathlib.Path, required=True)
    parser.add_argument('--offline', action='store_true', help='Assert both hosts are stopped and checkpointed')
    parser.add_argument('--single-offline', action='store_true', help='Assert only the single-Agent host is stopped and checkpointed')
    parser.add_argument('--multi-offline', action='store_true', help='Assert only the multi-Agent host is stopped and checkpointed')
    parser.add_argument('--output', type=pathlib.Path)
    args = parser.parse_args()
    report = compare(collect(args.single, args.offline or args.single_offline), collect(args.multi, args.offline or args.multi_offline))
    text = json.dumps(report, indent=2, ensure_ascii=False) + '\n'
    if args.output:
        with args.output.open('x') as handle:
            handle.write(text)
    print(text)
    raise SystemExit(0 if report['comparisonReady'] else 1)


if __name__ == '__main__':
    main()
