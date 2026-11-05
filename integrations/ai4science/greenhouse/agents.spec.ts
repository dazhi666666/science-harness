/** Native Harness actors drive all actions through real tools; only model responses are scripted. */
import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { toolCallResponse, textResponse, maxTokensResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { boot, execute, stored, Gate, type Probe } from '../platform/organization-fixture.ts'
import { scenarioSchema, type Chamber } from './schema.ts'
import * as Agents from './agents.ts'
import { mountMultiAgent } from './agents.ts'

const probes: Probe[] = []
afterEach(async () => { for (const p of probes.splice(0)) await p.close() })
const toolResult = (options: GenerateOptions) => {
  const message = options.messages.findLast(message => message.role === 'tool')
  if (message?.role !== 'tool') return undefined
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
  return { callId: String(message.toolCallId), error: !!message.isError, text }
}

/** Script decisions read only actual rendered tool results, including mailbox-carried cross-branch assay IDs. */
function worker(chamber: Chamber, channel: 'mail' | 'records' | 'analysis-records' | 'late' | 'late-analysis-records' = 'mail',
  referenceOracle?: () => string | undefined, onAssay?: (id: string) => void, onLateRead?: () => void) {
  let ordinal = 0, consumed = '', lastName = '', lastArgs: Record<string, unknown> = {}, after = 0
  let assignment: string | undefined, operation: string | undefined, retry: { name: string; args: Record<string, unknown> } | undefined
  let sampled = 0, sampleId: string | undefined, watered = chamber !== 'B', lit = chamber !== 'A'
  let analysis: string | undefined, completed = false, shared = false, inboxChecked = false
  let prematureStop = false
  let lateRead = false
  const assays: string[] = [], references: string[] = []
  const task = chamber === 'A' ? 'light-A' : chamber === 'B' ? 'water-B' : 'reference-C'
  const call = (name: string, args: Record<string, unknown>): StreamChunk[] => {
    lastName = name; lastArgs = args
    return toolCallResponse(`${chamber}-${++ordinal}`, name, args)
  }
  return (options: GenerateOptions): StreamChunk[] => {
    const result = toolResult(options)
    if (result && result.callId !== consumed) {
      consumed = result.callId
      if (result.error) {
        if (!/Resource busy/i.test(result.text)) throw new Error(`${chamber}: ${lastName}: ${result.text}`)
        retry = { name: lastName, args: lastArgs }
        return call('greenhouse_observe', {})
      }
      const value = JSON.parse(result.text)
      if (lastName === 'greenhouse_history') {
        const reference = z.object({ operations: z.array(z.object({ id: z.string(), state: z.string(),
          input: z.object({ action: z.string() }).passthrough() })) }).parse(value).operations
          .find(entry => entry.state === 'succeeded' && entry.input.action === (channel.includes('analysis-records') ? 'analyze' : 'assay'))
        if (reference) return call('greenhouse_result', { operation_id: reference.id })
        return call('greenhouse_observe', {})
      }
      if (lastName === 'greenhouse_observe') {
        after = value.events.at(-1)?.seq ?? after
        if (operation && !value.activeOperations.some((active: { id: string }) => active.id === operation))
          return call('greenhouse_result', { operation_id: operation })
        return call('greenhouse_wait', { after_seq: after, ...(operation ? { operation_id: operation } : {}) })
      }
      if (lastName === 'greenhouse_wait') {
        after = value.last_seq
        if (retry) { const pending = retry; retry = undefined; return call(pending.name, pending.args) }
        if (operation) return call('greenhouse_result', { operation_id: operation })
        inboxChecked = false
      }
      if (lastName === 'lab_inbox') {
        inboxChecked = true
        for (const message of value) {
          if (message.from === 'lead' && message.task_id) assignment = message.task_id
          if (message.from === 'chamber-B') {
            const data = JSON.parse(message.content)
            references.push(...z.array(z.string()).parse(data.assayIds))
          }
        }
      }
      if (lastName.startsWith('greenhouse_') && !['greenhouse_result', 'greenhouse_wait', 'greenhouse_observe'].includes(lastName)) {
        operation = value.id
        return call('greenhouse_result', { operation_id: operation })
      }
      if (lastName === 'greenhouse_result') {
        const current = value.operation
        if (current.state !== 'succeeded') {
          if (current.state !== 'running' && current.state !== 'accepted') throw new Error(`Unexpected device state ${current.state}`)
          return call('greenhouse_observe', {})
        }
        operation = undefined
        const command = current.input, output = value.outputs[0].data.result
        if (command.action === 'water') watered = true
        if (command.action === 'light') lit = true
        if (command.action === 'sample') { sampleId = output.sampleId; sampled++ }
        if (command.action === 'assay') {
          if (output.taskId === task) { assays.push(output.id); sampleId = undefined; onAssay?.(output.id) }
          else { references.push(output.id); if (completed) { lateRead = true; onLateRead?.() } }
        }
        if (command.action === 'analyze') {
          if (command.taskId === task) analysis = current.id
          else {
            references.push(...z.array(z.string()).parse(output.assayIds))
            if (completed) { lateRead = true; onLateRead?.() }
          }
        }
      }
      if (lastName === 'lab_complete') completed = true
      if (lastName === 'lab_message') shared = true
    }
    if (!assignment) {
      if (!inboxChecked) return call('lab_inbox', {})
      return call('greenhouse_observe', {})
    }
    if (chamber === 'A' && !prematureStop) {
      prematureStop = true
      return maxTokensResponse('Assigned but trying to stop before the first device action.')
    }
    if (!lit) return call('greenhouse_light', { chamber, level: 0.7, requestKey: `${chamber}-light` })
    if (!watered) return call('greenhouse_water', { chamber, litres: 2, requestKey: `${chamber}-water` })
    if (sampleId) return call('greenhouse_assay', { sampleId, requestKey: `${chamber}-assay-${sampled}` })
    if (sampled < 2) return call('greenhouse_sample', { chamber, taskId: task, requestKey: `${chamber}-sample-${sampled + 1}` })
    if (chamber === 'C' && !references.length) {
      if (channel === 'records' || channel === 'analysis-records') return call('greenhouse_history', { task_id: 'water-B' })
      // Negative control: C receives this actual ID outside its logged model input.
      const hiddenReference = channel.startsWith('late') ? referenceOracle?.() : undefined
      if (hiddenReference) references.push(hiddenReference)
      else {
        if (!inboxChecked) return call('lab_inbox', {})
        inboxChecked = false
        return call('greenhouse_observe', {})
      }
    }
    if (!analysis) return call('greenhouse_analyze', { taskId: task, assayIds: [...assays, ...references], requestKey: `${chamber}-analysis` })
    if (!completed) return call('lab_complete', { task_id: assignment, operation_id: analysis })
    if (chamber === 'B' && channel === 'mail' && !shared) return call('lab_message', { to: 'chamber-C', content: JSON.stringify({ assayIds: assays }) })
    if (chamber === 'C' && !lateRead) {
      if (channel === 'late') return call('greenhouse_result', { operation_id: references[0]!.slice('assay:'.length) })
      if (channel === 'late-analysis-records') return call('greenhouse_history', { task_id: 'water-B' })
    }
    return textResponse(`${chamber}: real execution completed and accounted for.`)
  }
}

it.each((['mail', 'records', 'analysis-records', 'late', 'late-analysis-records'] as const).flatMap(channel => (['timer', 'event-driven'] as const).map(clockMode => ({ channel, clockMode }))))('validates reference input through $channel with $clockMode and reports communication separately', async ({ channel, clockMode }) => {
  const p = await boot('greenhouse-native-multi', true, async () => ({ withoutScience: true }))
  probes.push(p)
  const scenario = scenarioSchema.parse(JSON.parse(readFileSync(new URL('./scenario.json', import.meta.url), 'utf8')))
  scenario.events = []; scenario.tickMs = 10
  const scenarioFile = join(p.root, 'scenario.json'); writeFileSync(scenarioFile, JSON.stringify(scenario))
  let leadCalls = 0
  const ownerStep = (options: GenerateOptions): StreamChunk[] => {
    p.model.queue('lead', ownerStep)
    const result = toolResult(options)
    if (result?.callId.startsWith('lead-observe-'))
      return toolCallResponse(`lead-wait-${++leadCalls}`, 'greenhouse_wait', { after_seq: JSON.parse(result.text).eventCursor })
    return result?.callId.startsWith('lead-inbox-')
      ? toolCallResponse(`lead-observe-${++leadCalls}`, 'greenhouse_observe', {})
      : toolCallResponse(`lead-inbox-${++leadCalls}`, 'lab_inbox', {})
  }
  p.model.queue('lead',
    toolCallResponse('assign-A', 'lab_assign', { assignee: 'chamber-A', experiment_task: 'light-A' }),
    toolCallResponse('assign-B', 'lab_assign', { assignee: 'chamber-B', experiment_task: 'water-B' }),
    toolCallResponse('assign-C', 'lab_assign', { assignee: 'chamber-C', experiment_task: 'reference-C' }),
    ownerStep)
  let observedBReference: string | undefined, lateReferenceRead = false
  for (const chamber of ['A', 'B', 'C'] as const) {
    const step = worker(chamber, channel, () => observedBReference,
      id => { if (chamber === 'B') observedBReference ??= id }, () => { lateReferenceRead = true })
    p.model.queue(`chamber-${chamber}`, ...Array.from({ length: 150 }, () => step))
  }
  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation(value => lines.push(String(value)))
  try { await p.ctx.plugin(Agents, { directory: join(p.root, 'run'), scenarioFile, project: 'cross-branch-project',
    port: 0, refreshMs: 100, providerCallTimeoutMs: 1000, source: 'scripted', clockMode, model: { provider: 'teams-probe', model: 'script' } }) }
  finally { log.mockRestore() }
  const launch = new URL(lines.find(line => line.startsWith('Mission Control: '))!.slice('Mission Control: '.length))
  const headers = { Authorization: `Bearer ${launch.hash.slice(1)}` }
  let latest: { experiment: { tasks: { status: string; result: string }[]; members: { name: string; id: string; parentId: string | null }[];
    messages: { from: string; to: string; content: string; read: boolean; delivery: { status: string } }[]; source: string; metrics: { requests: number } }; world: { completedTasks: string[] } }
  await vi.waitFor(async () => {
    latest = await (await fetch(`${launch.origin}/mc/greenhouse`, { headers })).json()
    expect(latest.experiment.tasks.map(task => task.status)).toEqual(['done', 'done', 'done'])
  }, { timeout: 15000, interval: 30 })
  expect(latest!.experiment.source).toBe('scripted')
  expect(latest!.experiment.members).toHaveLength(4)
  const lead = latest!.experiment.members.find(member => member.name === 'lead')!
  expect(latest!.experiment.members.filter(member => member.name !== 'lead').every(member => member.parentId === lead.id)).toBe(true)
  expect(latest!.world.completedTasks.sort()).toEqual(['light-A', 'reference-C', 'water-B'])
  const reference = latest!.experiment.messages.find(message => message.from === 'chamber-B' && message.to === 'chamber-C')
  if (channel === 'mail') {
    expect(reference!.delivery.status).toBe('accepted')
    expect(reference!.read).toBe(true)
  } else expect(reference).toBeUndefined()
  const execution = await (await fetch(`${launch.origin}/science/api/state?project=cross-branch-project`, { headers })).json()
  const operations = z.array(z.object({ state: z.string(), input: z.record(z.string(), z.json()) }).passthrough()).parse(execution.operations)
  const c = operations.find(operation => operation.input.action === 'analyze' && operation.input.taskId === 'reference-C')!
  const b = operations.find(operation => operation.input.action === 'analyze' && operation.input.taskId === 'water-B')!
  const shared = z.object({ assayIds: z.array(z.string()) }).parse(b.input)
  expect(c.state).toBe('succeeded')
  expect(z.array(z.string()).parse(c.input.assayIds).some(id => shared.assayIds.includes(id))).toBe(true)
  for (const member of latest!.experiment.members.filter(member => member.name !== 'lead')) {
    const session = await stored(p, SessionId(member.id))
    expect(session.header.parentSession).toBe(lead.id)
    if (member.name === 'chamber-A') expect(session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'greenhouse-coordination'
      && event.data.content.some(block => block.type === 'text' && block.text.includes('pendingAssignments')))).toBe(true)
  }
  expect(shared.assayIds).toHaveLength(2)
  expect(latest!.experiment.metrics.requests).toBeGreaterThan(0)
  await vi.waitFor(async () => {
    latest = await (await fetch(`${launch.origin}/mc/greenhouse`, { headers })).json()
    const notices = latest.experiment.messages.filter(message => message.to === 'lead')
    expect(notices).toHaveLength(3)
    expect(notices.every(message => message.read)).toBe(true)
  })
  const verify = () => spawnSync('python3', [fileURLToPath(new URL('./verify.py', import.meta.url)),
    join(p.root, 'run'), '--sessions', join(p.root, 'sessions')], { encoding: 'utf8' })
  if (channel.startsWith('late')) await vi.waitFor(() => { expect(lateReferenceRead).toBe(true) })
  await p.ctx.sessionPersistence.flush()
  const verified = verify()
  expect(verified.status, verified.stdout + verified.stderr).toBe(channel.startsWith('late') ? 1 : 0)
  const verification = JSON.parse(verified.stdout)
  expect(verification).toMatchObject({ success: !channel.startsWith('late'), modelSources: ['scripted'], architectureAdvantage: 'not-assessed',
    directPeerReferenceBeforeEveryAnalysis: channel === 'mail' })
  expect(verification.referenceEvidence[0]).toMatchObject({ referenceInputObserved: !channel.startsWith('late'),
    peerMessageBeforeAnalysis: channel === 'mail', sharedResultReadBeforeAnalysis: channel === 'records' || channel === 'analysis-records' })
  if (channel.startsWith('late')) expect(verification.checks.filter((check: { passed: boolean }) => !check.passed))
    .toEqual([{ name: 'reference_evidence_used_in_actual_analysis', passed: false }])
  const boardPath = join(p.root, 'run', 'router', 'board.json')
  const originalBoard = readFileSync(boardPath, 'utf8')
  if (channel === 'mail') try {
    const board = JSON.parse(originalBoard)
    const message = board.messages.find((entry: { from: string; to: string }) => entry.from === 'chamber-B' && entry.to === 'chamber-C')
    message.content = `Use these actual B assay references: ${shared.assayIds.join(', ')}`
    writeFileSync(boardPath, JSON.stringify(board))
    expect(verify().status).toBe(1)
    message.content = 'No result reference was delivered.'
    writeFileSync(boardPath, JSON.stringify(board))
    const missingReference = JSON.parse(verify().stdout)
    expect(missingReference.checks.find((check: { name: string }) => check.name === 'reference_evidence_used_in_actual_analysis').passed).toBe(false)
  } finally { writeFileSync(boardPath, originalBoard) }
  const dataPath = join(p.root, 'run', 'execution', 'artifacts', latest!.experiment.tasks[0]!.result, 'result.json')
  const bytes = readFileSync(dataPath)
  try {
    writeFileSync(dataPath, 'tampered fixture output')
    const corrupted = verify()
    expect(corrupted.status).toBe(1)
    const report = JSON.parse(corrupted.stdout)
    expect(report.checks.find((check: { name: string }) => check.name === 'artifact_sizes_and_hashes').passed).toBe(false)
  } finally { writeFileSync(dataPath, bytes) }

  const root = p.ctx.agents.get(SessionId(lead.id))!
  const conflict = await execute(p, 'lab_message', { to: 'outside-project', content: 'No external recipient allowed.' }, root)
  expect(conflict.isError).toBe(true)
  const forged = await execute(p, 'lab_complete', { task_id: 'T1', operation_id: latest!.experiment.tasks[0]!.result }, root)
  expect(forged.isError).toBe(true)
  const facts = p.trace.filter(event => event.stage === 'tool/result')
  expect(facts.length).toBeGreaterThan(0)
  p.report.greenhouse = { source: 'scripted', tasks: latest!.experiment.tasks, messages: latest!.experiment.messages }
  if (channel === 'analysis-records') {
    await p.close(); probes.splice(probes.indexOf(p), 1)
    const invalid = spawnSync('python3', ['-c', `
import sys,json,pathlib,shutil
sys.path.insert(0,sys.argv[1])
from verify import verify
root=pathlib.Path(sys.argv[2])
sessions=pathlib.Path(sys.argv[3])
for field in ['taskId','assayIds']:
 copy=root/('invalid-analysis-result-'+field)
 shutil.copytree(sessions,copy)
 changed=0
 for file in copy.rglob('session.v4.jsonl'):
  if file.parent.name!=sys.argv[4]:continue
  rows=[json.loads(line) for line in file.open()]
  calls={e['data']['callId']:e['data']['name'] for e in rows if e['type']=='tool/call'}
  for e in rows:
   if e['type']!='tool/result':continue
   message=e['data']['message']
   if calls.get(message['toolCallId'])!='greenhouse_result' or message.get('isError'):continue
   body=json.loads(''.join(b['text'] for b in message['content'] if b['type']=='text'))
   command=body['operation']['input']
   if command.get('action')!='analyze' or command.get('taskId')!='water-B':continue
   for output in body['outputs']:
    output['data']['result'][field]='mismatched-task' if field=='taskId' else ['assay:unrecorded']
   message['content']=[{'type':'text','text':json.dumps(body)}]
   changed+=1
  file.write_text(''.join(json.dumps(e)+'\\n' for e in rows))
 assert changed>0
 result=verify(root/'run',sessions=copy,offline=True)
 assert not result['success']
 assert not result['referenceEvidence'][0]['referenceInputObserved']
 assert next(c['passed'] for c in result['checks'] if c['name']=='artifact_sizes_and_hashes')
print(json.dumps({'mismatchedAnalysisTaskRejected':True,'mismatchedAnalysisAssayIdsRejected':True}))
`, fileURLToPath(new URL('.', import.meta.url)), p.root, join(p.root, 'sessions'),
    latest!.experiment.members.find(member => member.name === 'chamber-C')!.id], { encoding: 'utf8' })
    expect(invalid.status, invalid.stdout + invalid.stderr).toBe(0)
    expect(JSON.parse(invalid.stdout)).toEqual({ mismatchedAnalysisTaskRejected: true, mismatchedAnalysisAssayIdsRejected: true })
  }
})

