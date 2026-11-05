"""Create an immutable descriptive laboratory comparison from independently evaluated native runs."""
import argparse
import hashlib
import json
import pathlib
from evaluate import evaluate


def model_policy_verified(record):
    policies = record.get('modelPolicy', [])
    providers = next((policy['providers'] for policy in policies if 'providers' in policy), {})
    compression = next((policy for policy in policies if 'thresholdRatio' in policy), {})
    return bool(providers) and all(any(model.get('id') == 'intern-s2' and model.get('contextWindow') == 256000
        for model in provider.get('models', [])) for provider in providers.values()) and compression.get('auto') is True and compression.get('thresholdRatio') == 0.8


def direct_interface_verified(path, record):
    policy = record.get('transportPolicy')
    if not policy:
        return False
    for file in path.glob('network-audit-*.json'):
        audit = json.loads(file.read_text())
        if audit.get('status') == 'verified' and audit.get('transportPolicy') == policy and audit.get('connections') and all(
                connection.get('interface') == policy['interface'] for connection in audit['connections']):
            return True
    return False


def compare(single, multi, offline=False):
    paths = [pathlib.Path(single).resolve(), pathlib.Path(multi).resolve()]
    runs = [evaluate(path, offline=offline) for path in paths]
    records = [json.loads((path / 'installation.json').read_text()) for path in paths]
    assistance_policies = [json.loads((path / 'assistance-protocol.json').read_text()) if (path / 'assistance-protocol.json').exists() else None for path in paths]
    terminal_policies = [json.loads((path / 'evaluation-protocol.json').read_text()) if (path / 'evaluation-protocol.json').exists() else None for path in paths]
    scenarios = [json.loads((path / 'scenario.json').read_text()) for path in paths]
    checks = {
        'identical_assistance_policy': isinstance(assistance_policies[0], dict) and assistance_policies[0] == assistance_policies[1],
        'identical_evaluator_sources': runs[0]['evaluatorSourceHashes'] == runs[1]['evaluatorSourceHashes'],
        'one_single_one_multi': [run['mode'] for run in runs] == ['single-agent', 'multi-agent'],
        'identical_scenario': scenarios[0] == scenarios[1],
        'identical_recorded_sources': bool(records[0].get('sourceHashes')) and records[0]['sourceHashes'] == records[1].get('sourceHashes'),
        'identical_model_and_compaction_policy': records[0].get('modelPolicy') == records[1].get('modelPolicy'),
        'identical_clock_policy': records[0].get('clockPolicy') == records[1].get('clockPolicy'),
        'event_driven': all(record.get('clockPolicy', {}).get('mode') == 'event-driven' for record in records),
        'identical_transport_policy': records[0].get('transportPolicy') == records[1].get('transportPolicy'),
        'both_independently_verified': all(run['evidenceValid'] and run['outcome']['terminal'] for run in runs),
        'no_operator_actions': all(run['operatorSubmittedOperations'] == 0 for run in runs),
        'identical_recorded_terminal_policy': isinstance(terminal_policies[0], dict) and terminal_policies[0] == terminal_policies[1],
        'same_outcome_protocol': all(run['outcome']['method'] == runs[0]['outcome']['method'] for run in runs),
        'cross_project_reference_rules_enabled': all(scenario.get('externalReferences') is True for scenario in scenarios),
        'both_256k_native_compression': all(model_policy_verified(record) for record in records),
        'direct_model_interfaces_observed': all(direct_interface_verified(path, record) for path, record in zip(paths, records)),
        'both_real_model': all(run['source'] == 'real-model' for run in runs),
    }
    for path, run in zip(paths, runs):
        run['directory'] = str(path)
        run['meanTaskLatencyTicks'] = sum(run['taskLatencyTicks'].values()) / len(run['taskLatencyTicks']) if run['taskLatencyTicks'] else None
    return {'scope': 'descriptive-laboratory-pair', 'comparisonReady': all(checks.values()),
            'assistedEvidenceReady': any(run['assistance']['used'] for run in runs) and all(value for name, value in checks.items() if name != 'no_operator_actions'),
            'assistancePolicy': assistance_policies[0], 'matchingChecks': checks,
            'single': runs[0], 'multi': runs[1], 'timeReference': 'simulation-ticks-and-native-session-sequence',
            'scientificQuality': 'not-assessed', 'architectureAdvantage': 'not-assessed',
            'terminalPolicy': terminal_policies[0],
            'evaluatorSha256': hashlib.sha256(pathlib.Path(__file__).with_name('evaluate.py').read_bytes()).hexdigest(),
            'interpretation': ['Logical time holds during model decisions and does not measure inference throughput.',
                               'Scripts validate native execution and evidence paths. Formal comparisons require actual production-model runs.',
                               'Resource exposure totals use each run observation horizon.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('single', type=pathlib.Path)
    parser.add_argument('multi', type=pathlib.Path)
    parser.add_argument('--offline', action='store_true', help='Both hosts must be stopped and databases checkpointed')
    parser.add_argument('--output', type=pathlib.Path)
    args = parser.parse_args()
    report = compare(args.single, args.multi, args.offline)
    serialized = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open('x') as handle:
            handle.write(serialized)
    print(serialized)


if __name__ == '__main__':
    main()
