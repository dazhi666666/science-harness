"""Exercise v0.2 experiment commands in separate real dsh processes, including independent external work."""
import argparse
import json
import pathlib
import sqlite3
import subprocess
import sys
import time


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=pathlib.Path,required=True)
    args=parser.parse_args()
    here=pathlib.Path(__file__).resolve().parent;repo=here.parents[2]
    out=args.output.resolve();out.mkdir(parents=True,exist_ok=False)
    commands=[];checks=[]
    def run(command,expected=0):
        r=subprocess.run([str(x) for x in command],cwd=repo,capture_output=True,text=True, encoding='utf-8',timeout=90)
        commands.append({'command':[str(x) for x in command],'exitCode':r.returncode,'stdout':r.stdout,'stderr':r.stderr})
        (out/'commands.json').write_text(json.dumps(commands,indent=2)+'\n')
        assert r.returncode==expected,commands[-1]
        for line in reversed(r.stdout.splitlines()):
            try:
                value=json.loads(line)
                if isinstance(value,(dict,list)):return value
            except json.JSONDecodeError:continue
        return None
    def check(name,condition):
        assert condition,name;checks.append(name)
        (out/'results.json').write_text(json.dumps({'success':False,'checks':checks},indent=2)+'\n')
    def write(name,value):
        path=out/name;path.write_text(json.dumps(value,indent=2)+'\n');return path
    run([sys.executable,here.parent/'external-job/build.py','--output',out/'packages'])
    run([sys.executable,here.parent/'external-job/install.py','--packages',out/'packages','--directory',out/'external-install'])
    external=json.loads((out/'external-install/config.json').read_text())['providers'][0]
    external['module']=str(out/'external-install/node_modules/@ai4science/provider-local-job/src/index.mjs')
    external['config'].update({'id':'external','directory':str(out/'external-device'),'resource':'external-cpu'})
    config=json.loads((here/'examples/local.config.json').read_text())
    config['directory']=str(out/'execution');config['pollIntervalMs']=5
    config['management']={'actorId':'operator','projects':['experiments'],'allowedProviders':['instrument','external']}
    instrument=config['providers'][0];instrument['module']=str(here/'providers/instrument.ts');instrument['config']['directory']=str(out/'instrument');instrument['config']['tickMs']=5
    config['providers']=[instrument,external]
    config_path=write('config.json',config);home=out/'home'
    run([sys.executable,here/'install.py','--home',home,'--config',config_path])
    def cli(*args,expected=0):return run([sys.executable,here/'manage.py','--home',home,*args],expected)
    cli('create','--project','experiments','--budget','15000000')
    spec=json.loads((here/'examples/sampling.request.json').read_text())
    request=write('request.json',spec)
    experiment=cli('experiment-create','--project','experiments','--key','study','--input',request)
    eid=experiment['id'];check('experiment request recorded without starting work',experiment['operations']==[])
    check('new process does not restore the prior live controller',cli('experiment-status','--project','experiments','--experiment',eid)['controllerActive'] is False)
    bad=write('bad-decision.json',{'requestKey':'bad','actionId':'unapproved','rationale':'Attempt an action outside requirements'})
    cli('experiment-act','--project','experiments','--experiment',eid,'--input',bad,expected=1)
    proposal=write('proposal.json',{'condition':2})
    review=cli('experiment-escalate','--project','experiments','--experiment',eid,'--reason','Requested condition exceeds original scope','--input',proposal)
    check('out-of-plan proposal becomes a review requirement',review['state']=='needs_review')
    first=write('initial.json',{'requestKey':'initial','actionId':'measure','rationale':'Execute the approved initial observations'})
    cli('experiment-act','--project','experiments','--experiment',eid,'--input',first,expected=1)
    cli('experiment-resolve','--project','experiments','--experiment',eid,'--reason','Reject changed conditions and continue the original plan')
    initial=cli('experiment-act','--project','experiments','--experiment',eid,'--input',first)
    feedback=cli('experiment-wait','--project','experiments','--experiment',eid,'--until','decision')
    check('program waits for observed completion',feedback['experiment']['state']=='awaiting_decision')
    assessor=here/'scenes/sampling.ts'
    q1=cli('experiment-assess','--project','experiments','--experiment',eid,'--assessor',assessor)
    check('domain method reads four actual observations and reports insufficiency',q1['status']=='insufficient' and q1['observed']==4)
    extra=write('supplement.json',{'requestKey':'additional','actionId':'supplement','rationale':'Actual completeness assessment found four readings below six','evidenceArtifactIds':[q1['artifactId']]})
    added=cli('experiment-act','--project','experiments','--experiment',eid,'--input',extra)
    check('additional operation receives a new identity',added['id']!=initial['id'])
    cli('experiment-wait','--project','experiments','--experiment',eid,'--until','decision')
    q2=cli('experiment-assess','--project','experiments','--experiment',eid,'--assessor',assessor)
    check('additional execution meets the declared data requirement',q2['status']=='sufficient' and q2['observed']==6)
    completion=write('completion.json',{'summary':'Declared observation count met; no scientific conclusion evaluated','artifactIds':[q2['artifactId']],'assessmentIds':[q2['assessmentId']]})
    done=cli('experiment-finish','--project','experiments','--experiment',eid,'--input',completion)
    check('execution completion is separate from assessments and scientific conclusions',done['state']=='completed' and done['scientificConclusion']=='not-evaluated-by-platform' and len(done['assessments'])==2)
    check('decisions retain their actual data evidence',done['decisions'][1]['evidenceArtifactIds']==[q1['artifactId']])
    retry=cli('experiment-act','--project','experiments','--experiment',eid,'--input',extra)
    check('restarted duplicate returns the existing operation',retry['id']==added['id'])
    db=sqlite3.connect(out/'instrument/instrument.sqlite')
    check('independent instrument journal proves exactly two runs and six samples',db.execute('SELECT COUNT(*) FROM starts').fetchone()[0]==2 and db.execute('SELECT COUNT(*) FROM samples').fetchone()[0]==6);db.close()
    check('experiment budget charged once',done['budgetUsed']==6)
    cli('export','--project','experiments','--artifact',q2['artifactId'],'--target',out/'assessment.json')
    check('exported assessment carries actual observed data count',json.loads((out/'assessment.json').read_text())['observed']==6)
    cli('experiment-status','--project','unrelated','--experiment',eid,expected=1)
    # Each external action is a real independent process, never a sleep fixture.
    job={'goal':'Track an independently running computation','method':{'id':'external-job-demo','version':'1'},'context':{},'inputArtifactIds':[],'outputRequirements':'Actual digest and exit record','budget':2000000,'maxOperations':1,'actions':[{'id':'compute','providerId':'external','input':{'text':'experiment','iterations':2000000},'minUses':1,'maxUses':1,'requiresEvidence':False}]}
    external_exp=cli('experiment-create','--project','experiments','--key','external-work','--input',write('external-request.json',job))
    extid=external_exp['id'];act=write('external-action.json',{'requestKey':'compute','actionId':'compute','rationale':'Run the approved fixed computation'})
    started=cli('experiment-act','--project','experiments','--experiment',extid,'--input',act)
    def external_rows():
        db=sqlite3.connect(out/'external-device/jobs.sqlite');db.row_factory=sqlite3.Row
        try:return [dict(r) for r in db.execute('SELECT * FROM jobs ORDER BY rowid')]
        finally:db.close()
    deadline=time.monotonic()+30
    while time.monotonic()<deadline and external_rows()[0]['state']!='succeeded':time.sleep(0.02)
    check('external work completes after controller exit without experiment polling',external_rows()[0]['state']=='succeeded')
    restored=cli('experiment-status','--project','experiments','--experiment',extid)
    check('restarted experiment reconnects to the original operation with fresh authority required',restored['operations'][0]['id']==started['id'] and restored['controllerActive'] is False)
    artifact=next(a for a in restored['operations'][0]['artifacts'] if a['path'].endswith('digest.json'))
    ended=cli('experiment-finish','--project','experiments','--experiment',extid,'--input',write('external-completion.json',{'summary':'Independent worker exit and digest observed','artifactIds':[artifact['id']],'assessmentIds':[]}))
    check('external experiment finishes with the existing result',ended['state']=='completed')
    job['budget']=10000000;job['actions'][0]['input']['iterations']=10000000
    cancel_exp=cli('experiment-create','--project','experiments','--key','cancel-work','--input',write('cancel-request.json',job));cancelid=cancel_exp['id']
    cli('experiment-act','--project','experiments','--experiment',cancelid,'--input',act)
    cancelled=cli('experiment-cancel','--project','experiments','--experiment',cancelid)
    check('experiment cancellation first records the request',cancelled['cancelRequested'])
    settled=cli('experiment-wait','--project','experiments','--experiment',cancelid,'--until','decision')
    check('cancelled experiment requires real external worker termination',settled['experiment']['state']=='cancelled' and settled['experiment']['operations'][0]['progress']['exitSignal']=='SIGTERM')
    check('partial cancelled work keeps its original budget charge',settled['experiment']['budgetUsed']==10000000)
    cli('experiment-list','--project','experiments')
    db=sqlite3.connect(out/'execution/execution.sqlite')
    check('all experiment facts share the migrated transaction store',db.execute('PRAGMA user_version').fetchone()[0]==2 and db.execute('SELECT COUNT(*) FROM experiments').fetchone()[0]==3);db.close()
    result={'success':True,'checks':checks,'commandCount':len(commands),'modelRequests':0,'packageHashes':json.loads((out/'packages/packages.json').read_text()),'experimentIds':[eid,extid,cancelid]}
    (out/'results.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'success':True,'commands':len(commands),'assertions':len(checks)}))


if __name__=='__main__':main()