it('continues a settled native child on new mail and rejects its obsolete Agent object', async () => {
  const p = await boot('greenhouse-cold-mail', true, async () => ({ withoutScience: true }))
  probes.push(p)
  const scenario = scenarioSchema.parse(JSON.parse(readFileSync(new URL('./scenario.json', import.meta.url), 'utf8')))
  scenario.events = []; scenario.tickMs = 100000
  const scenarioFile = join(p.root, 'scenario.json'); writeFileSync(scenarioFile, JSON.stringify(scenario))
  p.model.queue('lead', new Gate().step())
  for (const chamber of ['A', 'B', 'C']) p.model.queue(`chamber-${chamber}`, textResponse('Ready for assigned work.'))
  const incarnations: import('@deepseek-ai/dsh-agent').Agent[] = []
  p.ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.parentSession) incarnations.push(agent)
  })
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try { await p.ctx.plugin(Agents, { directory: join(p.root, 'run'), scenarioFile, project: 'cross-branch-project',
    port: 0, refreshMs: 100, providerCallTimeoutMs: 1000, source: 'scripted', model: { provider: 'teams-probe', model: 'script' } }) }
  finally { log.mockRestore() }
  await vi.waitFor(() => expect(incarnations).toHaveLength(3))
  const old = incarnations[1]!
  await vi.waitFor(() => expect(p.ctx.agents.get(old.id)).toBeUndefined())
  const root = p.ctx.agents.roots().find(agent => String(agent.id).startsWith('greenhouse-lead-'))!
  p.model.queue('chamber-B', toolCallResponse('read-resume-mail', 'lab_inbox', {}),
    toolCallResponse('reply-after-resume', 'lab_message', { to: 'lead', content: 'Native continuation received the new assignment.' }),
    textResponse('Follow-up accounted for.'))
  const sent = await execute(p, 'lab_message', { to: 'chamber-B', content: 'Follow-up work after your earlier turn settled.' }, root)
  if (sent.isError) throw new Error(sent.error.message)
  await vi.waitFor(() => expect(incarnations.filter(agent => agent.id === old.id)).toHaveLength(2))
  const replacement = incarnations.findLast(agent => agent.id === old.id)!
  expect(replacement).not.toBe(old)
  await vi.waitFor(async () => {
    const status = await execute(p, 'lab_status', {}, root)
    if (status.isError) throw new Error(status.error.message)
    expect(JSON.stringify(status.value)).toContain('Native continuation received the new assignment.')
  })
  const stale = await execute(p, 'lab_message', { to: 'lead', content: 'An expired handle must not send.' }, old)
  expect(stale.isError).toBe(true)
})

