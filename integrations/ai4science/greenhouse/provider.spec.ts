/** Actual ExecutionEngine integration, including independent device progress and immutable result export. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionEngine } from '../platform/execution.ts'
import type { OperationRecord, ProviderOperation } from '../platform/sdk.ts'
import { Artifacts } from '../platform/artifacts.ts'
import { openProvider } from './provider.ts'
import { GreenhouseWorld } from './world.ts'
import { GreenhouseClock } from './clock.ts'
import { scenarioSchema } from './schema.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.useRealTimers()
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'greenhouse-provider-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const scenario = scenarioSchema.parse(JSON.parse(readFileSync(new URL('./scenario.json', import.meta.url), 'utf8')))
  const configPath = join(root, 'scenario.json'); writeFileSync(configPath, JSON.stringify(scenario))
  const device = join(root, 'device')
  const adapter = openProvider({ id: 'greenhouse', directory: device, scenarioFile: configPath })
  cleanups.push(() => adapter.close())
  const world = new GreenhouseWorld(device, scenario)
  cleanups.push(() => world.close())
  return { root, scenario, world, adapter }
}

it('observes independent completion through the standard engine and verifies a real exported artifact', async () => {
  const { root, world, adapter } = setup()
  const engine = new ExecutionEngine({ directory: join(root, 'execution'), providers: [adapter.provider],
    pollIntervalMs: 1, providerCallTimeoutMs: 1000 })
  await engine.open(); cleanups.push(() => engine.close())
  engine.createProject('p', 0)
  const actor = engine.issueContext('p', 'actor', ['greenhouse'])
  const request = { providerId: 'greenhouse', requestKey: 'sample-C',
    input: { action: 'sample', chamber: 'C', taskId: 'reference-C' } }
  const initial = await engine.submit(actor, request)
  expect(initial.state).toBe('running')
  expect((await engine.submit(actor, request)).id).toBe(initial.id)
  expect((await engine.query(actor, initial.id)).state).toBe('running')
  expect(world.observe().tick).toBe(0)
  for (let n = 0; n < world.scenario.durations.sample; n++) world.step()
  expect(world.operation(initial.id)?.state).toBe('succeeded')
  const result = await engine.query(actor, initial.id)
  expect(result.state).toBe('succeeded')
  expect(result.artifacts).toHaveLength(1)
  const data = new Artifacts(engine).read(actor, result.artifacts[0]!.id)
  expect(JSON.parse(data.content)).toMatchObject({ operationId: initial.id, result: { taskId: 'reference-C', chamber: 'C' } })
  expect(world.events(0).filter(event => event.kind === 'operation-started')).toHaveLength(1)
  expect((await engine.submit(actor, request)).id).toBe(initial.id)
})

it('keeps accepted work across controller exit and reconnects without repeating its device action', async () => {
  const { root, world, adapter } = setup()
  const options = { directory: join(root, 'execution'), providers: [adapter.provider], pollIntervalMs: 1, providerCallTimeoutMs: 1000 }
  const first = new ExecutionEngine(options)
  await first.open()
  let accepted: OperationRecord
  try {
    first.createProject('p', 0)
    accepted = await first.submit(first.issueContext('p', 'first-agent', ['greenhouse']), {
      providerId: 'greenhouse', requestKey: 'sample', input: { action: 'sample', chamber: 'C', taskId: 'reference-C' },
    })
  } finally { await first.close() }
  vi.useFakeTimers()
  const clock = new GreenhouseClock(world, error => { throw error })
  try { vi.advanceTimersByTime(world.scenario.tickMs * 6) }
  finally { clock.close(); vi.useRealTimers() }
  const second = new ExecutionEngine(options)
  await second.open(); cleanups.push(() => second.close())
  const context = second.issueContext('p', 'replacement-agent', ['greenhouse'])
  expect(second.get(context, accepted!.id).state).toBe('succeeded')
  const retry = await second.submit(context, { providerId: 'greenhouse', requestKey: 'sample',
    input: { action: 'sample', chamber: 'C', taskId: 'reference-C' } })
  expect(retry.id).toBe(accepted!.id)
  expect(world.events(0).filter(event => event.kind === 'operation-started')).toHaveLength(1)
})

it('does not let idle device state be rebound or queried with another operation identity', async () => {
  const { root, adapter, world } = setup()
  const operation: ProviderOperation = { operationId: 'one', projectId: 'p', input: { action: 'inspect', chamber: 'A' },
    artifactDirectory: join(root, 'domain', 'artifacts', 'one') }
  expect((await adapter.provider.query(operation)).state).toBe('not_found')
  await adapter.provider.submit(operation)
  for (let n = 0; n < world.scenario.durations.inspect; n++) world.step()
  expect((await adapter.provider.query(operation)).state).toBe('succeeded')
  await expect(adapter.provider.query({ ...operation, projectId: 'other' })).rejects.toThrow('identity')
  await expect(adapter.provider.submit({ ...operation, operationId: 'two', artifactDirectory: join(root, 'other-domain', 'artifacts', 'two') }))
    .rejects.toThrow('another execution domain')
  expect(world.events(0).filter(event => event.kind === 'operation-started')).toHaveLength(1)
})

it('confirms simulated cancellation and rejects tampered published results', async () => {
  const { root, world, adapter } = setup()
  const operation: ProviderOperation = { operationId: 'one', projectId: 'p', input: { action: 'inspect', chamber: 'A' },
    artifactDirectory: join(root, 'domain', 'artifacts', 'one') }
  await adapter.provider.submit(operation)
  expect(await adapter.provider.cancel(operation)).toMatchObject({ disposition: 'requested', observation: { state: 'cancelled' } })
  expect(await adapter.provider.cancel(operation)).toMatchObject({ disposition: 'rejected', observation: { state: 'cancelled' } })
  const next = { ...operation, operationId: 'two', artifactDirectory: join(root, 'domain', 'artifacts', 'two') }
  await adapter.provider.submit(next)
  for (let n = 0; n < world.scenario.durations.inspect; n++) world.step()
  await adapter.provider.query(next)
  writeFileSync(join(next.artifactDirectory, 'result.json'), 'changed')
  await expect(adapter.provider.query(next)).rejects.toThrow('output changed')
})

it('settles a known post-admission power refusal and releases the engine reservation', async () => {
  const { root, adapter, world } = setup()
  const original = adapter.provider.prepare.bind(adapter.provider)
  let changePower = true
  vi.spyOn(adapter.provider, 'prepare').mockImplementation(input => {
    const prepared = original(input)
    if (changePower) {
      changePower = false
      for (let n = 0; n < 20; n++) world.step()
    }
    return prepared
  })
  const engine = new ExecutionEngine({ directory: join(root, 'execution'), providers: [adapter.provider],
    pollIntervalMs: 1, providerCallTimeoutMs: 1000 })
  await engine.open(); cleanups.push(() => engine.close())
  engine.createProject('p', 0)
  const actor = engine.issueContext('p', 'actor', ['greenhouse'])
  const rejected = await engine.submit(actor, { providerId: 'greenhouse', requestKey: 'overload',
    input: { action: 'light', chamber: 'A', level: 1 } })
  expect(rejected.state).toBe('failed')
  expect(rejected.detail).toContain('capacity exceeded')
  expect((await engine.query(actor, rejected.id)).state).toBe('failed')
  expect(world.events(0).some(event => event.kind === 'operation-rejected')).toBe(true)
  expect(world.events(0).filter(event => event.kind === 'operation-started')).toHaveLength(0)
  const reduction = await engine.submit(actor, { providerId: 'greenhouse', requestKey: 'reduce',
    input: { action: 'light', chamber: 'A', level: 0.2 } })
  expect(reduction.state).toBe('running')
})
