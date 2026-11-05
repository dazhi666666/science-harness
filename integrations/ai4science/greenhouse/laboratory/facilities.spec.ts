/** Physical event progression covers preservation, utility failures and delivered stock. */
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { laboratoryFixture } from './fixture.ts'
import { LaboratoryWorld } from './world.ts'
import type { LaboratoryCommand, LaboratoryScenario } from './schema.ts'
const roots: string[] = [], worlds: LaboratoryWorld[] = []
afterEach(() => {
  for (const world of worlds.splice(0)) world.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function open(config: LaboratoryScenario) {
  const root = mkdtempSync(join(tmpdir(), 'laboratory-facilities-')); roots.push(root)
  const world = new LaboratoryWorld(root, config); worlds.push(world)
  return world
}
function run(world: LaboratoryWorld, id: string, command: LaboratoryCommand) {
  world.submit(id, 'P1', id, command)
  while (world.observe().operations.find(value => value.id === id)!.state === 'running') world.advance()
  return world.observe().operations.find(value => value.id === id)!
}
function refrigerated(maximumExposureTicks = 2) {
  const config = laboratoryFixture()
  config.samples[0]!.location = 'cold'
  config.samples[0]!.preservation = { minimumTemperature: 0, maximumTemperature: 8, maximumExposureTicks }
  const cold = config.devices.find(device => device.id === 'cold')!
  cold.conditions = { initialTemperature: 4, targetTemperature: 4, minimumTarget: 0, maximumTarget: 8,
    ambientTemperature: 22, driftPerTick: 1, controlPerTick: 2 }
  cold.powerDraw = 2
  config.faults.push({ id: 'cold-loss', tick: 2, deviceId: 'cold' })
  return config
}
it('emits the first unsafe observation before cumulative temperature exposure quarantines a sample', () => {
  const world = open(refrigerated())
  expect(world.advance()).toBe(2)
  expect(world.advance()).toBe(7)
  expect(world.observe().samples[0]!.disposition).toBe('available')
  expect(world.events(0).at(-1)).toMatchObject({ kind: 'sample-temperature-changed', payload: { sampleId: 'water', safe: false } })
  expect(world.advance()).toBe(9)
  expect(world.observe().samples[0]).toMatchObject({ exposureTicks: 3, disposition: 'quarantined' })
  expect(world.observe().facilityMetrics.unsafeSampleTicks).toBe(3)
  expect(world.events(0).some(event => event.kind === 'sample-preservation-failed')).toBe(true)
})
it('allows timely repair to restore refrigeration and preserves the exact accumulated unsafe ticks', () => {
  const world = open(refrigerated(10))
  world.advance(); world.advance()
  expect(run(world, 'repair', { action: 'repair', deviceId: 'cold' }).state).toBe('succeeded')
  expect(world.advance()).toBe(12)
  expect(world.observe().samples[0]).toMatchObject({ exposureTicks: 5, disposition: 'available' })
  expect(world.events(0).at(-1)).toMatchObject({ kind: 'sample-temperature-changed', payload: { safe: true } })
  const before = world.observe()
  for (let index = 0; index < 10; index++) world.observe()
  expect(world.observe()).toEqual(before)
})
it('requires a functioning water path and retains water already consumed by cancelled processing', () => {
  const config = laboratoryFixture()
  config.facilities.initialWaterUl = 2; config.facilities.waterCapacityUl = 20
  config.devices.push({ ...config.devices[0]!, id: 'reservoir', kind: 'water-module', waterRole: 'reservoir', methods: [] })
  config.devices.find(device => device.id === 'heater')!.waterPerProcessUl = 5
  config.samples[0]!.location = 'heater'
  const world = open(config)
  const command: LaboratoryCommand = { action: 'process', deviceId: 'heater', sampleId: 'water', volumeUl: 20, methodId: 'prepare', methodVersion: 1 }
  expect(() => world.prepare('P1', command)).toThrow('water')
  expect(run(world, 'refill', { action: 'refill', deviceId: 'reservoir', volumeUl: 10 }).state).toBe('succeeded')
  world.submit('process', 'P1', 'process', command); world.advance()
  expect(world.cancel('process')).toMatchObject({ consumedUl: 20, consumedWaterUl: 5 })
  expect(world.observe().facilities.waterUl).toBe(7)
  expect(world.observe().samples[0]!.volumeUl).toBe(80)
})
it('turns shared power reductions into a real failed operation with retained physical effects', () => {
  const config = laboratoryFixture()
  config.samples[0]!.location = 'heater'
  config.devices.find(device => device.id === 'heater')!.powerDraw = 2
  config.facilities.powerCapacity = 2
  config.revisions.push({ id: 'power-loss', tick: 2, kind: 'power', capacity: 1 })
  const world = open(config)
  const result = run(world, 'prepare', { action: 'process', deviceId: 'heater', sampleId: 'water', volumeUl: 20, methodId: 'prepare', methodVersion: 1 })
  expect(result).toMatchObject({ state: 'failed', consumedUl: 20 })
  expect(world.observe().results).toEqual([])
  expect(world.observe().facilityMetrics.powerOverloadTicks).toBe(2)
  expect(world.observe().samples[0]!.volumeUl).toBe(80)
})
it('makes thermal setpoints and disabling controls affect available electrical capacity', () => {
  const config = refrigerated(); config.faults = []
  config.samples[0]!.preservation = undefined; config.samples[0]!.location = 'heater'
  config.facilities.powerCapacity = 2
  config.devices.find(device => device.id === 'heater')!.powerDraw = 2
  const world = open(config)
  const command: LaboratoryCommand = { action: 'process', deviceId: 'heater', sampleId: 'water', volumeUl: 100, methodId: 'prepare', methodVersion: 1 }
  expect(() => world.prepare('P1', command)).toThrow('power')
  expect(() => world.prepare('P1', { action: 'configure', deviceId: 'cold', enabled: true, targetTemperature: 30 })).toThrow('settings')
  expect(run(world, 'disable', { action: 'configure', deviceId: 'cold', enabled: false }).state).toBe('succeeded')
  expect(world.prepare('P1', command)).toEqual(command)
})
it('adds ordered consumables only when their logical shipment arrives and deduplicates the order', () => {
  const config = laboratoryFixture()
  config.devices.push({ ...config.devices[0]!, id: 'analysis', kind: 'analysis', methods: [] })
  config.supplyCatalog.push({ kind: 'extraction', unitsPerOrder: 12, deliveryTicks: 5, shelfLifeTicks: 100 })
  const world = open(config)
  const order: LaboratoryCommand = { action: 'order', deviceId: 'analysis', kind: 'extraction' }
  const operation = run(world, 'order', order)
  expect(world.observe().batches).toEqual([])
  expect(world.submit('order', 'P1', 'order', order)).toEqual(operation)
  expect(world.observe().shipments).toHaveLength(1)
  expect(world.advance()).toBe(8)
  expect(world.observe().batches).toEqual([{ id: 'batch:order', kind: 'extraction', units: 12, expiresAt: 108, disposition: 'available' }])
})

it('requires physical warm-up and fails processing if the declared method temperature is lost', () => {
  const config = laboratoryFixture()
  const heater = config.devices.find(device => device.id === 'heater')!
  heater.conditions = { initialTemperature: 22, targetTemperature: 22, minimumTarget: 20, maximumTarget: 40,
    ambientTemperature: 22, driftPerTick: 1, controlPerTick: 2 }
  config.methods.find(method => method.id === 'prepare')!.operatingRange = { minimumTemperature: 30, maximumTemperature: 35 }
  config.samples[0]!.location = 'heater'
  const world = open(config)
  const process: LaboratoryCommand = { action: 'process', deviceId: 'heater', sampleId: 'water', volumeUl: 20, methodId: 'prepare', methodVersion: 1 }
  expect(() => world.prepare('P1', process)).toThrow('temperature')
  expect(run(world, 'warm', { action: 'configure', deviceId: 'heater', enabled: true, targetTemperature: 32 }).state).toBe('succeeded')
  expect(world.observe().devices.find(device => device.id === 'heater')!.temperature).toBe(22)
  expect(world.advance()).toBe(8)
  expect(world.events(0).at(-1)).toMatchObject({ kind: 'device-temperature-stable', payload: { deviceId: 'heater' } })
  expect(run(world, 'process', process).state).toBe('succeeded')
  heater.conditions.initialTemperature = 32
  const drifting = open(config)
  expect(run(drifting, 'drifting-process', process)).toMatchObject({ state: 'failed', consumedUl: 20 })
  expect(drifting.observe().results).toEqual([])
})
