"""Deterministic acceptance through independent dsh processes; compares the Provider's own action journals."""
import argparse
import datetime
import hashlib
import json
import pathlib
import sqlite3
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=pathlib.Path, required=True, help='New evidence directory')
    args = parser.parse_args()
    here = pathlib.Path(__file__).resolve().parent
    repo = here.parents[2]
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    home = root / 'host-home'
    config = json.loads((here / 'examples/local.config.json').read_text())
    config['directory'] = str(root / 'execution')
    config['pollIntervalMs'] = 5
    for p in config['providers']:
        p['module'] = str((here / 'providers' / (p['config']['id'] + '.ts')).resolve())
        p['config']['directory'] = str(root / p['config']['id'])
        p['config']['tickMs'] = 5
    config_path = root / 'config.json'
    config_path.write_text(json.dumps(config, indent=2) + '\n')
    commands = []
    checks = []

    def run(command, expected=0):
        result = subprocess.run(command, cwd=repo, capture_output=True, text=True, timeout=60)
        record = {'command': command, 'cwd': str(repo), 'exitCode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}
        commands.append(record)
        (root / 'commands.json').write_text(json.dumps(commands, indent=2) + '\n')
        assert result.returncode == expected, record
        lines = [line for line in result.stdout.splitlines() if line.startswith('{') or line.startswith('[')]
        return json.loads(lines[-1]) if lines else None

    def cli(*command, expected=0):
        return run([sys.executable, str(here / 'manage.py'), '--home', str(home), *command], expected)

    def check(name, condition):
        assert condition, name
        checks.append(name)

    success = False
    try:
        run([sys.executable, str(here / 'install.py'), '--home', str(home), '--config', str(config_path)])
        cli('--help')
        created = cli('create', '--project', 'example', '--budget', '10000')
        check('create project through installed profile', created['project']['budgetLimit'] == 10000)
        descriptions = cli('describe', '--project', 'example')
        check('public capability descriptions expose both independent Providers', sorted(x['id'] for x in descriptions) == ['compute', 'instrument'] and all(x['inputSchema'] and x['completion'] and x['cancellation'] for x in descriptions))
        facts = cli('facts', '--project', 'example')
        check('project facts are queryable without restoring Agent authorization', facts == [])
        cli('create', '--project', 'unauthorized', '--budget', '10', expected=1)
        check('unconfigured project denied', True)
        instrument_input = here / 'examples/instrument-input.json'
        completed = cli('start', '--project', 'example', '--provider', 'instrument', '--key', 'measure-1', '--input', str(instrument_input), '--wait', '--timeout-ms', '10000')
        check('instrument completion and raw outputs', completed['state'] == 'succeeded' and len(completed['artifacts']) == 2)
        original_id = completed['id']
        duplicate = cli('start', '--project', 'example', '--provider', 'instrument', '--key', 'measure-1', '--input', str(instrument_input))
        check('same stable request after process restart returns same operation', duplicate['id'] == original_id)
        with sqlite3.connect(root / 'instrument/instrument.sqlite') as db:
            starts = db.execute('SELECT count(*) FROM starts').fetchone()[0]
            samples = db.execute('SELECT count(*) FROM samples').fetchone()[0]
        check('independent instrument journal proves one start and six samples', starts == 1 and samples == 6)
        long_input = root / 'long-input.json'
        long_input.write_text(json.dumps({'text': 'cancel this bounded computation', 'iterations': 1000}))
        job = cli('start', '--project', 'example', '--provider', 'compute', '--key', 'compute-long', '--input', str(long_input))
        stopped = cli('stop', '--project', 'example')
        check('controller stop does not claim device stop', stopped['deviceStopConfirmed'] is False)
        queried = cli('query', '--project', 'example', '--operation', job['id'])
        check('restart queries original running computation', queried['state'] == 'running' and queried['id'] == job['id'])
        cli('start', '--project', 'example', '--provider', 'compute', '--key', 'conflicting-job', '--input', str(long_input), expected=1)
        check('conflicting compute resource denied across restart', True)
        cancelled = cli('cancel', '--project', 'example', '--operation', job['id'])
        check('cancellation request is durable and not terminal', cancelled['cancelRequested'] and cancelled['state'] == 'running')
        reconciled = cli('reconcile', '--project', 'example')
        terminal = next(x for x in reconciled['operations'] if x['id'] == job['id'])
        check('next controller observes real partial cancellation', terminal['state'] == 'cancelled' and terminal['progress']['iterations'] < 1000)
        with sqlite3.connect(root / 'compute/compute.sqlite') as db:
            check('cancelled job independently started exactly once', db.execute('SELECT count(*) FROM starts').fetchone()[0] == 1)
        computed = cli('start', '--project', 'example', '--provider', 'compute', '--key', 'compute-complete', '--input', str(here / 'examples/compute-input.json'), '--wait')
        check('second Provider completes through identical interface', computed['state'] == 'succeeded' and len(computed['artifacts']) == 1)
        exported = root / 'exported-digest.json'
        cli('export', '--project', 'example', '--artifact', computed['artifacts'][0]['id'], '--target', str(exported))
        expected_digest = 'AI4Science infrastructure v0.1'
        for _ in range(20):
            expected_digest = hashlib.sha256(expected_digest.encode()).hexdigest()
        check('exported computation independently recomputes', json.loads(exported.read_text())['digest'] == expected_digest)
        # SDK fixture publication is setup, not a second management application or a model report.
        publish_fixture = """import {openConfiguredEngine} from './integrations/ai4science/platform/config.ts';
import {Artifacts} from './integrations/ai4science/platform/artifacts.ts';
const {engine,config}=await openConfiguredEngine(process.argv[1]);
try {
 const access=engine.issueContext('example',config.management.actorId,config.management.allowedProviders);
 const report=new Artifacts(engine).publish(access,{content:'# Infrastructure fixture\\nThis fixture links one computed artifact.\\n',mediaType:'text/markdown',sources:[process.argv[2]]});
 console.log(JSON.stringify(report));
} finally {await engine.close();}
"""
        published = run(['node', '--import', 'tsx/esm', '--input-type', 'module', '--eval', publish_fixture, str(config_path), computed['artifacts'][0]['id']])
        report_path = root / 'exported-report.md'
        cli('export', '--project', 'example', '--artifact', published['id'], '--target', str(report_path))
        report_bytes = report_path.read_bytes()
        check('generic report artifact exports exact content and hash', report_bytes == b'# Infrastructure fixture\nThis fixture links one computed artifact.\n' and hashlib.sha256(report_bytes).hexdigest() == published['sha256'])
        report_facts = cli('facts', '--project', 'example')
        check('project report retains source association in durable facts', any(f['kind'] == 'artifact-published' and f['data']['id'] == published['id'] and f['data']['sources'] == [computed['artifacts'][0]['id']] for f in report_facts))
        cli('export', '--project', 'example', '--artifact', published['id'], '--target', str(report_path), expected=1)
        check('report export refuses overwrite without changing destination', report_path.read_bytes() == report_bytes)
        resumed_input = root / 'resumed-input.json'
        resumed_input.write_text(json.dumps({'text': 'resume existing computation', 'iterations': 100}))
        unfinished = cli('start', '--project', 'example', '--provider', 'compute', '--key', 'compute-resumed', '--input', str(resumed_input))
        check('submission exits with unfinished durable work', unfinished['state'] == 'running')
        resumed = cli('query', '--project', 'example', '--operation', unfinished['id'])
        check('new controller reads same running work', resumed['id'] == unfinished['id'] and resumed['state'] == 'running')
        finished = cli('wait', '--project', 'example', '--operation', unfinished['id'])
        repeated = cli('start', '--project', 'example', '--provider', 'compute', '--key', 'compute-resumed', '--input', str(resumed_input))
        check('recovered work completes without another operation', finished['state'] == 'succeeded' and repeated['id'] == unfinished['id'])
        with sqlite3.connect(root / 'compute/compute.sqlite') as db:
            starts = db.execute('SELECT count(*) FROM starts WHERE operation_id=?', (unfinished['id'],)).fetchone()[0]
            ends = [x[0] for x in db.execute('SELECT end_iteration FROM chunks WHERE operation_id=? ORDER BY end_iteration', (unfinished['id'],))]
        check('independent compute journal proves one start and no repeated chunks', starts == 1 and ends == list(range(5, 101, 5)))
        status = cli('status', '--project', 'example')
        check('reopened project budget preserves all reservations', status['project']['budgetUsed'] == 1126)
        listed = cli('list', '--project', 'example')
        check('reopened project lists four operations only', len(listed) == 4)
        cli('start', '--project', 'example', '--provider', 'unregistered', '--key', 'bad-provider', '--input', str(instrument_input), expected=1)
        run([sys.executable, str(here / 'install.py'), '--home', str(home), '--uninstall'])
        check('uninstall retains execution and Provider records', (root / 'execution/execution.sqlite').is_file() and (root / 'instrument/instrument.sqlite').is_file())
        cli('status', '--project', 'example', expected=1)
        success = True
    finally:
        summary = {'success': success, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'checks': checks, 'commandCount': len(commands), 'entry': 'dsh --profile ai4science', 'modelRequests': 0}
        (root / 'results.json').write_text(json.dumps(summary, indent=2) + '\n')
        print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
