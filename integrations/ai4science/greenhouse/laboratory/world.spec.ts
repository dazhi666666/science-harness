/** Real SQLite regressions cover sample conservation, physical failures and historical review. */
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LaboratoryWorld } from './world.ts'
import type { LaboratoryCommand } from './schema.ts'
import { laboratoryFixture as scenario } from './fixture.ts'

const roots: string[] = [], worlds: LaboratoryWorld[] = []
afterEach(() => {
  for (const world of worlds.splice(0)) world.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function open(config = scenario()) {
  const root = mkdtempSync(join(tmpdir(), 'laboratory-')); roots.push(root)
  const world = new LaboratoryWorld(root, config); worlds.push(world)
  return { world, root }
}
function run(world: LaboratoryWorld, id: string, command: LaboratoryCommand) {
  if ((command.action === 'process' || command.action === 'aliquot') && world.observe().samples.find(value => value.id === command.sampleId)!.location !== command.deviceId)
    run(world, `move:${id}`, { action: 'transfer', deviceId: 'robot', sampleId: command.sampleId, destination: command.deviceId })
  world.submit(id, 'P1', id, command)
  while (world.observe().operations.find(value => value.id === id)!.state === 'running') world.advance()
  const result = world.observe().operations.find(value => value.id === id)!
  expect(result.state, result.detail).toBe('succeeded')
  return result
}

it('runs aliquot, preparation and calibrated confirmation with immutable sample lineage', () => {
  const { world } = open()
  const aliquot = run(world, 'split', { action: 'aliquot', deviceId: 'liquid', sampleId: 'water', volumeUl: 30, container: 'tube' })
  const prepared = run(world, 'prep', { action: 'process', deviceId: 'heater', sampleId: aliquot.outputSampleId!, volumeUl: 20, methodId: 'prepare', methodVersion: 1 })
  run(world, 'cal', { action: 'calibrate', deviceId: 'confirm' })
  run(world, 'confirm', { action: 'process', deviceId: 'confirm', sampleId: prepared.outputSampleId!, volumeUl: 20, methodId: 'confirm', methodVersion: 1 })
  const snapshot = world.observe()
  expect(snapshot.samples.reduce((sum, sample) => sum + sample.volumeUl, 0)).toBe(100)
  expect(snapshot.samples.find(sample => sample.id === 'water')!.volumeUl).toBe(70)
  expect(snapshot.results.at(-1)).toMatchObject({ rootSampleId: 'water', methodId: 'confirm', calibrationId: 'calibration:cal' })
  expect(snapshot.devices.find(device => device.id === 'confirm')!.dirty).toBe(true)
  const records = structuredClone(snapshot.results)
  expect(world.revokeCalibration('calibration:cal', 'quality-check-failed')).toEqual(['result:confirm'])
  expect(world.revokeCalibration('calibration:cal', 'quality-check-failed')).toEqual([])
  expect(world.observe().results).toEqual(records)
  expect(world.observe().revocations).toHaveLength(1)
})

it('retains consumed volume across a real processing fault, restart and idempotent retry', () => {
  const config = scenario(); config.samples[0]!.location = 'heater'; config.faults.push({ id: 'heater-stop', tick: 2, deviceId: 'heater' })
  const { world, root } = open(config)
  const command: LaboratoryCommand = { action: 'process', deviceId: 'heater', sampleId: 'water', volumeUl: 40, methodId: 'prepare', methodVersion: 1 }
  world.submit('prep', 'P1', 'identity', command)
  expect(world.advance()).toBe(1)
  expect(world.observe().samples[0]!.volumeUl).toBe(60)
  world.close()
  const reopened = new LaboratoryWorld(root, config); worlds.push(reopened)
  expect(reopened.advance()).toBe(2)
  expect(reopened.submit('prep', 'P1', 'identity', command)).toMatchObject({ state: 'failed', consumedUl: 40 })
  expect(reopened.observe().samples).toHaveLength(1)
  expect(reopened.observe().results).toEqual([])
  run(reopened, 'repair', { action: 'repair', deviceId: 'heater' })
  expect(() => reopened.prepare('P1', command)).toThrow('cleaning')
  run(reopened, 'clean', { action: 'clean', deviceId: 'heater' })
  run(reopened, 'retry', command)
  expect(reopened.observe().samples[0]!.volumeUl).toBe(20)
})

it('distinguishes cancellation before consumption from cancellation after committed stage effects', () => {
  const { world } = open()
  const command: LaboratoryCommand = { action: 'aliquot', deviceId: 'liquid', sampleId: 'water', volumeUl: 30, container: 'tube' }
  world.submit('before', 'P1', 'before', command)
  expect(world.cancel('before').consumedUl).toBe(0)
  world.submit('after', 'P1', 'after', command); world.advance()
  expect(world.cancel('after').consumedUl).toBe(30)
  expect(world.observe().samples[0]!.volumeUl).toBe(70)
  expect(world.observe().samples).toHaveLength(1)
})

it('serializes sample admission across device connections and refuses conflicting operation identities', () => {
  const { world, root } = open()
  const other = new LaboratoryWorld(root, scenario()); worlds.push(other)
  const command: LaboratoryCommand = { action: 'aliquot', deviceId: 'liquid', sampleId: 'water', volumeUl: 30, container: 'tube' }
  world.submit('one', 'P1', 'same', command)
  const before = world.observe()
  expect(() => other.submit('two', 'P1', 'two', { action: 'process', deviceId: 'heater', sampleId: 'water', volumeUl: 10, methodId: 'prepare', methodVersion: 1 })).toThrow('accepted work')
  expect(() => other.submit('one', 'P1', 'changed', command)).toThrow('different work')
  expect(() => other.submit('foreign', 'P2', 'foreign', { action: 'transfer', deviceId: 'robot', sampleId: 'water', destination: 'cold' })).toThrow('this project')
  expect(other.observe()).toEqual(before)
})

it('rejects incompatible preparation, missing calibration and obsolete method versions', () => {
  const { world } = open()
  const command: LaboratoryCommand = { action: 'process', deviceId: 'confirm', sampleId: 'water', volumeUl: 10, methodId: 'confirm', methodVersion: 1 }
  expect(() => world.submit('raw', 'P1', 'raw', command)).toThrow('incompatible')
  expect(() => world.submit('version', 'P1', 'version', { ...command, deviceId: 'heater', methodId: 'prepare', methodVersion: 2 })).toThrow('version')
  expect(() => world.submit('uncalibrated', 'P1', 'uncalibrated', { ...command, deviceId: 'screen', methodId: 'screen' })).toThrow('Transport')
  expect(world.observe().operations).toEqual([])
})

it('hides future faults, uses logical expiry and preserves state across repeated reads', () => {
  const config = scenario(); config.samples[0]!.expiresAt = 1
  config.faults.push({ id: 'future-secret', tick: 5, deviceId: 'screen' })
  const { world } = open(config)
  const before = world.observe()
  expect(JSON.stringify(before)).not.toContain('future-secret')
  for (let index = 0; index < 10; index++) { world.observe(); world.events(0) }
  expect(world.observe()).toEqual(before)
  world.submit('expire', 'P1', 'expire', { action: 'aliquot', deviceId: 'liquid', sampleId: 'water', volumeUl: 10, container: 'tube' })
  expect(world.advance()).toBe(1)
  expect(world.advance()).toBe(2)
  expect(world.observe().samples[0]!.disposition).toBe('quarantined')
  expect(world.advance()).toBe(3)
  expect(world.observe().operations[0]).toMatchObject({ state: 'failed', consumedUl: 10 })
  expect(world.advance()).toBe(5)
  expect(world.advance()).toBeNull()
})

it('reserves destination positions across robots and retains in-transit samples after cancellation', () => {
  const config = scenario()
  config.devices.find(device => device.id === 'cold')!.capacity = 1
  config.devices.push({ id: 'robot-2', kind: 'robot', methods: [], containers: ['tube'], capacity: 1, powerDraw: 0, waterPerProcessUl: 0, maximumBatchSamples: 1, batchMultiple: 1 })
  config.samples.push({ ...config.samples[0]!, id: 'water-2' })
  const { world } = open(config)
  world.submit('move-one', 'P1', 'one', { action: 'transfer', deviceId: 'robot', sampleId: 'water', destination: 'cold' })
  expect(() => world.submit('move-two', 'P1', 'two', { action: 'transfer', deviceId: 'robot-2', sampleId: 'water-2', destination: 'cold' })).toThrow('unreserved position')
  world.advance()
  expect(world.observe().samples.find(sample => sample.id === 'water')!.location).toBe('robot')
  world.cancel('move-one')
  expect(world.observe().samples.find(sample => sample.id === 'water')!.location).toBe('robot')
  run(world, 'move-recovered', { action: 'transfer', deviceId: 'robot', sampleId: 'water', destination: 'cold' })
  expect(world.observe().samples.find(sample => sample.id === 'water')!.location).toBe('cold')
})

it('requires physical delivery, available output positions and a live calibration', () => {
  const config = scenario()
  config.devices.find(device => device.id === 'liquid')!.capacity = 1
  const { world } = open(config)
  expect(() => world.submit('split', 'P1', 'split', { action: 'aliquot', deviceId: 'liquid', sampleId: 'water', volumeUl: 20, container: 'tube' })).toThrow('position')
  run(world, 'move', { action: 'transfer', deviceId: 'robot', sampleId: 'water', destination: 'screen' })
  expect(() => world.submit('uncalibrated', 'P1', 'uncalibrated', { action: 'process', deviceId: 'screen', sampleId: 'water', volumeUl: 100, methodId: 'screen', methodVersion: 1 })).toThrow('calibration')
  expect(() => world.submit('teleport', 'P1', 'teleport', { action: 'aliquot', deviceId: 'liquid', sampleId: 'water', volumeUl: 100, container: 'tube' })).toThrow('Transport')
  run(world, 'cal-screen', { action: 'calibrate', deviceId: 'screen' })
  world.revokeCalibration('calibration:cal-screen', 'withdrawn-standard')
  expect(world.observe().devices.find(device => device.id === 'screen')!.calibrationId).toBeUndefined()
})
