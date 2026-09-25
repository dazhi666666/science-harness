"""Build the copyable example and reuse the existing public SDK package builder."""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    here = pathlib.Path(__file__).resolve().parent
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    subprocess.run([sys.executable, here.parent/'external-job/build.py', '--output', output/'shared'], check=True)
    entries = json.loads((output/'shared/packages.json').read_text())
    sdk = next(e for e in entries if e['name']=='@ai4science/provider-sdk')
    target = output/pathlib.Path(sdk['path']).name
    shutil.copyfile(sdk['path'],target)
    sdk['path'] = str(target)
    packed = subprocess.run(['npm','pack','--ignore-scripts','--json','--pack-destination',str(output)],cwd=here/'provider',capture_output=True,text=True, encoding='utf-8',check=True)
    info=json.loads(packed.stdout)[0]
    path=output/info['filename']
    example={'name':info['name'],'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'harnessBaseline':sdk['harnessBaseline']}
    (output/'packages.json').write_text(json.dumps([sdk,example],indent=2)+'\n')
    print(json.dumps([sdk,example],indent=2))


if __name__=='__main__':main()