it('waits for resource release in program code and notices completed work and queued native mail', async () => {
  const p = await boot('greenhouse-wait-races', true, async () => ({ withoutScience: true }))
  probes.push(p)
  const scenario = scenarioSchema.parse(JSON.parse(readFileSync(new URL('./scenario.json', import.meta.url), 'utf8')))
  scenario.events = []; scenario.tickMs = 100000
  const scenarioFile = join(p.root, 'scenario.json'); writeFileSync(scenarioFile, JSON.stringify(scenario))
  for (const actor of ['lead', 'chamber-A', 'chamber-B', 'chamber-C']) p.model.queue(actor, new Gate().step())
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  let team: Awaited<ReturnType<typeof mountMultiAgent>>
  try { team = await mountMultiAgent(p.ctx, { directory: join(p.root, 'run'), scenarioFile, project: 'cross-branch-project',
    port: 0, refreshMs: 100, providerCallTimeoutMs: 1000, source: 'scripted', model: { provider: 'teams-probe', model: 'script' } }) }
  finally { log.mockRestore() }
  const members = team!.team.snapshot().members
  const a = p.ctx.agents.get(SessionId(members.find(member => member.name === 'chamber-A')!.id))!
  const b = p.ctx.agents.get(SessionId(members.find(member => member.name === 'chamber-B')!.id))!
  const first = await execute(p, 'greenhouse_inspect', { chamber: 'A', requestKey: 'A-inspect' }, a)
  if (first.isError) throw new Error(first.error.message)
  const operation = z.object({ id: z.string() }).passthrough().parse(first.value)
  const second = execute(p, 'greenhouse_inspect', { chamber: 'B', requestKey: 'B-inspect' }, b)
  for (let n = 0; n < scenario.durations.inspect; n++) team!.runtime.world.step()
  const admitted = await second
  expect(admitted.isError).toBe(false)
  expect(team!.runtime.world.audit().jobs.filter(job => job.state === 'running')).toHaveLength(1)
  const after = team!.runtime.world.events(0).at(-1)!.seq
  const futureCursor = await execute(p, 'greenhouse_wait', { after_seq: after + 100 }, a)
  expect(futureCursor.isError).toBe(true)
  if (futureCursor.isError) expect(futureCursor.error.message).toContain(`Current eventCursor is ${after}`)
  const completed = await execute(p, 'greenhouse_wait', { after_seq: after, operation_id: operation.id }, a)
  if (completed.isError) throw new Error(completed.error.message)
  expect(completed.value).toMatchObject({ reason: 'operation', operation_id: operation.id })
  const sent = await execute(p, 'lab_message', { to: 'chamber-A', content: 'Mailbox work must be visible even after native admission.' }, team!.root)
  expect(sent.isError).toBe(false)
  const mail = await execute(p, 'greenhouse_wait', { after_seq: after }, a)
  if (mail.isError) throw new Error(mail.error.message)
  expect(mail.value).toMatchObject({ reason: 'inbox' })
  const denied = await execute(p, 'greenhouse_water', { chamber: 'B', litres: 1, requestKey: 'wrong-chamber' }, a)
  expect(denied.isError).toBe(true)
  const beforeLeadAction = team!.runtime.world.audit()
  const leadAction = await execute(p, 'greenhouse_light', { chamber: 'A', level: 0.5, requestKey: 'lead-must-coordinate' }, team!.root)
  expect(leadAction.isError).toBe(true)
  expect(team!.runtime.world.audit()).toEqual(beforeLeadAction)
  const control = new AbortController()
  const waiting = p.ctx.tools.execute({ name: 'greenhouse_wait', arguments: { after_seq: after }, agent: b,
    callId: (await import('@deepseek-ai/dsh-llm')).ToolCallId('cancel-program-wait'), signal: control.signal })
  control.abort(new Error('Test owner cancelled the pending wait'))
  expect((await waiting).isError).toBe(true)
})
