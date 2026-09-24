/** One concrete five-Agent science study through the real headless CLI and existing host runtime. */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, renameSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as validate } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-subagent'
import { installCrossBranchTools } from '../cross-branch/tools.ts'
import { SimulatedInstrument } from './simulator.ts'
import { installCompletionBoundary } from './completion.ts'
import { serialModelStreams } from './model-limit.ts'
import { saveAnalysis, saveReport } from './analysis.ts'
import { assertDecisionMatches, assertReportGate, decisionSchema, operationsSchema, missingReportFacts } from './policy.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    plugin: { readonly kind: 'plugin'; readonly plugin: string; readonly form?: string; readonly summary?: string }
  }
}

const hostVersion = JSON.parse(readFileSync(new URL('../../../UPSTREAM.json', import.meta.url), 'utf8')) as {upstreamCommit:string;hostPatchSHA256:string}

export const name = 'ai4science-first-loop'
export const inject = ['agents', 'tools', 'subagents', 'sessions', 'systemPrompt', 'llm']
export interface Config { root:string; project:string; maxModelRequests:number; maxOutputTokens:number; maxObservedTokens:number; timeoutMs:number; serializeModelRequests?:boolean }
export const Config: z<Config> = z.object({ root:z.string().required(), project:z.string().required(), maxModelRequests:z.natural().min(1).default(120), maxOutputTokens:z.natural().min(1).default(4096), maxObservedTokens:z.natural().min(1).default(600000), timeoutMs:z.natural().min(1000).default(1200000), serializeModelRequests:z.boolean().default(true) })
type Role = 'lead' | 'research' | 'midbrain'
type Branch = 'A' | 'B'
interface Participant { id:SessionId; role:Role; branch?:Branch; parentId?:SessionId; assignment:string; analysisPlan:string; createdAt:string }
interface Decision { id:string; artifactPath:string; ownerId:string; branch:Branch; analysisIds:string[]; operations:{condition:number;count:number}[]; rationale:string; discrimination:string; createdAt:string }
const operationParameters = { type:'array', required:true, items:{type:'object',additionalProperties:false,properties:{condition:{type:'number',required:true},count:{type:'integer',required:true}}} } as const
const strings = {type:'array',required:true,items:{type:'string'}} as const
const question = 'At a fixed reference input, does changing the dimensionless operating condition in [-1,1] produce a repeatable change in simulated output? Compare +1 versus -1, distinguish condition effect from variability and global-order drift, estimate uncertainty, and execute an evidence-chosen follow-up. Minimum effect of interest: 0.2 simulated output units.'
const notes = `This is a synthetic study, not a physical discovery. One shared instrument; condition [-1,1], 1..8 readings per operation, at most 3 operations per run, 96 readings total. Each branch may submit ONE initial run (up to 24 readings), leaving capacity for follow-up. A run is exclusive until completed; busy means use instrument_wait then retry the SAME request key and SAME inputs. Queries/waits do not acquire readings. Global acquisition order increases across ALL runs and NEVER resets; new data cannot reuse earlier order positions. Unknown failures stop; no crash recovery or cancellation is promised.
All identity comes from the host. Use science_status to discover live participant ids; never invent ids. The two research parents must stay active until the report finishes: use science_wait, never end early. Choose a specific until value when waiting: participants while identities are missing, consents before peer exchange, initial_results before analysis, research_analyses for the lead, followup_results after a decision, message for assignments. Use the latest version returned; do not repeat stale after_version values. Every role should call science_wait when waiting for messages/work. Incoming messages are processed at the next step. You have no filesystem/shell/HTTP tools and must not attempt to inspect simulator internals.
Cross-branch exchange is frozen: science_send_result permits only a saved completed-run reference and its correlated reply, after BOTH research parents authorize the exact pair. A reference envelope provides senderSessionId and messageId: read its run using instrument_read, then reply to senderSessionId with kind=reply, result_id and in_reply_to=messageId. Tell your research parent the peer run id and relevant observations. Each midbrain must send exactly one reference for its OWN initial run, even if it already replied to the peer. A reply to the peer is not your own reference. Check science_status.peerExchange to see which branch is missing. Do not repeatedly resend accepted references.
Analyses must use science_analyze on actual completed runs. Its deterministic output supplies numbers/assumptions, not your scientific conclusion. State limitations and competing explanations. Never fabricate measurements, estimates, scientific certainty or a completed run.`
function instructions(p:Participant) {
 const role = p.role === 'lead'
  ? 'You are the main scientific coordinator. Create Research A (repeatability and order/drift investigation) and Research B (condition-effect and order-control investigation) using science_delegate_role with analysis plans. A branch is NOT a fixed condition; each research agent may request any permitted conditions and ordering. Let BOTH research agents create their own midbrains. Wait for both initial experiments, both research analyses and peer exchange. Review actual analysis outputs. Use science_choose_followup to select at least one NEW experiment based on evidence, with concrete conditions/counts, cited analyses, rationale and the uncertainty addressed; it automatically sends your decision to the selected research parent. Wait for execution, analyze the follow-up with initial evidence, inspect science_status(report_requirements=true).reportRequirements, and call science_write_report with YOUR Markdown conclusions and working relative links. Keep the report concise (about 800–1200 words): summarize numeric evidence and link raw files instead of transcribing all readings. The report must include all required references, observations, uncertainty, competing explanations and follow-up rationale. Report ACTUALLY EXECUTED condition blocks and global orders, not just proposed labels: the instrument does NOT randomize or shuffle operations. If an earlier plan called it randomized but the recorded blocks were sequential, disclose this as a limitation/deviation; never pretend randomization happened. Do not end before report publication.'
  : p.role === 'research'
    ? `You are Research ${p.branch}. Create exactly one midbrain for your own branch using science_delegate_role with your initial experiment assignment and prespecified analysis plan. Use science_status until both midbrain ids exist; then independently call science_authorize_peer for YOUR worker, the peer worker and its actual research parent. Send your worker the initial requested conditions/counts with send_message if your assignment was not explicit. Analyze your initial results and the peer evidence, using science_analyze; tell the lead your analysis ids, interpretation and uncertainties. When the lead sends a follow-up decision, use send_message to direct YOUR midbrain to execute its exact operations with phase=followup and decision_id. Continue to interpret actual follow-up results. Keep your parent authority live with science_wait until project completion; do not finish your turn early.`
    : `You are Midbrain ${p.branch}. Follow your research parent's scientific assignment; if required experimental conditions/counts are missing, ask that parent using send_message. Execute one initial run using instrument_submit; then instrument_query or instrument_wait(run_id), and tell your parent the completed run id and raw paths. Discover your peer and bilateral consents with science_status. Send your initial completed run reference with science_send_result to the peer; when their reference arrives, instrument_read it, send a correlated reply and tell your parent the peer run id and its relevance to ordering/coordination. On an authorized follow-up decision from your parent, execute exactly its operations, branch, phase=followup and decision_id using a NEW request key, wait, and report the new run id. Use science_wait to stay available between assignments. Do not select follow-up experiments yourself or bypass the instrument.`
 return `${question}\n\n${notes}\n\n${role}\nYour host id is ${p.id}. Your parent id is ${p.parentId ?? 'none'}. Your branch is ${p.branch ?? 'coordinator'}.\nAssignment: ${p.assignment}\nInitial analysis plan: ${p.analysisPlan}`
}

