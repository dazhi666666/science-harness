/** Real Harness participants and Router receipts verify laboratory collaboration and authority. */
import { afterEach, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boot, execute, Gate, stored, type Probe } from '../../platform/organization-fixture.ts'
import { toolCallResponse, textResponse } from '../../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { mountLaboratoryAgents } from './agents.ts'
import { laboratoryFixture } from './fixture.ts'
const probes: Probe[] = []
afterEach(async () => { for (const probe of probes.splice(0)) await probe.close() })
async function setup(mode: 'single-agent' | 'multi-agent') {
  const probe = await boot(`laboratory-native-${mode}`, true, async () => ({ withoutScience: true })); probes.push(probe)
  const scenario = laboratoryFixture()
  scenario.samples[0]!.location = 'heater'
  scenario.methods.push({ ...scenario.methods.find(method => method.id === 'prepare')!, version: 2 })
  scenario.revisions.push({ id: 'method-update', tick: 30, kind: 'method', methodId: 'prepare', version: 2 })
  scenario.tasks.push({ id: 'prepare-water', title: 'Prepare water', projectId: 'P1', methodId: 'prepare', methodVersion: 1,
    rootSampleIds: ['water'], requiredResults: 1, prerequisites: [], releaseTick: 0 })
  const scenarioFile = join(probe.root, 'scenario-lab.json'); writeFileSync(scenarioFile, JSON.stringify(scenario))
  for (const role of ['lead', 'facilities', 'experiments', 'quality']) probe.model.queue(role, new Gate().step())
  const mounted = await mountLaboratoryAgents(probe.ctx, { directory: join(probe.root, 'laboratory'), scenarioFile, seed: 1,
    project: 'cross-branch-project', mode, source: 'scripted', providerPool: ['teams-probe'], model: { provider: 'teams-probe', model: 'fixture' },
    port: 0, refreshMs: 100, providerCallTimeoutMs: 1000 })
  const actor = (role: string) => {
    const member = mounted.team.snapshot().members.find(member => member.name === role)!
    return probe.ctx.agents.get(member.id)!
  }
  const call = async (agent: Agent, name: string, args: unknown) => {
    const result = await execute(probe, name, args, agent)
    if (result.isError) throw new Error(JSON.stringify(result.error))
    return z.record(z.string(), z.unknown()).parse(result.value)
  }
  return { probe, ...mounted, actor, call }
}
it('registers one native coordinator and three specialist children and delivers peer mail through the native parent', async () => {
  const team = await setup('multi-agent')
  const members = team.team.snapshot().members
  expect(members.map(member => member.name)).toEqual(['lead', 'facilities', 'experiments', 'quality'])
  expect(members.slice(1).every(member => member.parentId === team.root.id)).toBe(true)
  const assigned = await team.call(team.root, 'lab_assign', { assignee: 'experiments', experiment_task: 'prepare-water' })
  expect(assigned.task).toMatchObject({ assignee: 'experiments', title: 'prepare-water', status: 'in_progress' })
  const sent = await team.call(team.actor('quality'), 'lab_message', { to: 'experiments', content: 'Use actual current preparation method; retain the original sample.' })
  expect(sent.from).toBe('quality')
  const inbox = await execute(team.probe, 'lab_inbox', {}, team.actor('experiments'))
  expect(inbox.isError).toBe(false)
  expect(z.array(z.object({ from: z.string(), content: z.string() })).parse(inbox.value).some(message => message.from === 'quality')).toBe(true)
  const snapshot = team.team.snapshot()
  expect(snapshot.messages.every(message => message.delivery.status === 'accepted')).toBe(true)
  const history = await stored(team.probe, team.actor('experiments').id)
  expect(JSON.stringify(history.events)).toContain('Use actual current preparation method')
  await expect(team.call(team.root, 'laboratory_process', { project_id: 'P1', requestKey: 'denied', deviceId: 'heater', sampleId: 'water', volumeUl: 20, methodId: 'prepare', methodVersion: 1 })).rejects.toThrow('unknown tool')
  await expect(team.call(team.actor('quality'), 'lab_message', { to: 'outside', content: 'invalid' })).rejects.toThrow('registered project member')
})
it('returns and acknowledges accepted Router mail when a native member waits', async () => {
  const team = await setup('multi-agent')
  const worker = team.actor('experiments')
  await team.call(team.actor('quality'), 'lab_message', { to: 'experiments', content: 'Retain the current water sample for confirmation.' })
  expect(team.team.hasUnread(worker)).toBe(true)
  const tick = team.runtime.world.observe().tick
  const waited = await team.call(worker, 'laboratory_wait', { after_seq: team.runtime.world.eventCursor() })
  expect(waited).toMatchObject({ reason: 'inbox', mail: [{ from: 'quality', content: 'Retain the current water sample for confirmation.' }] })
  expect(team.team.hasUnread(worker)).toBe(false)
  expect(team.team.snapshot().messages.at(-1)!.read).toBe(true)
  expect(team.runtime.world.observe().tick).toBe(tick)
})

