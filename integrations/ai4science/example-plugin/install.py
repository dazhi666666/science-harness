"""Install a copyable Provider example offline, and create its editable configuration and input."""
import argparse
import hashlib
import json
import pathlib
import subprocess


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packages',type=pathlib.Path,required=True)
    parser.add_argument('--directory',type=pathlib.Path,required=True)
    args=parser.parse_args()
    entries=json.loads((args.packages/'packages.json').read_text())
    root=args.directory.resolve();root.mkdir(parents=True,exist_ok=False)
    tarballs=[]
    for e in entries:
        path=args.packages.resolve()/pathlib.Path(e['path']).name
        if hashlib.sha256(path.read_bytes()).hexdigest()!=e['sha256']:raise SystemExit('Package integrity check failed')
        tarballs.append(str(path))
    (root/'package.json').write_text('{"name":"provider-example-installation","private":true,"type":"module"}\n')
    subprocess.run(['npm','install','--offline','--ignore-scripts','--no-audit','--no-fund','--package-lock=false',*tarballs],cwd=root,check=True)
    config={'apiVersion':1,'enabled':True,'baseline':entries[0]['harnessBaseline'],'directory':'./data/platform','pollIntervalMs':20,'providerCallTimeoutMs':5000,
        'management':{'actorId':'example-operator','projects':['example-plugin'],'allowedProviders':['example']},
        'providers':[{'module':'./node_modules/@ai4science/provider-example/src/index.mjs','config':{'id':'example','directory':'./data/provider','resource':'example-data'}}]}
    (root/'config.json').write_text(json.dumps(config,indent=2)+'\n')
    (root/'input.json').write_text(json.dumps({'values':[1,2,3],'scale':2,'offset':1},indent=2)+'\n')
    print(json.dumps({'directory':str(root),'config':str(root/'config.json'),'input':str(root/'input.json')}))


if __name__=='__main__':main()
