/** Public execution-engine integration with independent device events and artifact verification. */
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionEngine } from '../../platform/execution.ts'
import { Artifacts } from '../../platform/artifacts.ts'
import type { ProviderOperation } from '../../platform/sdk.ts'
import { laboratoryFixture } from './fixture.ts'
import { openLaboratoryProvider } from './provider.ts'
import { LaboratoryWorld } from './world.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'laboratory-provider-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const scenario = laboratoryFixture(), file = join(root, 'scenario.json'), directory = join(root, 'device')
  writeFileSync(file, JSON.stringify(scenario))
  const adapter = openLaboratoryProvider({ id: 'laboratory', directory, scenarioFile: file })
  cleanups.push(() => adapter.close())
  const world = new LaboratoryWorld(directory, scenario)
  cleanups.push(() => world.close())
  return { root, adapter, world }
}
it('submits, reconciles and exports an aliquot through the existing engine and artifact reader', async () => {
  const { root, adapter, world } = setup()
  const engine = new ExecutionEngine({ directory: join(root, 'execution'), providers: [adapter.provider], pollIntervalMs: 1, providerCallTimeoutMs: 1000 })
  await engine.open(); cleanups.push(() => engine.close())
  engine.createProject('P1', 0)
  const actor = engine.issueContext('P1', 'sample-agent', ['laboratory'])
  const request = { providerId: 'laboratory', requestKey: 'split',
    input: { action: 'aliquot', deviceId: 'liquid', sampleId: 'water', volumeUl: 20, container: 'tube' } }
  const accepted = await engine.submit(actor, request)
  expect(accepted.state).toBe('running')
  expect((await engine.submit(actor, request)).id).toBe(accepted.id)
  expect((await engine.query(actor, accepted.id)).state).toBe('running')
  expect(world.observe().tick).toBe(0)
  world.advance(); world.advance()
  const finished = await engine.query(actor, accepted.id)
  expect(finished.state).toBe('succeeded')
  expect(finished.artifacts).toHaveLength(1)
  const artifact = new Artifacts(engine).read(actor, finished.artifacts[0]!.id)
  expect(JSON.parse(artifact.content)).toMatchObject({ operation: { outputSampleId: `sample:${accepted.id}`, consumedUl: 20 } })
  expect(world.observe().samples[0]!.volumeUl).toBe(80)
  expect(world.events(0).filter(event => event.kind === 'operation-accepted')).toHaveLength(1)
})
it('retains stage effects on cancellation and rejects identity changes and tampered output', async () => {
  const { root, adapter, world } = setup()
  const operation: ProviderOperation = { operationId: 'one', projectId: 'P1',
    input: { action: 'aliquot', deviceId: 'liquid', sampleId: 'water', volumeUl: 20, container: 'tube' },
    artifactDirectory: join(root, 'execution', 'artifacts', 'one') }
  await adapter.provider.submit(operation); world.advance()
  expect(await adapter.provider.cancel(operation)).toMatchObject({ disposition: 'requested', observation: { state: 'cancelled', progress: { consumedUl: 20 } } })
  expect(world.observe().samples[0]!.volumeUl).toBe(80)
  await expect(adapter.provider.query({ ...operation, projectId: 'foreign' })).rejects.toThrow('identity')
  const next = { ...operation, operationId: 'two', artifactDirectory: join(root, 'execution', 'artifacts', 'two') }
  await adapter.provider.submit(next); world.advance(); world.advance()
  expect((await adapter.provider.query(next)).state).toBe('succeeded')
  const path = join(next.artifactDirectory, 'result.json'), original = readFileSync(path, 'utf8')
  writeFileSync(path, 'tampered')
  await expect(adapter.provider.query(next)).rejects.toThrow('result changed')
  writeFileSync(path, original)
  await expect(adapter.provider.submit({ ...next, operationId: 'three', artifactDirectory: join(root, 'foreign', 'artifacts', 'three') })).rejects.toThrow('another execution domain')
})
it('records a post-admission sample refusal without executing foreign project work', async () => {
  const { root, adapter, world } = setup()
  const operation: ProviderOperation = { operationId: 'foreign', projectId: 'P2',
    input: { action: 'aliquot', deviceId: 'liquid', sampleId: 'water', volumeUl: 20, container: 'tube' },
    artifactDirectory: join(root, 'execution', 'artifacts', 'foreign') }
  expect((await adapter.provider.submit(operation)).state).toBe('failed')
  expect((await adapter.provider.query(operation)).state).toBe('failed')
  expect(world.observe().samples[0]!.volumeUl).toBe(100)
  expect(world.events(0).some(event => event.kind === 'operation-processing')).toBe(false)
})