it('closes only an actual delivered phase and reopens its Router task after a method revision', async () => {
  const team = await setup('multi-agent')
  const assigned = await team.call(team.root, 'lab_assign', { assignee: 'experiments', experiment_task: 'prepare-water' })
  const taskId = z.object({ id: z.string() }).parse(assigned.task).id
  const worker = team.actor('experiments')
  await expect(team.call(worker, 'lab_complete', { task_id: taskId })).rejects.toThrow('currently valid')
  const operation = await team.call(worker, 'laboratory_process', { project_id: 'P1', requestKey: 'prepare', deviceId: 'heater', sampleId: 'water', volumeUl: 20, methodId: 'prepare', methodVersion: 1 })
  // The scripted adapter holds model generation. Explicit device events isolate the collaboration check.
  while (team.runtime.world.operation(z.string().parse(operation.id))!.state === 'running') team.runtime.world.advance()
  await team.call(worker, 'laboratory_result', { project_id: 'P1', operation_id: operation.id })
  await team.call(worker, 'laboratory_deliver', { project_id: 'P1', task_id: 'prepare-water', result_ids: [`result:${operation.id}`] })
  expect(await team.call(worker, 'lab_complete', { task_id: taskId })).toMatchObject({ task: { status: 'done' }, delivery: { valid: true } })
  await expect(team.call(team.actor('quality'), 'lab_complete', { task_id: taskId })).rejects.toThrow('assignee')
  const messages = team.team.snapshot().messages
  expect(messages.some(message => message.to === 'lead' && message.content.includes(`result:${operation.id}`))).toBe(true)
  const clean = await team.call(worker, 'laboratory_clean', { project_id: 'P1', requestKey: 'clean-again', deviceId: 'heater' })
  while (team.runtime.world.operation(z.string().parse(clean.id))!.state === 'running') team.runtime.world.advance()
  const replacement = await team.call(worker, 'laboratory_process', { project_id: 'P1', requestKey: 'replacement', deviceId: 'heater', sampleId: 'water', volumeUl: 20, methodId: 'prepare', methodVersion: 1 })
  while (team.runtime.world.operation(z.string().parse(replacement.id))!.state === 'running') team.runtime.world.advance()
  await team.call(worker, 'laboratory_result', { project_id: 'P1', operation_id: replacement.id })
  await team.call(worker, 'laboratory_deliver', { project_id: 'P1', task_id: 'prepare-water', result_ids: [`result:${replacement.id}`] })
  expect(team.team.snapshot().tasks.find(task => task.id === taskId)!.status).toBe('in_progress')
  const updated = await team.call(worker, 'lab_complete', { task_id: taskId })
  expect(updated.delivery).toMatchObject({ resultIds: [`result:${replacement.id}`] })
  expect(JSON.parse(team.team.snapshot().tasks.find(task => task.id === taskId)!.result!).resultIds).toEqual([`result:${replacement.id}`])
  expect(team.runtime.world.advance()).toBe(30)
  expect(team.team.snapshot().tasks.find(task => task.id === taskId)).toMatchObject({ status: 'in_progress' })
  expect(JSON.parse(team.team.snapshot().tasks.find(task => task.id === taskId)!.spec).methodVersion).toBe(2)
  await team.close()
  expect(team.runtime.clock.status().disposed).toBe(true)
})
it('allows Single to self-assign and use the same physical tools without creating child members', async () => {
  const team = await setup('single-agent')
  const multi = await setup('multi-agent')
  const physicalTools = (roles: typeof team.org.config.roles) => [...new Set(Object.values(roles).flatMap(role => role.tools)
    .filter(tool => tool.startsWith('laboratory_')))].sort()
  expect(physicalTools(team.org.config.roles)).toEqual(physicalTools(multi.org.config.roles))
  expect(team.team.snapshot().members).toHaveLength(1)
  const assigned = await team.call(team.root, 'lab_assign', { assignee: 'lead', experiment_task: 'prepare-water' })
  expect(assigned.task).toMatchObject({ assignee: 'lead', status: 'in_progress' })
  expect(team.team.snapshot().messages).toEqual([])
  const operation = await team.call(team.root, 'laboratory_process', { project_id: 'P1', requestKey: 'single-prepare', deviceId: 'heater', sampleId: 'water', volumeUl: 20, methodId: 'prepare', methodVersion: 1 })
  expect(operation.state).toBe('running')
  const independent = await team.call(team.root, 'laboratory_clean', { project_id: 'P1', requestKey: 'single-independent-clean', deviceId: 'screen' })
  expect(independent.state).toBe('running')
  expect(team.runtime.world.observe().tick).toBe(0)
  expect(team.runtime.world.observe().operations.filter(operation => operation.state === 'running')).toHaveLength(2)
  expect(team.metrics.requests).toBeGreaterThan(0)
  await expect(team.call(team.root, 'lab_assign', { assignee: 'experiments', experiment_task: 'prepare-water' })).rejects.toThrow('registered')
})

