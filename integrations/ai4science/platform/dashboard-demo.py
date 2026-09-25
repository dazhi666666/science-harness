"""Seed a fresh local UI demonstration with actual instrument and computation operations."""
import argparse
import json
import pathlib
import subprocess
import sys


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',type=pathlib.Path,required=True)
    args=parser.parse_args()
    here=pathlib.Path(__file__).resolve().parent;repo=here.parents[2]
    root=args.directory.resolve();root.mkdir(parents=True,exist_ok=False)
    config={'apiVersion':1,'enabled':True,'baseline':json.loads((repo/'UPSTREAM.json').read_text())['upstreamCommit'],
      'directory':str(root/'execution'),'pollIntervalMs':20,'providerCallTimeoutMs':5000,
      'management':{'actorId':'local-operator','projects':['demo-lab','new-study'],'allowedProviders':['instrument','compute']},
      'providers':[{'module':str(here/'providers/instrument.ts'),'config':{'id':'instrument','directory':str(root/'instrument'),'resource':'instrument-1','tickMs':10,'reference':10,'slope':0.27,'drift':0.012,'noise':0.18,'seed':123}},
       {'module':str(here/'providers/compute.ts'),'config':{'id':'compute','directory':str(root/'compute'),'resource':'compute-1','tickMs':10,'chunkSize':1000}}]}
    path=root/'config.json';path.write_text(json.dumps(config,indent=2)+'\n')
    records=[]
    def run(args):
      p=subprocess.run([str(v) for v in args],cwd=repo,capture_output=True,text=True, encoding='utf-8')
      records.append({'command':[str(v) for v in args],'exitCode':p.returncode,'stdout':p.stdout,'stderr':p.stderr})
      (root/'seed-commands.json').write_text(json.dumps(records,indent=2)+'\n')
      if p.returncode:raise SystemExit(p.stderr)
      return json.loads(p.stdout.strip().splitlines()[-1])
    run([sys.executable,here/'install.py','--home',root/'home','--config',path])
    def cli(*args):return run([sys.executable,here/'manage.py','--home',root/'home',*args])
    cli('create','--project','demo-lab','--budget','20000000')
    for key,provider,value in [
      ('signal-calibration-01','instrument',{'conditions':[{'value':-1,'samples':4},{'value':1,'samples':4}]}),
      ('reference-sample-02','instrument',{'conditions':[{'value':0,'samples':6}]}),
      ('checksum-baseline','compute',{'text':'reference output','iterations':20000}),
    ]:
      input=root/(key+'.json');input.write_text(json.dumps(value))
      cli('start','--project','demo-lab','--provider',provider,'--key',key,'--input',input,'--wait')
    input=root/'cancel.json';input.write_text(json.dumps({'text':'partial checkpoint','iterations':2000000}))
    operation=cli('start','--project','demo-lab','--provider','compute','--key','checkpoint-cancelled','--input',input)
    cli('cancel','--project','demo-lab','--operation',operation['id']);cli('query','--project','demo-lab','--operation',operation['id'])
    input=root/'long.json';input.write_text(json.dumps({'text':'demo computation','iterations':6000000}))
    cli('start','--project','demo-lab','--provider','compute','--key','checksum-long-run','--input',input)
    print(json.dumps({'home':str(root/'home'),'configuration':str(path),'data':'actual synthetic operations; no invented status rows','start':['python3','integrations/ai4science/platform/manage.py','--home',str(root/'home'),'serve']}))


if __name__=='__main__':main()
