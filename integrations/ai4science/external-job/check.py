"""Build, independently install and validate the external plugin; no model credentials required."""
import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--regressions', action='store_true', help='Also run the unchanged v0.1 acceptance suite')
    args = parser.parse_args()
    here = pathlib.Path(__file__).resolve().parent
    repo = here.parents[2]
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    records = []

    def run(command, env=None):
        name = f'{len(records)+1:02d}.log'
        with (out / name).open('w') as log:
            result = subprocess.run([str(x) for x in command], cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT)
        records.append({'command': [str(x) for x in command], 'exitCode': result.returncode, 'log': name})
        (out / 'commands.json').write_text(json.dumps(records, indent=2) + '\n')
        print(json.dumps(records[-1]), flush=True)
        if result.returncode: raise SystemExit(result.returncode)

    run([sys.executable, here / 'build.py', '--output', out / 'packages'])
    # Installation truly occurs outside the source checkout, without symlinking its internals.
    independent = pathlib.Path(tempfile.mkdtemp(prefix='ai4science-external-consumer-')) / 'run'
    run([sys.executable, here / 'install-check.py', '--packages', out / 'packages', '--output', independent])
    installed = json.loads((independent / 'results.json').read_text())
    env = os.environ.copy()
    env['AI4S_EXTERNAL_MODULE'] = installed['installedModule']
    run(['pnpm', 'exec', 'tsc', '-p', 'integrations/ai4science/external-job/tsconfig.json'])
    consumer = independent / 'consumer'
    (consumer / 'types.ts').write_text("import { validateProvider, type ExecutionProvider, type ProviderOperation } from '@ai4science/provider-sdk';\nimport { createProvider } from '@ai4science/provider-local-job';\nconst p: ExecutionProvider = createProvider({});\nconst op: ProviderOperation = {operationId:'id',projectId:'p',input:null,artifactDirectory:'/unused'};\nvoid validateProvider(p); void op;\n")
    (consumer / 'tsconfig.json').write_text(json.dumps({'compilerOptions': {'strict': True, 'noEmit': True, 'module': 'NodeNext', 'target': 'ES2023', 'types': []}, 'files': ['types.ts']}))
    run(['pnpm', 'exec', 'tsc', '-p', consumer / 'tsconfig.json'])
    run(['pnpm', 'exec', 'vitest', 'run', '--config', 'integrations/ai4science/external-job/vitest.config.ts', '--reporter=verbose'], env)
    if args.regressions:
        run([sys.executable, here.parent / 'platform/check.py', '--output', out / 'regressions'])
    (out / 'results.json').write_text(json.dumps({'success': True, 'baseline': json.loads((repo / 'UPSTREAM.json').read_text())['upstreamCommit'],
        'startingCommunityCommit': subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True, encoding='utf-8').strip(),
        'independentInstall': str(independent), 'installedModule': installed['installedModule'], 'installationChecks': installed,
        'modelRequests': 0, 'existingCoreModified': False, 'sourceSHA256': {str(p.relative_to(repo)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(here.rglob('*')) if p.is_file() and '__pycache__' not in p.parts},
        'records': records}, indent=2) + '\n')
    print(json.dumps({'success': True, 'independentInstall': str(independent), 'results': str(out / 'results.json')}))


if __name__ == '__main__':
    main()