it('lets a scripted native Single complete the physical phase using actual tool replies and event waits', async () => {
  const probe = await boot('laboratory-single-native-loop', true, async () => ({ withoutScience: true })); probes.push(probe)
  const config = laboratoryFixture(); config.samples[0]!.location = 'heater'
  config.tasks.push({ id: 'prepare-water', title: 'Prepare water', projectId: 'P1', methodId: 'prepare', methodVersion: 1,
    rootSampleIds: ['water'], requiredResults: 1, prerequisites: [], releaseTick: 0 })
  const scenarioFile = join(probe.root, 'native-loop-scenario.json'); writeFileSync(scenarioFile, JSON.stringify(config))
  let phase = 'start', ordinal = 0, routerTask = '', operation = '', resultId = '', cursor = 0
  const script = (options: import('@deepseek-ai/dsh-llm').GenerateOptions): import('@deepseek-ai/dsh-llm').StreamChunk[] => {
    const message = options.messages.findLast(value => value.role === 'tool')
    const raw = message?.content.filter(value => value.type === 'text').map(value => value.text).join('')
    if (message?.role === 'tool' && message.isError) throw new Error(raw)
    const value = raw ? JSON.parse(raw) : undefined
    const call = (name: string, args: Record<string, unknown>) => {
      probe.model.queue('lead', script)
      return toolCallResponse(`single-${++ordinal}`, name, args)
    }
    if (phase === 'start') { phase = 'assigned'; return call('lab_assign', { assignee: 'lead', experiment_task: 'prepare-water' }) }
    if (phase === 'assigned') {
      routerTask = value.task.id; phase = 'accepted'
      return call('laboratory_process', { project_id: 'P1', requestKey: 'single-native-prepare', deviceId: 'heater', sampleId: 'water', volumeUl: 20, methodId: 'prepare', methodVersion: 1 })
    }
    if (phase === 'accepted') { operation = value.id; phase = 'result'; return call('laboratory_result', { project_id: 'P1', operation_id: operation }) }
    if (phase === 'result') {
      if (value.operation.state !== 'succeeded') { phase = 'observe'; return call('laboratory_observe', {}) }
      resultId = value.outputs[0].data.result.id; phase = 'delivered'
      return call('laboratory_deliver', { project_id: 'P1', task_id: 'prepare-water', result_ids: [resultId] })
    }
    if (phase === 'observe') { cursor = value.eventCursor; phase = 'wait'; return call('laboratory_wait', { after_seq: cursor, project_id: 'P1', operation_id: operation }) }
    if (phase === 'wait') { phase = 'result'; return call('laboratory_result', { project_id: 'P1', operation_id: operation }) }
    if (phase === 'delivered') { phase = 'done'; return call('lab_complete', { task_id: routerTask }) }
    return textResponse('Physical phase delivered.')
  }
  probe.model.queue('lead', script)
  const team = await mountLaboratoryAgents(probe.ctx, { directory: join(probe.root, 'run'), scenarioFile, seed: 1,
    project: 'cross-branch-project', mode: 'single-agent', source: 'scripted', providerPool: ['teams-probe'],
    model: { provider: 'teams-probe', model: 'fixture' }, port: 0, refreshMs: 100, providerCallTimeoutMs: 1000 })
  await vi.waitFor(() => expect(team.team.snapshot().tasks[0]?.status).toBe('done'), { timeout: 10000 })
  expect(team.runtime.world.observe().deliveries).toEqual([{ taskId: 'prepare-water', resultIds: [resultId], tick: 4, valid: true }])
  expect(team.runtime.world.observe().samples.find(sample => sample.id === 'water')!.volumeUl).toBe(80)
  expect(team.team.snapshot().messages).toEqual([])
  const history = await stored(probe, team.root.id)
  expect(JSON.stringify(history.events)).toContain(resultId)
  await team.close()
})

