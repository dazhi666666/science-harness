/** Device-world regressions use actual SQLite state and an explicitly driven background clock. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scenarioSchema, type Command, type Scenario } from './schema.ts'
import { GreenhouseWorld } from './world.ts'
import { GreenhouseClock } from './clock.ts'

const roots: string[] = [], worlds: GreenhouseWorld[] = [], clocks: GreenhouseClock[] = []
afterEach(() => {
  for (const clock of clocks.splice(0)) clock.close()
  for (const world of worlds.splice(0)) world.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
})
function scenario(): Scenario { return scenarioSchema.parse(JSON.parse(readFileSync(new URL('./scenario.json', import.meta.url), 'utf8'))) }
function open(config = scenario()) {
  const directory = mkdtempSync(join(tmpdir(), 'greenhouse-world-')); roots.push(directory)
  const world = new GreenhouseWorld(directory, config); worlds.push(world)
  return world
}
function tick(world: GreenhouseWorld, count: number) { for (let n = 0; n < count; n++) world.step() }
function run(world: GreenhouseWorld, id: string, command: Command) {
  const accepted = world.submit(id, 'project', id, command)
  tick(world, accepted.dueTick - world.observe().tick)
  const finished = world.operation(id)!
  expect(finished.state, finished.detail).toBe('succeeded')
  return finished
}

it('progresses without queries, reads never tick, and clock disposal stops future callbacks', () => {
  vi.useFakeTimers()
  const world = open(), failures: Error[] = []
  world.submit('sample', 'project', 'sample', { action: 'sample', chamber: 'C', taskId: 'reference-C' })
  const clock = new GreenhouseClock(world, error => failures.push(error)); clocks.push(clock)
  vi.advanceTimersByTime(world.scenario.tickMs * world.scenario.durations.sample)
  expect(world.operation('sample')?.state).toBe('succeeded')
  const before = world.audit()
  for (let n = 0; n < 20; n++) { world.observe(); world.operation('sample'); world.events(0) }
  expect(world.audit()).toEqual(before)
  clock.close()
  vi.advanceTimersByTime(world.scenario.tickMs * 10)
  expect(world.audit()).toEqual(before)
  expect(failures).toEqual([])
  expect(clock.status()).toEqual({ running: false, disposed: true, failure: null })
})

it('owns only one clock and reports clock failure without losing the ownership lock', () => {
  vi.useFakeTimers()
  const world = open(), failures: Error[] = []
  const clock = new GreenhouseClock(world, error => failures.push(error)); clocks.push(clock)
  expect(() => new GreenhouseClock(world, () => {})).toThrow('Another clock')
  const original = world.step.bind(world)
  vi.spyOn(world, 'step').mockImplementation(() => { throw new Error('storage unavailable') })
  vi.advanceTimersByTime(world.scenario.tickMs)
  expect(clock.status()).toMatchObject({ running: false, failure: 'storage unavailable' })
  expect(failures).toHaveLength(1)
  expect(() => new GreenhouseClock(world, () => {})).toThrow('Another clock')
  clock.close()
  vi.mocked(world.step).mockImplementation(original)
  const replacement = new GreenhouseClock(world, error => failures.push(error)); clocks.push(replacement)
  vi.advanceTimersByTime(world.scenario.tickMs)
  expect(world.observe().tick).toBe(1)
})

it('reproduces the same world and event schedule without exposing future events or sensor truth', () => {
  const first = open(), second = open()
  expect(JSON.stringify(first.observe())).not.toMatch(/sensorBias|dust-power|extra-C/)
  tick(first, 30); tick(second, 30)
  expect(first.audit()).toEqual(second.audit())
  const measured = first.observe().chambers.find(c => c.chamber === 'B')!.moisture
  expect(measured - first.audit().chambers.B.moisture).toBeCloseTo(18)
  const warning = first.events(0).find(e => e.kind === 'environment-sensor')!
  expect(JSON.stringify(warning)).not.toContain('bias')
  expect(first.observe().tasks).toHaveLength(3)
  tick(first, 10)
  expect(first.observe().tasks.map(task => task.id)).toContain('extra-C')
  expect(first.events(warning.seq).every(event => event.seq > warning.seq)).toBe(true)
})

it('persists accepted identities, rejects conflicting retries, and refuses changed scenarios', () => {
  const world = open(), command: Command = { action: 'inspect', chamber: 'B' }
  const before = world.submit('inspect', 'project', 'same', command)
  expect(world.submit('inspect', 'project', 'same', command)).toEqual(before)
  expect(() => world.submit('inspect', 'project', 'other', command)).toThrow('identity reused')
  expect(() => world.submit('inspect', 'other-project', 'same', command)).toThrow('identity reused')
  world.close()
  const reopened = new GreenhouseWorld(world.directory, world.scenario); worlds.push(reopened)
  expect(reopened.submit('inspect', 'project', 'same', command)).toEqual(before)
  expect(reopened.events(0).filter(e => e.kind === 'operation-started')).toHaveLength(1)
  expect(() => new GreenhouseWorld(world.directory, { ...world.scenario, tickMs: 5 })).toThrow('configuration changed')
})

it('rejects invalid/busy actions atomically and cancellation releases the simulated robot', () => {
  const world = open(), before = world.audit()
  expect(() => world.submit('bad', 'project', 'bad', { action: 'water', chamber: 'A', litres: -1 })).toThrow()
  expect(() => world.submit('missing', 'project', 'missing', { action: 'sample', chamber: 'A', taskId: 'unknown' })).toThrow('available task')
  expect(world.audit()).toEqual(before)
  world.submit('one', 'project', 'one', { action: 'inspect', chamber: 'A' })
  const active = world.audit()
  expect(() => world.submit('two', 'project', 'two', { action: 'inspect', chamber: 'B' })).toThrow('Resource busy')
  expect(world.audit()).toEqual(active)
  expect(world.cancel('one').state).toBe('cancelled')
  expect(world.submit('two', 'project', 'two', { action: 'inspect', chamber: 'B' }).state).toBe('running')
})

it('accounts for pending light settings and does not spend cancelled irrigation water', () => {
  const config = scenario(); config.initial.powerCapacity = 6
  const world = open(config)
  world.submit('A-light', 'project', 'A-light', { action: 'light', chamber: 'A', level: 1 })
  expect(() => world.submit('B-light', 'project', 'B-light', { action: 'light', chamber: 'B', level: 1 })).toThrow('capacity exceeded')
  world.submit('water-cancel', 'project', 'water-cancel', { action: 'water', chamber: 'B', litres: 2 })
  world.cancel('water-cancel')
  tick(world, 5)
  expect(world.observe().waterLitres).toBe(100)
  run(world, 'water-real', { action: 'water', chamber: 'B', litres: 2 })
  expect(world.observe().waterLitres).toBe(98)
  expect(() => world.submit('too-much', 'project', 'too-much', { action: 'water', chamber: 'B', litres: 99 })).toThrow('Insufficient')
})

it('rechecks experiment conditions at completion if a power event intervenes', () => {
  const world = open()
  run(world, 'light', { action: 'light', chamber: 'A', level: 0.7 })
  tick(world, 17)
  world.submit('sample', 'project', 'sample', { action: 'sample', chamber: 'A', taskId: 'light-A' })
  tick(world, 4)
  expect(world.operation('sample')).toMatchObject({ state: 'failed', detail: expect.stringContaining('effective light') })
  expect(world.audit().samples).toHaveLength(0)
})

it('requires real distinct observations and cross-task evidence before completing an experiment', () => {
  const config = scenario(); config.events = []
  const world = open(config)
  expect(() => world.submit('early', 'project', 'early', { action: 'sample', chamber: 'B', taskId: 'water-B' })).toThrow('watering')
  run(world, 'water', { action: 'water', chamber: 'B', litres: 2 })
  for (const chamber of ['B', 'C'] as const) {
    const taskId = chamber === 'B' ? 'water-B' : 'reference-C'
    for (let index = 0; index < 2; index++) {
      const id = `${chamber}-${index}`
      run(world, id, { action: 'sample', chamber, taskId })
      run(world, `assay-${id}`, { action: 'assay', sampleId: `sample:${id}` })
    }
  }
  const b = ['assay:assay-B-0', 'assay:assay-B-1'], c = ['assay:assay-C-0', 'assay:assay-C-1']
  expect(() => world.submit('duplicate', 'project', 'duplicate', { action: 'analyze', taskId: 'water-B', assayIds: [b[0]!, b[0]!] })).toThrow('Repeated assays')
  expect(() => world.submit('missing', 'project', 'missing', { action: 'analyze', taskId: 'reference-C', assayIds: c })).toThrow('water-B')
  run(world, 'analysis-B', { action: 'analyze', taskId: 'water-B', assayIds: b })
  run(world, 'analysis-C', { action: 'analyze', taskId: 'reference-C', assayIds: [...c, b[0]!] })
  expect(world.observe().completedTasks).toEqual(['water-B', 'reference-C'])
  expect(world.operation('analysis-C')?.result).toMatchObject({ scientificConclusion: 'not-assessed' })
})

it('diagnoses and calibrates a biased sensor using the shared robot', () => {
  const world = open(); tick(world, 30)
  const inspection = run(world, 'inspection', { action: 'inspect', chamber: 'B' })
  expect(inspection.result).toMatchObject({ moistureSensor: 'calibration-required' })
  run(world, 'calibration', { action: 'calibrate', chamber: 'B' })
  expect(world.observe().chambers.find(c => c.chamber === 'B')!.moisture).toBe(world.audit().chambers.B.moisture)
})
