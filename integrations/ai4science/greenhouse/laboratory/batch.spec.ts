/** Batch operations share one physical cycle while preserving each sample and measurement identity. */
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { laboratoryFixture } from './fixture.ts'
import { LaboratoryWorld } from './world.ts'
import { ExecutionEngine } from '../../platform/execution.ts'
import { Artifacts } from '../../platform/artifacts.ts'
import { openLaboratoryProvider } from './provider.ts'
import type { LaboratoryCommand } from './schema.ts'
import { z } from 'zod'
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
function setup(fault = false) {
  const root = mkdtempSync(join(tmpdir(), 'laboratory-batch-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const scenario = laboratoryFixture()
  const heater = scenario.devices.find(device => device.id === 'heater')!
  heater.maximumBatchSamples = 2; heater.batchMultiple = 2
  scenario.samples[0]!.location = 'heater'
  scenario.samples.push({ ...scenario.samples[0]!, id: 'water-2' })
  scenario.methods.find(method => method.id === 'prepare')!.supplies = [{ kind: 'extraction', units: 1 }]
  scenario.batches.push({ id: 'reagent', kind: 'extraction', units: 4, expiresAt: 1000, disposition: 'available' })
  scenario.tasks.push({ id: 'prepare-two', projectId: 'P1', title: 'Prepare two originals', methodId: 'prepare', methodVersion: 1,
    rootSampleIds: ['water', 'water-2'], requiredResults: 2, prerequisites: [], releaseTick: 0 })
  if (fault) scenario.faults.push({ id: 'heater-fault', tick: 2, deviceId: 'heater' })
  const file = join(root, 'scenario.json'); writeFileSync(file, JSON.stringify(scenario))
  const world = new LaboratoryWorld(join(root, 'device'), scenario); cleanups.push(() => world.close())
  return { root, scenario, file, world }
}
const command = (): LaboratoryCommand => ({ action: 'process', deviceId: 'heater', sampleId: 'water', additionalSampleIds: ['water-2'],
  volumeUl: 20, methodId: 'prepare', methodVersion: 1, consumables: [{ batchId: 'reagent', units: 2 }] })
it('exports both measurements from one real ExecutionEngine operation with distinct lineage and exact consumption', async () => {
  const { root, file, world } = setup()
  const adapter = openLaboratoryProvider({ id: 'laboratory', directory: join(root, 'device'), scenarioFile: file }); cleanups.push(() => adapter.close())
  const engine = new ExecutionEngine({ directory: join(root, 'execution'), providers: [adapter.provider], pollIntervalMs: 1, providerCallTimeoutMs: 1000 })
  await engine.open(); cleanups.push(() => engine.close())
  engine.createProject('P1', 0)
  const actor = engine.issueContext('P1', 'batch-operator', ['laboratory'])
  const accepted = await engine.submit(actor, { providerId: 'laboratory', requestKey: 'batch', input: z.json().parse(command()) })
  expect(accepted.resources).toContain('laboratory:sample:water-2')
  expect(world.advance()).toBe(1)
  expect(world.observe().samples.map(sample => sample.volumeUl)).toEqual([80, 80])
  expect(world.observe().batches[0]!.units).toBe(2)
  expect(world.advance()).toBe(4)
  const finished = await engine.query(actor, accepted.id)
  expect(finished.state).toBe('succeeded')
  const artifact = JSON.parse(new Artifacts(engine).read(actor, finished.artifacts[0]!.id).content)
  expect(artifact.results.map((result: { rootSampleId: string }) => result.rootSampleId)).toEqual(['water', 'water-2'])
  expect(artifact.operation.outputSampleIds).toHaveLength(2)
  expect(artifact.operation.resultIds).toHaveLength(2)
  expect(artifact.operation.consumedUl).toBe(40)
  expect(world.deliver('P1', 'prepare-two', artifact.operation.resultIds).valid).toBe(true)
  expect(world.observe().operations).toHaveLength(1)
  expect(world.observe().samples.reduce((sum, sample) => sum + sample.volumeUl, 0)).toBe(200)
})
it('retains every input deduction after a mid-cycle fault and creates no successful output', () => {
  const { world } = setup(true)
  world.submit('batch', 'P1', 'batch', z.json().parse(command()))
  world.advance(); world.advance()
  expect(world.operation('batch')).toMatchObject({ state: 'failed', consumedUl: 40, consumedBatches: [{ batchId: 'reagent', units: 2 }] })
  expect(world.observe().samples.map(sample => sample.volumeUl)).toEqual([80, 80])
  expect(world.observe().results).toEqual([])
})
it('rejects repeated samples, unbalanced counts, insufficient per-sample volume and underdeclared batch consumables', () => {
  const { world } = setup()
  const valid = command()
  if (valid.action !== 'process') throw new Error('Batch fixture must process samples')
  expect(() => world.prepare('P1', { ...valid, additionalSampleIds: ['water'] })).toThrow('distinct samples')
  expect(() => world.prepare('P1', { ...valid, additionalSampleIds: [] })).toThrow('balancing multiple')
  expect(() => world.prepare('P1', { ...valid, volumeUl: 101 })).toThrow('remaining sample volume')
  expect(() => world.prepare('P1', { ...valid, consumables: [{ batchId: 'reagent', units: 1 }] })).toThrow('Total consumables for 2 input samples')
  expect(world.observe().operations).toEqual([])
  expect(world.observe().samples.map(sample => sample.volumeUl)).toEqual([100, 100])
})
it('reserves all batch inputs against another connection and retains deductions after cancellation', () => {
  const { root, scenario, world } = setup()
  const other = new LaboratoryWorld(join(root, 'device'), scenario); cleanups.push(() => other.close())
  world.submit('batch', 'P1', 'batch', z.json().parse(command()))
  expect(() => other.submit('move', 'P1', 'move', { action: 'transfer', deviceId: 'robot', sampleId: 'water-2', destination: 'cold' })).toThrow('accepted work')
  world.advance()
  expect(world.cancel('batch').consumedUl).toBe(40)
  expect(other.observe().samples.map(sample => sample.volumeUl)).toEqual([80, 80])
})

it('rejects a second batch member with a foreign project or incompatible container before any effects', () => {
  const { root, scenario, world } = setup()
  world.close()
  const otherDirectory = join(root, 'foreign-test')
  scenario.projects.push({ id: 'P2', title: 'Other project' })
  scenario.samples[1]!.projectId = 'P2'
  scenario.tasks = []
  const foreign = new LaboratoryWorld(otherDirectory, scenario); cleanups.push(() => foreign.close())
  expect(() => foreign.submit('batch', 'P1', 'batch', z.json().parse(command()))).toThrow('this project')
  expect(foreign.observe().operations).toEqual([])
  scenario.samples[1]!.projectId = 'P1'
  scenario.samples[1]!.container = 'vial'
  scenario.samples[1]!.location = 'cold'
  scenario.devices.find(device => device.id === 'cold')!.containers.push('vial')
  const incompatible = new LaboratoryWorld(join(root, 'incompatible-test'), scenario); cleanups.push(() => incompatible.close())
  expect(() => incompatible.prepare('P1', command())).toThrow('Container is incompatible')
  expect(incompatible.observe().batches[0]!.units).toBe(4)
})
