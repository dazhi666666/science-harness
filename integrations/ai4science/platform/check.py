"""Run the community's keyless infrastructure acceptance and retained regression suites."""
import argparse
import datetime
import json
import pathlib
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=pathlib.Path, required=True, help='Fresh local evidence directory')
    args = parser.parse_args()
    repo = pathlib.Path(__file__).resolve().parents[3]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    commands = [
        ['pnpm', 'exec', 'tsc', '-p', 'integrations/ai4science/platform/tsconfig.json'],
        *[['pnpm', 'exec', 'vitest', 'run', '--config', f'integrations/ai4science/{config}', '--reporter=verbose'] for config in [
            'platform/vitest.config.ts', 'cross-branch/vitest.config.ts', 'vitest.config.ts', 'teams/vitest.config.ts', 'first-loop/vitest.config.ts',
        ]],
        ['pnpm', 'exec', 'vitest', 'run', 'packages/subagent/subagent/tests/continuation.spec.ts',
         'packages/subagent/subagent/tests/service.spec.ts', 'packages/subagent/subagent/tests/control.spec.ts',
         'packages/experimental/tool-agent-team/tests/tool-team.spec.ts'],
        [sys.executable, 'integrations/ai4science/platform/cli-check.py', '--output', str(output / 'cli')],
    ]
    records = []
    success = True
    for index, command in enumerate(commands, 1):
        started = time.monotonic()
        log_name = f'{index:02d}.log'
        with (output / log_name).open('w') as log:
            result = subprocess.run(command, cwd=repo, stdout=log, stderr=subprocess.STDOUT)
        records.append({'command': command, 'exitCode': result.returncode, 'log': log_name,
                        'elapsedSeconds': round(time.monotonic() - started, 3)})
        success = success and result.returncode == 0
        (output / 'results.json').write_text(json.dumps({'success': success, 'modelRequests': 0,
            'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'commands': records}, indent=2) + '\n')
        print(json.dumps(records[-1]), flush=True)
        if not success:
            break
    raise SystemExit(0 if success else 1)


if __name__ == '__main__':
    main()
