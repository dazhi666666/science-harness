"""Install both packages in a clean directory and run external execution tests through real dsh processes."""
import argparse
import hashlib
import json
import pathlib
import sqlite3
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packages', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    here = pathlib.Path(__file__).resolve().parent
    repo = here.parents[2]
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    records, checks = [], []

    def run(command, cwd=repo, expected=0):
        r = subprocess.run([str(v) for v in command], cwd=cwd, capture_output=True, text=True, encoding='utf-8', timeout=60)
        records.append({'command': [str(v) for v in command], 'cwd': str(cwd), 'exitCode': r.returncode, 'stdout': r.stdout, 'stderr': r.stderr})
        (root / 'commands.json').write_text(json.dumps(records, indent=2) + '\n')
        assert r.returncode == expected, records[-1]
        lines = [x for x in r.stdout.splitlines() if x.startswith('{') or x.startswith('[')]
        return json.loads(lines[-1]) if lines else None

    def check(name, condition):
        assert condition, name
        checks.append(name)
        (root / 'results.json').write_text(json.dumps({'success': False, 'checks': checks}, indent=2) + '\n')

    consumer = root / 'consumer'
    run([sys.executable, here / 'install.py', '--packages', args.packages.resolve(), '--directory', consumer])
    module = consumer / 'node_modules/@ai4science/provider-local-job/src/index.mjs'
    sdk = consumer / 'node_modules/@ai4science/provider-sdk/dist/sdk.js'
    check('SDK and Provider installed as separate plain-ESM packages outside platform source', module.is_file() and sdk.is_file())
    run(['node', '--input-type=module', '-e', "import {validateProvider} from '@ai4science/provider-sdk';import {createProvider} from '@ai4science/provider-local-job';console.log(JSON.stringify({sdk:typeof validateProvider,provider:typeof createProvider}));"], cwd=consumer)
    config = {'apiVersion': 1, 'enabled': True, 'baseline': json.loads((repo / 'UPSTREAM.json').read_text())['upstreamCommit'],
              'directory': str(root / 'execution'), 'pollIntervalMs': 20, 'providerCallTimeoutMs': 5000,
              'management': {'actorId': 'operator', 'projects': ['external'], 'allowedProviders': ['local-job']},
              'providers': [{'module': str(module), 'config': {'id': 'local-job', 'directory': str(root / 'device'),
                             'resource': 'external-cpu', 'chunkSize': 1000, 'pollMs': 20, 'startupTimeoutMs': 3000}}]}
    config_path = root / 'config.json'
    config_path.write_text(json.dumps(config, indent=2) + '\n')
    home = root / 'home'
    run([sys.executable, here.parent / 'platform/install.py', '--home', home, '--config', config_path])

    def cli(*command, expected=0):
        return run([sys.executable, here.parent / 'platform/manage.py', '--home', home, *command], expected=expected)

    def device():
        db = sqlite3.connect(root / 'device/jobs.sqlite')
        db.row_factory = sqlite3.Row
        try:
            jobs = [dict(x) for x in db.execute('SELECT * FROM jobs ORDER BY rowid')]
            starts = db.execute("SELECT COUNT(*) FROM events WHERE kind='worker-started'").fetchone()[0]
            return jobs, starts
        finally:
            db.close()

    def until(body, timeout=30):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            value = body()
            if value: return value
            time.sleep(0.02)
        raise AssertionError('Independent device observation deadline exceeded')

    cli('create', '--project', 'external', '--budget', '20000000')
    cli('describe', '--project', 'external')
    workload = root / 'input.json'
    workload.write_text(json.dumps({'text': 'seed', 'iterations': 2000000}))
    first = cli('start', '--project', 'external', '--provider', 'local-job', '--key', 'one', '--input', workload)
    check('submission returns before real job finishes', first['state'] in ['accepted', 'running'])
    running = until(lambda: next((r for r in device()[0] if r['done'] > 0 and r['state'] == 'running'), None))
    before = running['done']
    # Read the independent device journal only; no platform query drives this interval.
    until(lambda: device()[0][0]['done'] > before)
    finished = until(lambda: device()[0][0] if device()[0][0]['state'] == 'succeeded' else None)
    check('job progresses and completes after submitting dsh process exits, without any Provider query', finished['done'] == 2000000 and device()[1] == 1)
    digest = 'seed'
    for _ in range(2000000): digest = hashlib.sha256(digest.encode()).hexdigest()
    check('independent implementation recomputes exact result', finished['digest'] == digest)
    resumed = cli('query', '--project', 'external', '--operation', first['id'])
    check('fresh controller observes original successful job and real exit', resumed['state'] == 'succeeded' and resumed['progress']['exitCode'] == 0 and len(resumed['artifacts']) == 3)
    duplicate = cli('start', '--project', 'external', '--provider', 'local-job', '--key', 'one', '--input', workload)
    check('durable duplicate after restart produces no second start', duplicate['id'] == first['id'] and device()[1] == 1)
    cancelled_terminal = cli('cancel', '--project', 'external', '--operation', first['id'])
    check('cancellation after success does not rewrite successful history', cancelled_terminal['state'] == 'succeeded')
    artifact = next(a for a in resumed['artifacts'] if a['path'].endswith('digest.json'))
    cli('export', '--project', 'external', '--artifact', artifact['id'], '--target', root / 'exported-digest.json')
    check('export contains verified external result', json.loads((root / 'exported-digest.json').read_text())['digest'] == digest)
    workload.write_text(json.dumps({'text': 'cancel', 'iterations': 5000000}))
    second = cli('start', '--project', 'external', '--provider', 'local-job', '--key', 'cancel', '--input', workload)
    until(lambda: device()[0][-1]['done'] > 0)
    requested = cli('cancel', '--project', 'external', '--operation', second['id'])
    check('cancel request is persisted separately from termination', requested['cancelRequested'])
    ended = until(lambda: device()[0][-1] if device()[0][-1]['state'] == 'cancelled' else None)
    check('supervisor confirms actual worker termination and retains partial computation', ended['exit_signal'] == 'SIGTERM' and 0 < ended['done'] < 5000000)
    cancelled = cli('query', '--project', 'external', '--operation', second['id'])
    check('restart reads cancelled state and immutable partial artifacts', cancelled['state'] == 'cancelled' and len(cancelled['artifacts']) == 3 and device()[1] == 2)
    cli('status', '--project', 'external')
    cli('stop', '--project', 'external')
    (root / 'results.json').write_text(json.dumps({'success': True, 'checks': checks, 'commandCount': len(records), 'modelRequests': 0,
        'installedModule': str(module), 'providerStarts': device()[1]}, indent=2) + '\n')
    print(json.dumps({'success': True, 'assertions': len(checks), 'commands': len(records), 'installedModule': str(module)}))


if __name__ == '__main__':
    main()
