"""Build two local installable packages without publishing or changing the Provider API."""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    here = pathlib.Path(__file__).resolve().parent
    repo = here.parents[2]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    sdk = output / 'sdk'
    sdk.mkdir()
    manifest = {'name': '@ai4science/provider-sdk', 'version': '0.1.0', 'private': True, 'license': 'UNLICENSED',
                'type': 'module', 'files': ['dist', 'LICENSE'], 'exports': {
                    '.': {'types': './dist/sdk.d.ts', 'import': './dist/sdk.js'},
                    './testing': {'types': './dist/testing.d.ts', 'import': './dist/testing.js'}},
                'engines': {'node': '^22.19 || >=24'}}
    (sdk / 'package.json').write_text(json.dumps(manifest, indent=2) + '\n')
    shutil.copyfile(here.parent / 'LICENSE', sdk / 'LICENSE')
    subprocess.run(['pnpm', 'exec', 'tsc', '--ignoreConfig', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
                    '--declaration', '--skipLibCheck', '--strict', '--rewriteRelativeImportExtensions', '--types', 'node',
                    '--outDir', str(sdk / 'dist'), 'integrations/ai4science/platform/sdk.ts',
                    'integrations/ai4science/platform/testing.ts'], cwd=repo, check=True)
    packages = []
    for directory in [sdk, here / 'provider']:
        completed = subprocess.run(['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', str(output)],
                                   cwd=directory, capture_output=True, text=True, check=True)
        packed = json.loads(completed.stdout)[0]
        path = output / packed['filename']
        packages.append({'name': packed['name'], 'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'harnessBaseline': json.loads((repo / 'UPSTREAM.json').read_text())['upstreamCommit']})
    (output / 'packages.json').write_text(json.dumps(packages, indent=2) + '\n')
    print(json.dumps(packages, indent=2))


if __name__ == '__main__':
    main()
