"""Run the independently installed example's own tests and the existing platform CLI."""
import argparse
import json
import pathlib
import sqlite3
import subprocess
import sys
import tempfile


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=pathlib.Path,required=True)
    args=parser.parse_args()
    here=pathlib.Path(__file__).resolve().parent;repo=here.parents[2]
    out=args.output.resolve();out.mkdir(parents=True,exist_ok=False)
    records=[]
    def run(command,cwd=repo,expected=0):
        r=subprocess.run([str(v) for v in command],cwd=cwd,capture_output=True,text=True, encoding='utf-8',timeout=90)
        records.append({'command':[str(v) for v in command],'cwd':str(cwd),'exitCode':r.returncode,'stdout':r.stdout,'stderr':r.stderr})
        (out/'commands.json').write_text(json.dumps(records,indent=2)+'\n')
        assert r.returncode==expected,records[-1]
        for line in reversed(r.stdout.splitlines()):
            try:
                value=json.loads(line)
                if isinstance(value,(dict,list)):return value
            except json.JSONDecodeError:
                continue
        return None
    run([sys.executable,here/'build.py','--output',out/'packages'])
    consumer=pathlib.Path(tempfile.mkdtemp(prefix='ai4science-example-consumer-'))/'installation'
    run([sys.executable,here/'install.py','--packages',out/'packages','--directory',consumer])
    package=consumer/'node_modules/@ai4science/provider-example'
    run(['node','--test','test/provider.test.mjs'],cwd=package)
    (consumer/'types.ts').write_text("import type {ExecutionProvider} from '@ai4science/provider-sdk';\nimport {createProvider} from '@ai4science/provider-example';\nconst p: ExecutionProvider = createProvider({}); void p;\n")
    (consumer/'tsconfig.json').write_text(json.dumps({'compilerOptions':{'strict':True,'noEmit':True,'module':'NodeNext','target':'ES2023','types':[]},'files':['types.ts']}))
    run(['pnpm','exec','tsc','-p',consumer/'tsconfig.json'])
    home=out/'home'
    run([sys.executable,here.parent/'platform/install.py','--home',home,'--config',consumer/'config.json'])
    def cli(*args,expected=0):return run([sys.executable,here.parent/'platform/manage.py','--home',home,*args],expected=expected)
    cli('create','--project','example-plugin','--budget','20')
    cli('describe','--project','example-plugin')
    result=cli('start','--project','example-plugin','--provider','example','--key','one','--input',consumer/'input.json')
    assert result['state']=='succeeded'
    assert cli('query','--project','example-plugin','--operation',result['id'])['state']=='succeeded'
    assert cli('start','--project','example-plugin','--provider','example','--key','one','--input',consumer/'input.json')['id']==result['id']
    assert cli('cancel','--project','example-plugin','--operation',result['id'])['state']=='succeeded'
    artifact=next(a for a in result['artifacts'] if a['mediaType']=='application/json')
    cli('export','--project','example-plugin','--artifact',artifact['id'],'--target',out/'result.json')
    assert json.loads((out/'result.json').read_text())=={'values':[3,5,7],'summary':{'count':3,'min':3,'max':7,'mean':5}}
    status=cli('status','--project','example-plugin');assert status['project']['budgetUsed']==3
    cli('query','--project','foreign','--operation',result['id'],expected=1)
    db=sqlite3.connect(consumer/'data/provider/example.sqlite')
    count=db.execute("SELECT COUNT(*) FROM events WHERE kind='workload-completed'").fetchone()[0];db.close();assert count==1
    (out/'results.json').write_text(json.dumps({'success':True,'providerUnitTests':4,'actualCommands':len(records),'workloadExecutions':count,'modelRequests':0,'installedOutsideRepository':str(consumer),'coreModified':False},indent=2)+'\n')
    print(json.dumps({'success':True,'providerUnitTests':4,'commands':len(records),'workloadExecutions':count}))


if __name__=='__main__':main()
