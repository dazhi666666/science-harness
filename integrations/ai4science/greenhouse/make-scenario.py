"""Generate a repeated greenhouse workload; the release schedule never stops its host or Agents."""
import argparse
import copy
import json
import pathlib


def build(batches, interval, tick_ms):
    scenario = json.loads((pathlib.Path(__file__).parent / 'fixtures/baseline.scenario.json').read_text())
    scenario['tickMs'] = tick_ms
    scenario['initial']['waterLitres'] = max(100, batches * 6)
    originals = copy.deepcopy(scenario['tasks'])
    scenario['tasks'] = []
    for batch in range(batches):
        for original in originals:
            task = copy.deepcopy(original)
            task['id'] += f'-{batch + 1:02d}'
            if task.get('referenceTaskId'):
                task['referenceTaskId'] += f'-{batch + 1:02d}'
                task['instructions'] = task['instructions'].replace(original['referenceTaskId'], task['referenceTaskId'])
            if batch == 0:
                scenario['tasks'].append(task)
            else:
                scenario['events'].append({'id': 'release-' + task['id'], 'tick': batch * interval,
                                           'kind': 'task', 'task': task})
        at = batch * interval
        scenario['events'] += [
            {'id': f'power-down-{batch}', 'tick': at + interval // 3, 'kind': 'power', 'capacity': 4.5},
            {'id': f'power-up-{batch}', 'tick': at + 2 * interval // 3, 'kind': 'power', 'capacity': 9},
            {'id': f'sensor-{batch}', 'tick': at + interval // 2, 'kind': 'sensor',
             'chamber': ['A', 'B', 'C'][batch % 3], 'bias': 18 if batch % 2 == 0 else -15},
        ]
    scenario['events'].sort(key=lambda event: event['tick'])
    return scenario


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=pathlib.Path)
    parser.add_argument('--batches', type=int, default=8)
    parser.add_argument('--interval-ticks', type=int, default=30)
    parser.add_argument('--tick-ms', type=int, default=60000)
    args = parser.parse_args()
    if args.batches < 1 or args.interval_ticks < 6 or args.tick_ms < 1:
        parser.error('batches and tick-ms must be positive; interval-ticks must be at least 6')
    scenario = build(args.batches, args.interval_ticks, args.tick_ms)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x') as handle:
        handle.write(json.dumps(scenario, indent=2) + '\n')
    print(json.dumps({'scenario': str(args.output.resolve()), 'tasks': 3 * args.batches,
                      'lastReleaseTick': (args.batches - 1) * args.interval_ticks,
                      'tickMs': args.tick_ms, 'stopsHost': False}))


if __name__ == '__main__':
    main()