export async function apply(ctx:Context, config:Config):Promise<void> {
 const root=resolve(config.root);mkdirSync(root,{recursive:true,mode:0o700})
 const instrument=new SimulatedInstrument({root,budget:96,maxOperationsPerRun:3,readingDelayMs:35});await instrument.initialize()
 const participants=new Map<SessionId,Participant>()
 const analyses:Awaited<ReturnType<typeof saveAnalysis>>[]=[]
 const decisions:Decision[]=[]
 const exchanges:{senderId:string;targetId:string;resultId:string;kind:string;messageId:string;createdAt:string}[]=[]
 const processed:{agentId:string;messageId:string;kind:string;resultId:string}[]=[]
 const consents=new Set<Branch>()
 let leadId:SessionId|undefined
 let version=0, requests=0, observedTokens=0
 let state:'running'|'completed'|'stopped'='running'
 let failure:string|undefined
 let report:Awaited<ReturnType<typeof saveReport>>|undefined
 const waits=new Set<{ownerId:SessionId;check:()=>void;force:()=>void}>()
 const startedAt=new Date().toISOString()
 const write=(path:string,value:unknown)=>{const full=join(root,path);mkdirSync(resolve(full,'..'),{recursive:true});const tmp=full+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(tmp,full)}
 const event=(kind:string,data:unknown)=>appendFileSync(join(root,'project-events.jsonl'),JSON.stringify({kind,at:new Date().toISOString(),data})+'\n',{mode:0o600})
 const persist=()=>write('project.json',{project:config.project,status:state,failure:failure??null,startedAt,processId:process.pid,baseline:hostVersion.upstreamCommit,communicationPatch:hostVersion.hostPatchSHA256,model:{provider:'stepfun-science',model:'step-3.7-flash',endpoint:'https://api.stepfun.com/step_plan/v1',credentialRef:'AI4S_STEPFUN_API_KEY'},limits:config,modelRequests:requests,observedTokens,instrumentBudget:instrument.budgetStatus(),participants:[...participants.values()],consents:[...consents],analyses:analyses.map(a=>({id:a.id,artifactPath:a.artifactPath,ownerId:a.ownerId,runIds:a.runIds})),decisions,exchanges,processed,report:report??null})
 const changed=()=>{version++;persist();for(const waiter of [...waits])waiter.check()}
 const fail=(reason:string)=>{
  if(state!=='running')return
  state='stopped';failure=reason;event('stopped',{reason});changed()
  queueMicrotask(()=>{for(const p of participants.values())ctx.agents.get(p.id)?.cancel({kind:'parent'})})
 }
 const timer=setTimeout(()=>fail('Project wall-clock limit reached; no recovery attempted'),config.timeoutMs)
 ctx.effect(()=>async()=>{clearTimeout(timer);if(state==='running'){state='stopped';failure='Host disposed before report completion'}for(const waiter of [...waits])waiter.check();await instrument.close();persist()},'science.firstLoopLifetime')
 installCrossBranchTools(ctx,config.project,id=>{try {const run=instrument.queryRun(id);return run.status==='completed'?{project:config.project,ownerSessionId:SessionId(run.ownerId)}:undefined}catch{return undefined}})
 const common=['science_status','science_wait','send_message','instrument_read']
 const allowed=(role:Role)=>[...common,...(role==='lead'?['science_delegate_role','science_analyze','science_read_analysis','science_choose_followup','science_write_report']:role==='research'?['science_delegate_role','science_authorize_peer','science_analyze','science_read_analysis']:['instrument_submit','instrument_query','instrument_wait','science_send_result'])]
 ctx.on('agent/created',({agent})=>{
  if(!participants.has(agent.id)) {
   if(leadId!==undefined){fail('Unexpected Agent created outside the five-participant roster');return}
   leadId=agent.id;participants.set(agent.id,{id:agent.id,role:'lead',assignment:question,analysisPlan:'Delegate complementary plans; inspect evidence before selecting follow-up.',createdAt:new Date().toISOString()})
  }
  const p=participants.get(agent.id)!
  agent.ctx.tools.restrict({allow:allowed(p.role)})
  agent.ctx.systemPrompt.section({name:'science:study-role',order:1,text:()=>instructions(p)})
  event('participant-live',{...p,actualParent:agent.session.header.parentSession??null});changed()
 })
 installCompletionBoundary(ctx,()=>state==='completed',agent=>participants.has(agent.id),(agent,ids)=>event('post-report-input-declined',{agentId:agent.id,messageIds:ids,reason:'No further model work after published report'}))
 ctx.on('agent/turn-stopping',({agent})=>{
  if(state==='running'&&participants.has(agent.id)) agent.steer(createUserMessage({source:{kind:'plugin',plugin:name,form:'notice',summary:'Study is still active'},content:[{type:'text',text:'The study is not complete. If waiting for peers, assignments or analyses, call science_wait; do not end this participant yet. Use science_status to identify the next necessary action.'}]}))
 })
 const serialStream=serialModelStreams()
 ctx.on('llm/stream',async function*(options,next){
  const produce=async function*(){
  if(state!=='running')throw new Error('Science project has stopped')
  if(requests>=config.maxModelRequests||observedTokens>=config.maxObservedTokens){fail('Model request/token admission budget reached');throw new Error('Model budget reached')}
  requests++
  event('model-request',{number:requests,provider:options.provider,model:options.model,processId:process.pid});persist()
  for await(const chunk of next()) {
   if(chunk.type==='usage') {observedTokens+=chunk.usage.inputTokens+chunk.usage.outputTokens;event('model-usage',chunk.usage)}
   yield chunk
  }
  persist()
  }
  if(config.serializeModelRequests!==false)yield* serialStream(options.signal,produce)
  else yield* produce()
 })
 ctx.on('agent/error',({agent})=>{if(participants.has(agent.id)&&state==='running')fail(`Agent ${agent.id} failed; preserve records and stop`)})
 ctx.on('agent/inbox/inserted',({agent})=>{if(participants.has(agent.id))for(const waiter of [...waits])if(waiter.ownerId===agent.id)waiter.force()})
 ctx.on('tools/result',(exec,value)=>{
  const p=exec.agent?participants.get(exec.agent.id):undefined
  if(!p||value.isError)return
  const args=exec.arguments as Record<string,unknown>
  if(exec.name==='science_authorize_peer'&&p.branch){consents.add(p.branch);event('consent',{parentId:p.id,branch:p.branch,...args});changed()}
  if(exec.name==='science_send_result'){
   const v=value.value as {messageId:string}
   exchanges.push({senderId:p.id,targetId:String(args.target_id),resultId:String(args.result_id),kind:String(args.kind),messageId:v.messageId,createdAt:new Date().toISOString()});event('cross-branch-accepted',exchanges.at(-1));changed()
  }
 })
 ctx.on('session/event',(session,e)=>{
  if(e.type==='user/message'&&e.data.source.kind==='science-result'){
   const data=JSON.parse(e.data.content.filter(b=>b.type==='text').map(b=>b.text).join('')) as {kind:string;resultId:string}
   processed.push({agentId:session.id,messageId:e.data.id,kind:data.kind,resultId:data.resultId});event('cross-branch-processing-started',{...processed.at(-1),source:e.data.source});changed()
  }
 })
 const actor=(exec:ToolRunContext,roles:Role[])=>{const agent=exec.agent;const p=agent?participants.get(agent.id):undefined;if(!agent||ctx.agents.get(agent.id)!==agent||!p||!roles.includes(p.role))throw new Error('Tool not authorized for this exact live science participant');return{agent,p}}
 const json=(value:unknown):JsonValue=>JSON.parse(JSON.stringify(value)) as JsonValue
 const register=(toolName:string,description:string,parameters:ParameterSchemaSpec,roles:Role[],body:(args:Record<string,unknown>,exec:ToolRunContext,p:Participant,agent:Agent)=>Promise<unknown>)=>{
  ctx.tools.register(defineTool({name:toolName,description,parameters,output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},async execute(args,exec){const {agent,p}=actor(exec,roles);if(state!=='running'&&!['science_status','science_wait'].includes(toolName))throw new Error('Study is stopped/completed');const value=await body(args,exec,p,agent);return json(value)}}))
 }
 const peerExchange=()=>['A','B'].map(branch=>{const mid=[...participants.values()].find(p=>p.role==='midbrain'&&p.branch===branch);const initial=instrument.listRuns().find(r=>r.branch===branch&&r.phase==='initial'&&r.status==='completed');return{branch,midbrainId:mid?.id??null,researchParentId:mid?.parentId??null,ownInitialRunId:initial?.runId??null,ownInitialReferenceSent:!!mid&&!!initial&&exchanges.some(e=>e.senderId===mid.id&&e.kind==='reference'&&e.resultId===initial.runId),ownInitialReferenceProcessed:!!mid&&!!initial&&exchanges.some(e=>e.senderId===mid.id&&e.kind==='reference'&&e.resultId===initial.runId&&processed.some(m=>m.messageId===e.messageId))}})
 const facts=()=>{const runs=instrument.listRuns();const followups=runs.filter(r=>r.phase==='followup'&&r.status==='completed');return{participants:participants.size,initialBranches:runs.filter(r=>r.phase==='initial'&&r.status==='completed').map(r=>r.branch),researchAnalysisBranches:analyses.flatMap(a=>{const owner=participants.get(SessionId(a.ownerId));return owner?.role==='research'&&owner.branch?[owner.branch]:[]}),exchanges:peerExchange().filter(e=>e.ownInitialReferenceSent&&e.ownInitialReferenceProcessed).length,repliesProcessed:processed.filter(e=>e.kind==='reply').length,completedFollowups:followups.length,finalAnalysisCoversFollowup:analyses.some(a=>followups.some(r=>a.runIds.includes(r.runId)))}}
 const reportRequirements=()=>{
  const runs=instrument.listRuns().filter(r=>r.status==='completed')
  return{missing:missingReportFacts(facts()),executedDesign:runs.map(r=>({runId:r.runId,phase:r.phase,blocks:r.operationIds.map(id=>instrument.queryOperation(id)).map(o=>({condition:o.condition,count:o.count})),globalOrders:instrument.readings([r.runId]).map(row=>row.order),ordering:'sequential condition blocks in requested order; no randomization performed by instrument'})),analysisPaths:analyses.map(a=>a.artifactPath),rawPaths:runs.map(r=>`instrument/raw/${r.runId}.csv`),runIds:runs.map(r=>r.runId),runPaths:runs.map(r=>`instrument/runs/${r.runId}.json`),decisionPaths:decisions.map(d=>d.artifactPath),linkInstruction:'Report is saved under reports/. EVERY required artifact needs a real clickable Markdown link: [analysis](../analyses/<id>.json), [raw data](../instrument/raw/<run>.csv), [decision](../decisions/<id>.json). Plain paths or code spans are not links and will be rejected. Include all required references in a compact evidence appendix.'}
 }
 const identity=(v:Participant)=>({id:v.id,role:v.role,branch:v.branch??null,parentId:v.parentId??null,status:ctx.agents.get(v.id)?.status??'inactive'})
 const snapshot=(p:Participant,reportRefs=false)=>({project:config.project,state,failure:failure??null,version,self:identity(p),participants:[...participants.values()].map(identity),consents:[...consents],budget:instrument.budgetStatus(),modelBudget:{usedRequests:requests,maxRequests:config.maxModelRequests,observedTokens,maxObservedTokens:config.maxObservedTokens},runs:instrument.listRuns(),analyses:analyses.map(a=>({id:a.id,artifactPath:a.artifactPath,ownerId:a.ownerId,runIds:a.runIds,method:a.method})),decisions:decisions.map(d=>({id:d.id,branch:d.branch,operations:d.operations,artifactPath:d.artifactPath})),peerExchange:peerExchange(),reportMissing:missingReportFacts(facts()),exchanges,processed,...reportRefs?{reportRequirements:reportRequirements()}:{}})
 register('science_status','Read compact project identities, valid parent/peer ids, run status, evidence ids and budgets. Analysis numbers are read with science_read_analysis. For final publication set report_requirements=true.',{report_requirements:{type:'boolean'}},['lead','research','midbrain'],async(a,_e,p)=>snapshot(p,a.report_requirements===true))
 register('science_wait','Wait for a specific factual condition or a message to THIS participant. Preserves parent authority and returns at most every 20 seconds. Uses a compact snapshot; it does not repeatedly return analysis/raw data.',{until:{type:'string',enum:['message','participants','consents','initial_results','research_analyses','peer_exchange','followup_results']},after_version:{type:'integer'}},['lead','research','midbrain'],async(args,exec,p,agent)=>{
  if(state!=='running'){exec.concludeTurn();return snapshot(p)}
  const until=typeof args.until==='string'?args.until:'message'
  const ready=()=>state!=='running'||agent.inbox.nextStep.length>0||agent.inbox.nextTurn.length>0
    ||(until==='participants'&&participants.size===5)
    ||(until==='consents'&&consents.size===2)
    ||(until==='initial_results'&&['A','B'].every(b=>instrument.listRuns().some(r=>r.branch===b&&r.phase==='initial'&&r.status==='completed')))
    ||(until==='research_analyses'&&['A','B'].every(b=>analyses.some(a=>participants.get(SessionId(a.ownerId))?.role==='research'&&participants.get(SessionId(a.ownerId))?.branch===b)))
    ||(until==='peer_exchange'&&peerExchange().every(e=>e.ownInitialReferenceSent&&e.ownInitialReferenceProcessed)&&processed.some(e=>e.kind==='reply'))
    ||(until==='followup_results'&&instrument.listRuns().some(r=>r.phase==='followup'&&r.status==='completed'))
  if(ready())return snapshot(p)
  await new Promise<void>((resolve,reject)=>{const finish=()=>{clearTimeout(t);waits.delete(waiter);exec.signal.removeEventListener('abort',abort);resolve()};const abort=()=>{clearTimeout(t);waits.delete(waiter);reject(exec.signal.reason)};const waiter={ownerId:agent.id,check:()=>{if(ready())finish()},force:finish};const t=setTimeout(finish,20000);waits.add(waiter);exec.signal.addEventListener('abort',abort,{once:true});if(exec.signal.aborted)abort()})
  if(state!=='running')exec.concludeTurn()
  return snapshot(p)
 })
 register('science_read_analysis','Read the exact persisted numerical analysis selected by id; use this before interpreting another researcher\'s evidence or choosing follow-up.',{analysis_id:{type:'string',required:true}},['lead','research'],async(args)=>{const a=analyses.find(x=>x.id===args.analysis_id);if(!a)throw new Error('Unknown analysis id');return a})
 register('science_delegate_role','Create the next participant through the host: lead may create one research per branch; each research may create its own one midbrain. Save an assignment and analysis plan before observing those data.',{role:{type:'string',enum:['research','midbrain'],required:true},branch:{type:'string',enum:['A','B'],required:true},assignment:{type:'string',required:true},analysis_plan:{type:'string',required:true}},['lead','research'],async(args,exec,p,agent)=>{
  const a=validate.object({role:validate.enum(['research','midbrain']),branch:validate.enum(['A','B']),assignment:validate.string().min(30),analysis_plan:validate.string().min(20)}).parse(args)
  if((p.role==='lead'&&a.role!=='research')||(p.role==='research'&&(a.role!=='midbrain'||a.branch!==p.branch)))throw new Error('Creation must preserve lead -> research -> own midbrain')
  const existing=[...participants.values()].find(v=>v.role===a.role&&v.branch===a.branch)
  if(existing)return{alreadyCreated:true,participant:existing}
  if(participants.size>=5)throw new Error('Five-agent cap reached')
  const id=SessionId(randomUUID());const child:Participant={id,role:a.role,branch:a.branch,parentId:p.id,assignment:a.assignment,analysisPlan:a.analysis_plan,createdAt:new Date().toISOString()}
  participants.set(id,child);write(`briefs/${id}.json`,child);changed()
  try {
   const started=await ctx.subagents.startContinuable({provider:'spawn',childId:id,label:`${a.role} ${a.branch}`,request:{parent:agent,prompt:[{type:'text',text:`Begin your assigned ${child.role} ${child.branch} work. Assignment: ${child.assignment}. Prespecified analysis plan: ${child.analysisPlan}`}],agentOptions:{provider:'stepfun-science',model:'step-3.7-flash',maxTokens:config.maxOutputTokens},maxDepth:2,toolFilter:{allow:allowed(child.role)}},signal:exec.signal})
   event('participant-created',{participant:child,messageId:started.messageId});return{participant:child,messageId:started.messageId}
  } catch(error) {fail(`Participant creation failed for ${a.role} ${a.branch}`);throw error}
 })
 register('instrument_submit','Apply the requested conditions and sequentially acquire a short exclusive run. Submission returns before acquisition completion. Same request key+inputs deduplicates; busy does not consume budget. Follow-up must exactly match the lead decision.',{request_key:{type:'string',required:true},phase:{type:'string',enum:['initial','followup'],required:true},operations:operationParameters,decision_id:{type:'string'}},['midbrain'],async(args,_exec,p)=>{
  const a=validate.object({request_key:validate.string().min(1),phase:validate.enum(['initial','followup']),operations:operationsSchema,decision_id:validate.string().optional()}).parse(args)
  const previous=instrument.listRuns().find(r=>r.ownerId===p.id&&r.requestKey===a.request_key)
  if(a.phase==='initial'&&!previous&&instrument.listRuns().some(r=>r.branch===p.branch&&r.phase==='initial'))throw new Error('One initial run per branch; further acquisition needs a lead follow-up decision')
  if(a.phase==='followup') {const decision=decisions.find(d=>d.id===a.decision_id);if(!decision)throw new Error('Unknown lead decision');assertDecisionMatches(decision,p.branch!,a.operations)}
  const submitted=await instrument.submit(p.id,{requestKey:a.request_key,branch:p.branch!,phase:a.phase,operations:a.operations,...a.decision_id?{decisionId:a.decision_id}:{}})
  event('instrument-submission',{caller:p.id,inputs:a,...submitted});changed()
  if(submitted.runId&&!submitted.duplicate)void instrument.waitRun(submitted.runId).then(()=>{event('run-completed',instrument.queryRun(submitted.runId!));changed()},()=>fail(`Instrument run ${submitted.runId} failed; retaining partial records`))
  return submitted
 })
 register('instrument_query','Query a run or operation without acquiring or consuming budget.',{run_id:{type:'string'},operation_id:{type:'string'}},['midbrain'],async(args)=>args.operation_id?instrument.queryOperation(String(args.operation_id)):instrument.queryRun(String(args.run_id)))
 register('instrument_wait','Wait for a specific acquisition, or with no run_id for the shared instrument to become available. Aborting this wait does not cancel the acquisition.',{run_id:{type:'string'}},['midbrain'],async(args,exec)=>{if(args.run_id){const r=await instrument.waitRun(String(args.run_id),exec.signal);return{run:r,rawPaths:[`instrument/raw/${r.runId}.json`,`instrument/raw/${r.runId}.csv`]}}await instrument.waitAvailable(exec.signal);return instrument.budgetStatus()})
 register('instrument_read','Read actual recorded observations for completed runs. This is the only raw-data access; simulator parameters are never returned.',{run_ids:strings},['lead','research','midbrain'],async(args)=>{
  const ids=validate.array(validate.string()).min(1).parse(args.run_ids);for(const id of ids)if(instrument.queryRun(id).status!=='completed')throw new Error('Run is not complete')
  return{runs:ids.map(id=>instrument.queryRun(id)),readings:instrument.readings(ids),rawPaths:ids.map(id=>`instrument/raw/${id}.csv`)}
 })
 register('science_analyze','Run a selected reproducible numerical analysis on actual completed runs. Choose condition-summary or condition-order-regression and explain why; interpret the returned numbers yourself.',{run_ids:strings,method:{type:'string',enum:['condition-summary','condition-order-regression'],required:true},rationale:{type:'string',required:true}},['lead','research'],async(args,_exec,p)=>{
  const a=validate.object({run_ids:validate.array(validate.string()).min(1),method:validate.enum(['condition-summary','condition-order-regression']),rationale:validate.string().min(20)}).parse(args)
  for(const id of a.run_ids)if(instrument.queryRun(id).status!=='completed')throw new Error('Analysis requires completed run data')
  const analysis=await saveAnalysis({root,analysisId:`analysis-${randomUUID()}`,ownerId:p.id,runIds:a.run_ids,method:a.method,rationale:a.rationale,readings:instrument.readings(a.run_ids),rawPaths:a.run_ids.map(id=>`instrument/raw/${id}.csv`)})
  analyses.push(analysis);event('analysis-saved',{id:analysis.id,caller:p.id,branch:p.branch??null,runIds:a.run_ids});changed();return analysis
 })
 register('science_choose_followup','After both initial branches and analyses, choose and record an evidence-driven additional experiment. Your exact decision is sent to the selected research parent; that parent instructs its own midbrain.',{branch:{type:'string',enum:['A','B'],required:true},analysis_ids:strings,operations:operationParameters,rationale:{type:'string',required:true},discrimination:{type:'string',required:true}},['lead'],async(args,exec,p,agent)=>{
  const a=decisionSchema.parse({branch:args.branch,analysisIds:args.analysis_ids,operations:args.operations,rationale:args.rationale,discrimination:args.discrimination})
  const cited=a.analysisIds.map(id=>{const v=analyses.find(x=>x.id===id);if(!v)throw new Error('Unknown analysis cited');return v})
  const runs=instrument.listRuns().filter(r=>r.phase==='initial'&&r.status==='completed')
  if(!['A','B'].every(b=>runs.some(r=>r.branch===b&&cited.some(x=>x.runIds.includes(r.runId)))))throw new Error('Follow-up must cite analyzed initial evidence from BOTH branches')
  if(!['A','B'].every(b=>analyses.some(x=>participants.get(SessionId(x.ownerId))?.role==='research'&&participants.get(SessionId(x.ownerId))?.branch===b)))throw new Error('Wait for BOTH research agents to produce an initial analysis')
  if(peerExchange().some(e=>!e.ownInitialReferenceSent||!e.ownInitialReferenceProcessed)||!processed.some(e=>e.kind==='reply'))throw new Error('Before choosing follow-up, complete initial peer exchange. Missing: '+JSON.stringify(peerExchange().filter(e=>!e.ownInitialReferenceSent||!e.ownInitialReferenceProcessed)))
  const requested=a.operations.reduce((sum,o)=>sum+o.count,0);if(requested>instrument.budgetStatus().remaining)throw new Error('Follow-up exceeds remaining readings')
  const id=`decision-${randomUUID()}`;const d:Decision={...a,id,artifactPath:`decisions/${id}.json`,ownerId:p.id,createdAt:new Date().toISOString()}
  decisions.push(d);write(d.artifactPath,d);event('model-followup-decision',d);changed()
  const target=[...participants.values()].find(v=>v.role==='research'&&v.branch===a.branch)!
  await ctx.subagents.sendMessage(agent,target.id,[{type:'text',text:`Execute this approved follow-up by instructing YOUR midbrain via send_message. Use phase=followup, decision_id=${id}, and these exact operations. Decision: ${JSON.stringify(d)}`}],{signal:exec.signal})
  return d
 })
 register('science_write_report','Publish YOUR final Markdown report after initial experiments, cross-branch exchange, evidence-driven follow-up and final analysis. Include every reference listed by science_status.reportRequirements. This ends the study and drains remaining participant waits.',{markdown:{type:'string',required:true}},['lead'],async(args,exec,p,agent)=>{
  const markdown=validate.string().min(300).parse(args.markdown)
  assertReportGate(facts())
  if(instrument.budgetStatus().activeRunId!==null)throw new Error('Active acquisition must finish before report')
  const refs=reportRequirements()
  report=await saveReport({root,reportId:'research-report',ownerId:p.id,markdown,analysisPaths:refs.analysisPaths,rawPaths:refs.rawPaths,runIds:refs.runIds,decisionPaths:refs.decisionPaths})
  state='completed';event('model-report-published',report);changed();clearTimeout(timer)
  const researchIds=[...participants.values()].filter(v=>v.role==='research').map(v=>v.id)
  await ctx.subagents.drainContinuableChildren(agent,researchIds)
  await instrument.close();event('controlled-shutdown',{remainingAgents:ctx.agents.list().filter(a=>participants.has(a.id)).map(a=>a.id),reason:'Report completed; descendant waits stopped through host child-first drain'});persist();exec.concludeTurn()
  process.stdout.write(`AI4SCIENCE_REPORT=${join(root,report.artifactPath)}\n`)
  return report
 })
 persist()
}
