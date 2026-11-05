/** Real device histories drive supply recalls, method revisions and cross-project reopening. */
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { laboratoryFixture } from './fixture.ts'
import { LaboratoryWorld } from './world.ts'
import { laboratoryScenarioSchema, type LaboratoryCommand, type LaboratoryScenario } from './schema.ts'

const roots: string[] = [], worlds: LaboratoryWorld[] = []
afterEach(() => {
  for (const world of worlds.splice(0)) world.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function configuration() {
  const config = laboratoryFixture()
  config.batches.push({ id: 'reagent-A', kind: 'extraction', units: 10, expiresAt: 1000, disposition: 'available' })
  config.methods.find(method => method.id === 'prepare')!.supplies = [{ kind: 'extraction', units: 2 }]
  config.tasks.push({ id: 'prepare-water', title: 'Prepare water', projectId: 'P1', methodId: 'prepare', methodVersion: 1,
    rootSampleIds: ['water'], requiredResults: 1, prerequisites: [], releaseTick: 0 },
  { id: 'confirm-water', title: 'Confirm water', projectId: 'P1', methodId: 'confirm', methodVersion: 1,
    rootSampleIds: ['water'], requiredResults: 1, prerequisites: ['prepare-water'], releaseTick: 0 })
  return config
}
function open(config: LaboratoryScenario) {
  const root = mkdtempSync(join(tmpdir(), 'laboratory-projects-')); roots.push(root)
  const world = new LaboratoryWorld(root, config); worlds.push(world)
  return world
}
function run(world: LaboratoryWorld, id: string, command: LaboratoryCommand) {
  if ((command.action === 'process' || command.action === 'aliquot') && world.observe().samples.find(sample => sample.id === command.sampleId)!.location !== command.deviceId)
    run(world, `move:${id}`, { action: 'transfer', deviceId: 'robot', sampleId: command.sampleId, destination: command.deviceId })
  world.submit(id, 'P1', id, command)
  while (world.observe().operations.find(operation => operation.id === id)!.state === 'running') world.advance()
  const result = world.observe().operations.find(operation => operation.id === id)!
  expect(result.state, result.detail).toBe('succeeded')
  return result
}
function prepare(world: LaboratoryWorld) {
  return run(world, 'prepare', { action: 'process', deviceId: 'heater', sampleId: 'water', volumeUl: 30, methodId: 'prepare', methodVersion: 1,
    consumables: [{ batchId: 'reagent-A', units: 2 }] })
}
it('recalls descendant measurements and reopens delivered tasks while preserving original evidence', () => {
  const world = open(configuration()), prepared = prepare(world)
  run(world, 'calibrate', { action: 'calibrate', deviceId: 'confirm' })
  const confirmation = run(world, 'confirm', { action: 'process', deviceId: 'confirm', sampleId: prepared.outputSampleId!, volumeUl: 30, methodId: 'confirm', methodVersion: 1 })
  expect(() => world.deliver('P1', 'confirm-water', [confirmation.resultId!])).toThrow('prerequisites')
  world.deliver('P1', 'prepare-water', [prepared.resultId!])
  world.deliver('P1', 'confirm-water', [confirmation.resultId!])
  const measurements = structuredClone(world.observe().results)
  expect(world.recallBatch('reagent-A', 'supplier-recall')).toEqual(['result:prepare', 'result:confirm'])
  const snapshot = world.observe()
  expect(snapshot.batches[0]!.units).toBe(8)
  expect(snapshot.results).toEqual(measurements)
  expect(snapshot.results.every(result => result.batchIds.includes('reagent-A'))).toBe(true)
  expect(snapshot.deliveries.every(delivery => !delivery.valid)).toBe(true)
  expect(snapshot.samples.find(sample => sample.id === 'water')!.disposition).toBe('available')
  expect(snapshot.samples.find(sample => sample.id === confirmation.outputSampleId)!.disposition).toBe('quarantined')
  expect(() => world.deliver('P1', 'prepare-water', [prepared.resultId!])).toThrow('valid')
  expect(world.events(0).filter(event => event.kind === 'deliveries-withdrawn').at(-1)!.payload).toMatchObject({ taskIds: ['prepare-water', 'confirm-water'] })
})

it('reserves consumables across independent devices and retains deductions after a mid-stage recall', () => {
  const config = configuration()
  config.batches[0]!.units = 2
  config.devices.push({ id: 'heater-2', kind: 'heater', methods: ['prepare'], containers: ['tube'], capacity: 4, powerDraw: 0, waterPerProcessUl: 0, maximumBatchSamples: 1, batchMultiple: 1 })
  config.samples[0]!.location = 'heater'
  config.samples.push({ ...config.samples[0]!, id: 'second', location: 'heater-2' })
  const world = open(config)
  const command: LaboratoryCommand = { action: 'process', deviceId: 'heater', sampleId: 'water', volumeUl: 20, methodId: 'prepare', methodVersion: 1,
    consumables: [{ batchId: 'reagent-A', units: 2 }] }
  world.submit('accepted', 'P1', 'accepted', command)
  expect(() => world.submit('racing', 'P1', 'racing', { ...command, deviceId: 'heater-2', sampleId: 'second' })).toThrow('reserved')
  world.advance()
  world.recallBatch('reagent-A', 'quality-check')
  expect(world.observe().operations[0]).toMatchObject({ state: 'failed', consumedUl: 20, consumedBatches: [{ batchId: 'reagent-A', units: 2 }] })
  expect(world.observe().batches[0]!.units).toBe(0)
  expect(world.observe().samples[0]!.volumeUl).toBe(80)
  expect(world.observe().results).toEqual([])
})

it('revises methods through logical events, preserves completed history and reopens dependent deliveries', () => {
  const config = configuration()
  config.methods.push({ ...config.methods.find(method => method.id === 'prepare')!, version: 2, processingTicks: 4 })
  config.revisions.push({ id: 'new-protocol', tick: 30, kind: 'method', methodId: 'prepare', version: 2 })
  const world = open(config), prepared = prepare(world)
  world.deliver('P1', 'prepare-water', [prepared.resultId!])
  expect(world.observe().methods.find(method => method.id === 'prepare')!.version).toBe(1)
  expect(JSON.stringify(world.observe())).not.toContain('new-protocol')
  const oldResults = structuredClone(world.observe().results)
  expect(world.advance()).toBe(30)
  expect(world.observe().methods.find(method => method.id === 'prepare')!.version).toBe(2)
  expect(world.observe().deliveries[0]!.valid).toBe(false)
  expect(world.observe().results).toEqual(oldResults)
  run(world, 'clean', { action: 'clean', deviceId: 'heater' })
  expect(() => world.submit('obsolete', 'P1', 'obsolete', { action: 'process', deviceId: 'heater', sampleId: 'water', volumeUl: 10,
    methodId: 'prepare', methodVersion: 1, consumables: [{ batchId: 'reagent-A', units: 2 }] })).toThrow('version')
})

it('rejects duplicate roots, wrong project references, cycles and undefined revision targets', () => {
  const config = configuration()
  expect(laboratoryScenarioSchema.safeParse({ ...config, tasks: [{ ...config.tasks[0], requiredResults: 2 }] }).success).toBe(false)
  expect(laboratoryScenarioSchema.safeParse({ ...config, tasks: [{ ...config.tasks[0], prerequisites: ['prepare-water'] }] }).success).toBe(false)
  expect(laboratoryScenarioSchema.safeParse({ ...config, revisions: [{ id: 'bad', tick: 1, kind: 'method', methodId: 'missing', version: 2 }] }).success).toBe(false)
  const world = open(config), prepared = prepare(world)
  expect(() => world.deliver('P1', 'prepare-water', [prepared.resultId!, prepared.resultId!])).toThrow('distinct roots')
  expect(() => world.deliver('P2', 'prepare-water', [prepared.resultId!])).toThrow('current methods')
})

it('releases tasks at logical events and keeps future requests outside Agent observations', () => {
  const config = configuration(); config.tasks[0]!.releaseTick = 12; config.tasks[1]!.releaseTick = 12
  const world = open(config)
  expect(world.observe().tasks).toEqual([])
  expect(world.advance()).toBe(12)
  expect(world.observe().tasks).toHaveLength(2)
  expect(world.events(0).filter(event => event.kind === 'task-released')).toHaveLength(2)
})

it('requires downstream measurements to descend from the newly delivered preparation after a revision', () => {
  const config = configuration()
  config.methods.push({ ...config.methods.find(method => method.id === 'prepare')!, version: 2 })
  config.revisions.push({ id: 'prepare-update', tick: 30, kind: 'method', methodId: 'prepare', version: 2 })
  const world = open(config), oldPreparation = prepare(world)
  run(world, 'cal', { action: 'calibrate', deviceId: 'confirm' })
  const oldConfirmation = run(world, 'old-confirm', { action: 'process', deviceId: 'confirm', sampleId: oldPreparation.outputSampleId!,
    volumeUl: 30, methodId: 'confirm', methodVersion: 1 })
  world.deliver('P1', 'prepare-water', [oldPreparation.resultId!])
  world.deliver('P1', 'confirm-water', [oldConfirmation.resultId!])
  expect(world.advance()).toBe(30)
  expect(world.observe().deliveries.every(delivery => !delivery.valid)).toBe(true)
  run(world, 'clean-heater', { action: 'clean', deviceId: 'heater' })
  const newPreparation = run(world, 'new-prepare', { action: 'process', deviceId: 'heater', sampleId: 'water', volumeUl: 10,
    methodId: 'prepare', methodVersion: 2, consumables: [{ batchId: 'reagent-A', units: 2 }] })
  world.deliver('P1', 'prepare-water', [newPreparation.resultId!])
  expect(() => world.deliver('P1', 'confirm-water', [oldConfirmation.resultId!])).toThrow('current methods')
  run(world, 'archive-old-confirm', { action: 'transfer', deviceId: 'robot', sampleId: oldConfirmation.outputSampleId!, destination: 'cold' })
  run(world, 'clean-confirm', { action: 'clean', deviceId: 'confirm' })
  const newConfirmation = run(world, 'new-confirm', { action: 'process', deviceId: 'confirm', sampleId: newPreparation.outputSampleId!,
    volumeUl: 10, methodId: 'confirm', methodVersion: 1 })
  expect(world.deliver('P1', 'confirm-water', [newConfirmation.resultId!]).valid).toBe(true)
})

it('requires current cross-project measurement references and withdraws downstream delivery after replacement', () => {
  const config = configuration(); config.externalReferences = true
  config.devices.find(device => device.id === 'heater')!.capacity = 8
  config.projects.push({ id: 'P2', title: 'Dependent project' })
  config.samples.push({ ...config.samples[0]!, id: 'foreign-water', projectId: 'P2', location: 'heater' })
  config.tasks.push({ id: 'dependent-prepare', title: 'Dependent preparation', projectId: 'P2', methodId: 'prepare', methodVersion: 1,
    rootSampleIds: ['foreign-water'], requiredResults: 1, prerequisites: ['prepare-water'], releaseTick: 0 })
  const world = open(config), first = prepare(world)
  world.deliver('P1', 'prepare-water', [first.resultId!])
  run(world, 'clean-first', { action: 'clean', deviceId: 'heater' })
  world.submit('dependent', 'P2', 'dependent', { action: 'process', deviceId: 'heater', sampleId: 'foreign-water', volumeUl: 20,
    methodId: 'prepare', methodVersion: 1, consumables: [{ batchId: 'reagent-A', units: 2 }] })
  while (world.operation('dependent')!.state === 'running') world.advance()
  const dependent = world.operation('dependent')!
  expect(() => world.deliver('P2', 'dependent-prepare', [dependent.resultId!])).toThrow('prerequisites')
  expect(() => world.deliver('P2', 'dependent-prepare', [dependent.resultId!], [dependent.resultId!])).toThrow('prerequisites')
  expect(world.deliver('P2', 'dependent-prepare', [dependent.resultId!], [first.resultId!])).toMatchObject({ valid: true, referenceResultIds: [first.resultId!] })
  run(world, 'clean-again', { action: 'clean', deviceId: 'heater' })
  const replacement = run(world, 'replacement-reference', { action: 'process', deviceId: 'heater', sampleId: 'water', volumeUl: 10,
    methodId: 'prepare', methodVersion: 1, consumables: [{ batchId: 'reagent-A', units: 2 }] })
  world.deliver('P1', 'prepare-water', [replacement.resultId!])
  expect(world.observe().deliveries.find(delivery => delivery.taskId === 'dependent-prepare')!.valid).toBe(false)
  expect(() => world.deliver('P2', 'dependent-prepare', [dependent.resultId!], [first.resultId!])).toThrow('prerequisites')
  expect(world.deliver('P2', 'dependent-prepare', [dependent.resultId!], [replacement.resultId!]).valid).toBe(true)
})