it('delivers a committed method revision into actual native inputs after a logical clock advance', async () => {
  const probe = await boot('laboratory-event-native-delivery', true, async () => ({ withoutScience: true })); probes.push(probe)
  const scenario = laboratoryFixture()
  scenario.methods.push({ ...scenario.methods.find(method => method.id === 'prepare')!, version: 2 })
  scenario.revisions.push({ id: 'visible-update', tick: 2, kind: 'method', methodId: 'prepare', version: 2 })
  scenario.samples[0]!.expiresAt = 10
  const scenarioFile = join(probe.root, 'event-scenario.json'); writeFileSync(scenarioFile, JSON.stringify(scenario))
  const team = await mountLaboratoryAgents(probe.ctx, { directory: join(probe.root, 'run'), scenarioFile, seed: 1,
    project: 'cross-branch-project', mode: 'multi-agent', source: 'scripted', providerPool: ['teams-probe'],
    model: { provider: 'teams-probe', model: 'fixture' }, port: 0, refreshMs: 100, providerCallTimeoutMs: 1000 })
  await vi.waitFor(() => {
    const messages = team.team.snapshot().messages.filter(message => message.content.includes('method-revised'))
    expect(messages.map(message => message.to).sort()).toEqual(['lead', 'quality'])
    expect(messages.every(message => message.delivery.status === 'accepted')).toBe(true)
  })
  const notifications = team.team.snapshot().messages.filter(message => message.content.includes('method-revised'))
  expect(notifications.map(message => message.to).sort()).toEqual(['lead', 'quality'])
  expect(notifications.every(message => message.delivery.status === 'accepted')).toBe(true)
  const quality = team.team.snapshot().members.find(member => member.name === 'quality')!
  await vi.waitFor(async () => expect(JSON.stringify((await stored(probe, quality.id)).events)).toContain('method-revised'))
  expect(team.runtime.world.observe().methods.find(method => method.id === 'prepare')!.version).toBe(2)
  await team.close()
})
