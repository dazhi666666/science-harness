"""Launch one real-model study through the shipped dsh CLI; credential values never enter argv or artifacts."""
import argparse, datetime, hashlib, json, os, pathlib, subprocess, sys, time, uuid
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--credential-file',type=pathlib.Path)
parser.add_argument('--output',type=pathlib.Path,required=True)
args=parser.parse_args()
here=pathlib.Path(__file__).resolve().parent
repo=here.parents[2]
key=args.credential_file.read_text().strip() if args.credential_file else os.environ.get('AI4S_STEPFUN_API_KEY','').strip()
if not key:
 print('BLOCKED: provide AI4S_STEPFUN_API_KEY or --credential-file',file=sys.stderr);raise SystemExit(2)
out=args.output.resolve()
if out.exists(): raise SystemExit('Output directory already exists; restart/recovery is unsupported, use a new run directory')
out.mkdir(parents=True,mode=0o700)
project='study-'+str(uuid.uuid4())
host_version=json.loads((repo/'UPSTREAM.json').read_text())
env={k:v for k,v in os.environ.items() if not any(word in k.upper() for word in ['KEY','TOKEN','SECRET','PASSWORD'])}
env.update({'AI4S_STEPFUN_API_KEY':key,'AI4S_RUN_DIR':str(out),'AI4S_PROJECT_ID':project,'DSH_HOME':str(out/'host-home'),'DSH_TELEMETRY_DISABLED':'1'})
prompt='Conduct the complete five-Agent research study described in your science role instructions. Create both research branches, let them create and authorize their own midbrains, obtain and exchange initial results, obtain both research analyses, choose and actually execute at least one evidence-driven follow-up, analyze its observations, and publish your evidence-linked Markdown report. Use science_wait to remain active until completion. Scientific conclusions and the follow-up must be your decisions based on tool-returned observations, not assumed ground truth.'
command=['node','--import','tsx/esm','apps/cli/src/bin.ts','--profile','headless','--patch',str(here/'model.patch.yml'),'--patch',str(here/'study.patch.yml'),prompt]
implementation={str(p.relative_to(repo)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(here.glob('*.ts'))}
launch={'command':command,'cwd':str(repo),'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'entry':'dsh --profile headless','project':project,'model':{'provider':'stepfun-science','id':'step-3.7-flash','baseURL':'https://api.stepfun.com/step_plan/v1','credentialRef':'AI4S_STEPFUN_API_KEY'},'baseline':host_version['upstreamCommit'],'communicationPatchSHA256':host_version['hostPatchSHA256'],'implementationSHA256':implementation}
(out/'launch.json').write_text(json.dumps(launch,indent=2)+'\n')
start=time.monotonic()
with (out/'cli.log').open('w') as log:
 process=subprocess.Popen(command,cwd=repo,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True, encoding='utf-8')
 for line in process.stdout:
  safe=line.replace(key,'[REDACTED]');log.write(safe);log.flush()
 code=process.wait()
projectFile=out/'project.json'
state=json.loads(projectFile.read_text()) if projectFile.exists() else {}
report=state.get('report')
success=code==0 and state.get('status')=='completed' and bool(report) and (out/report['artifactPath']).exists()
summary={'exitCode':code,'elapsedSeconds':round(time.monotonic()-start,3),'success':success,'projectStatus':state.get('status','not-started'),'failure':state.get('failure'),'report':report,'modelRequests':state.get('modelRequests'),'observedTokens':state.get('observedTokens'),'budget':state.get('instrumentBudget')}
(out/'run-result.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
raise SystemExit(0 if success else 1)
