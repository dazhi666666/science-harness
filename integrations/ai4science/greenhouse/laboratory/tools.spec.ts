/** Actual native actors use laboratory tools through the normal tool registry and execution engine. */
import { afterEach, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createOrganization } from '../../platform/organization.ts'
import type { OperationContext } from '../../platform/sdk.ts'
import { boot, execute, type Probe } from '../../platform/organization-fixture.ts'
import { mountLaboratory } from './plugin.ts'
import { laboratoryFixture } from './fixture.ts'
import { installLaboratoryTools, laboratoryTools } from './tools.ts'
const probes: Probe[] = []
afterEach(async () => { for (const probe of probes.splice(0)) await probe.close() })
async function setup(batch = false) {
  const probe = await boot('laboratory-domain-tools', true, async () => ({ withoutScience: true })); probes.push(probe)
  const scenario = laboratoryFixture()
  scenario.tasks.push({ id: 'prepare-water', title: 'Prepare water', projectId: 'P1', methodId: 'prepare', methodVersion: 1,
    rootSampleIds: ['water'], requiredResults: 1, prerequisites: [], releaseTick: 0 })
  if (batch) {
    scenario.samples[0]!.location = 'heater'
    scenario.samples.push({ ...scenario.samples[0]!, id: 'water-2' })
    scenario.devices.find(device => device.id === 'heater')!.maximumBatchSamples = 2
    scenario.tasks[0]!.rootSampleIds = ['water', 'water-2']
    scenario.tasks[0]!.requiredResults = 2
  }
  const scenarioFile = join(probe.root, 'laboratory-scenario.json'); writeFileSync(scenarioFile, JSON.stringify(scenario))
  const runtime = await mountLaboratory(probe.ctx, { directory: join(probe.root, 'lab'), scenarioFile, seed: 1, port: 0, refreshMs: 100, providerCallTimeoutMs: 1000 })
  const org = createOrganization(probe.ctx, { project: 'cross-branch-project', rootRole: 'lead', maxParticipants: 1, maxDepth: 0,
    roles: { lead: { instructions: 'Use actual laboratory tools.', model: { provider: 'teams-probe', model: 'fixture' },
      tools: laboratoryTools, creates: {}, maxInstances: 1 } }, relations: [] })
  const grants = new WeakMap<Agent, Map<string, OperationContext>>()
  installLaboratoryTools(probe.ctx, runtime, (agent, tool) => {
    org.assertActor(agent, tool)
    return { context(projectId) {
      org.assertActor(agent, tool)
      if (!scenario.projects.some(project => project.id === projectId)) throw new Error('Project is outside this laboratory')
      let contexts = grants.get(agent)
      if (!contexts) { contexts = new Map(); grants.set(agent, contexts) }
      let context = contexts.get(projectId)
      if (!context) { context = runtime.engine.issueContext(projectId, agent.id, ['laboratory']); contexts.set(projectId, context) }
      return context
    } }
  }, new AbortController().signal, 10)
  const root = await probe.ctx.agents.create({ sessionId: SessionId('laboratory-tools-root'), agentOptions: { provider: 'teams-probe', model: 'fixture' } })
  org.registerRoot(root.agent, 'Execute the test laboratory project')
  const call = async (name: string, args: unknown) => {
    const result = await execute(probe, name, args, root.agent)
    if (result.isError) throw new Error(JSON.stringify(result.error))
    return z.record(z.string(), z.unknown()).parse(result.value)
  }
  const result = async (operationId: string) => vi.waitFor(async () => {
    const output = await call('laboratory_result', { project_id: 'P1', operation_id: operationId })
    expect(z.object({ state: z.string() }).parse(output.operation).state).toBe('succeeded')
    return output
  })
  return { probe, runtime, root: root.agent, call, result }
}
it('executes physical transfer and preparation, requires verified reading and delivers a real task', async () => {
  const { runtime, call, result } = await setup()
  const observed = await call('laboratory_observe', {})
  expect(observed.tick).toBe(0)
  const moved = await call('laboratory_transfer', { project_id: 'P1', requestKey: 'move', deviceId: 'robot', sampleId: 'water', destination: 'heater' })
  await result(z.string().parse(moved.id))
  const prepared = await call('laboratory_process', { project_id: 'P1', requestKey: 'prepare', deviceId: 'heater', sampleId: 'water', volumeUl: 20, methodId: 'prepare', methodVersion: 1 })
  await vi.waitFor(() => expect(runtime.world.operation(z.string().parse(prepared.id))!.state).toBe('succeeded'))
  const measurement = `result:${prepared.id}`
  await expect(call('laboratory_deliver', { project_id: 'P1', task_id: 'prepare-water', result_ids: [measurement] })).rejects.toThrow('Read every referenced')
  const output = await result(z.string().parse(prepared.id))
  expect(z.array(z.object({ data: z.object({ result: z.object({ id: z.string() }) }) })).parse(output.outputs)[0]!.data.result.id).toBe(measurement)
  expect(await call('laboratory_deliver', { project_id: 'P1', task_id: 'prepare-water', result_ids: [measurement] })).toMatchObject({ valid: true })
  expect(runtime.world.observe().samples.find(sample => sample.id === 'water')!.volumeUl).toBe(80)
  expect((await call('laboratory_history', { project_id: 'P1', device_id: 'heater' })).total).toBe(1)
  const tick = runtime.world.observe().tick
  await call('laboratory_samples', { project_id: 'P1' }); await call('laboratory_catalog', {})
  expect(runtime.world.observe().tick).toBe(tick)
})
it('rejects foreign actors, ungranted projects and invented future cursors', async () => {
  const { probe, call } = await setup()
  const foreign = await probe.ctx.agents.create({ sessionId: SessionId('laboratory-foreign'), agentOptions: { provider: 'teams-probe', model: 'fixture' } })
  const rejected = await execute(probe, 'laboratory_catalog', {}, foreign.agent)
  expect(rejected.isError).toBe(true)
  await expect(call('laboratory_history', { project_id: 'foreign-project' })).rejects.toThrow('outside this laboratory')
  await expect(call('laboratory_wait', { after_seq: 99999 })).rejects.toThrow('ahead of the device log')
})
it('wakes an operation wait from real device events and validates its project grant', async () => {
  const { runtime, call } = await setup()
  const operation = await call('laboratory_aliquot', { project_id: 'P1', requestKey: 'split', deviceId: 'liquid', sampleId: 'water', volumeUl: 20, container: 'tube' })
  const cursor = runtime.world.eventCursor()
  const waited = await call('laboratory_wait', { after_seq: cursor, operation_id: operation.id, project_id: 'P1' })
  expect(['events', 'operation']).toContain(waited.reason)
  await expect(call('laboratory_wait', { after_seq: runtime.world.eventCursor(), operation_id: operation.id, project_id: 'foreign' })).rejects.toThrow('outside this laboratory')
})

it('reads both hash-verified batch measurements before delivering independent sample evidence', async () => {
  const { call, result, runtime } = await setup(true)
  const accepted = await call('laboratory_process', { project_id: 'P1', requestKey: 'batch', deviceId: 'heater', sampleId: 'water',
    additionalSampleIds: ['water-2'], volumeUl: 20, methodId: 'prepare', methodVersion: 1 })
  const output = await result(z.string().parse(accepted.id))
  const records = z.array(z.object({ data: z.object({ results: z.array(z.object({ id: z.string() })) }) })).parse(output.outputs)
  const results = records[0]!.data.results.map(value => value.id)
  expect(results).toHaveLength(2)
  expect(await call('laboratory_deliver', { project_id: 'P1', task_id: 'prepare-water', result_ids: results })).toMatchObject({ valid: true })
  expect((await call('laboratory_history', { project_id: 'P1', sample_id: 'water-2' })).total).toBe(1)
  expect(runtime.world.observe().operations).toHaveLength(1)
})
