"""Install local SDK/Provider tarballs into an independent directory and write an editable deployment example."""
import argparse
import hashlib
import json
import pathlib
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packages', type=pathlib.Path, required=True)
    parser.add_argument('--directory', type=pathlib.Path, required=True)
    args = parser.parse_args()
    packages = json.loads((args.packages / 'packages.json').read_text())
    root = args.directory.resolve()
    root.mkdir(parents=True, exist_ok=False)
    tarballs = []
    for entry in packages:
        # A delivery can move: only the manifest's filename is needed within its package directory.
        path = args.packages.resolve() / pathlib.Path(entry['path']).name
        if hashlib.sha256(path.read_bytes()).hexdigest() != entry['sha256']:
            raise SystemExit('Package hash mismatch: ' + path.name)
        tarballs.append(str(path))
    (root / 'package.json').write_text('{"name":"local-job-installation","private":true,"type":"module"}\n')
    subprocess.run(['npm', 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', *tarballs], cwd=root, check=True)
    config = {'apiVersion':1,'enabled':True,'baseline':packages[0]['harnessBaseline'],
              'directory':'./data/execution','pollIntervalMs':50,'providerCallTimeoutMs':5000,
              'management':{'actorId':'local-operator','projects':['external'],'allowedProviders':['local-job']},
              'providers':[{'module':'./node_modules/@ai4science/provider-local-job/src/index.mjs',
                'config':{'id':'local-job','directory':'./data/jobs','resource':'external-cpu','chunkSize':1000,'pollMs':20,'startupTimeoutMs':3000}}]}
    (root / 'config.json').write_text(json.dumps(config,indent=2)+'\n')
    (root / 'input.json').write_text(json.dumps({'text':'seed','iterations':2000000},indent=2)+'\n')
    print(json.dumps({'directory':str(root),'configuration':str(root/'config.json'),'input':str(root/'input.json'),
                      'entryModule':str(root/'node_modules/@ai4science/provider-local-job/src/index.mjs')}))


if __name__ == '__main__':
    main()
