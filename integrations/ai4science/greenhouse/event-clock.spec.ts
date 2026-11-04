/** Event-driven laboratory time waits for decisions and finishes owned event delivery before disposal. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { scenarioSchema } from './schema.ts'
import { GreenhouseWorld } from './world.ts'
import { GreenhouseClock } from './clock.ts'

const roots: string[] = [], worlds: GreenhouseWorld[] = [], clocks: GreenhouseClock[] = []
afterEach(async () => {
  for (const clock of clocks.splice(0)) await clock.close()
  for (const world of worlds.splice(0)) world.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
})
function open() {
  const root = mkdtempSync(join(tmpdir(), 'greenhouse-event-clock-')); roots.push(root)
  const scenario = scenarioSchema.parse(JSON.parse(readFileSync(new URL('./fixtures/baseline.scenario.json', import.meta.url), 'utf8')))
  scenario.tickMs = 60000
  const world = new GreenhouseWorld(root, scenario); worlds.push(world)
  return world
}

it('holds the simulation during model work despite host clock changes, then jumps to the next device event', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
  const world = open()
  const job = world.submit('inspect-A', 'project', 'inspect-A', { action: 'inspect', chamber: 'A' })
  const failures: Error[] = [], clock = new GreenhouseClock(world, error => failures.push(error), 'event-driven')
  clocks.push(clock)
  const model = clock.modelStarted(), tool = clock.toolStarted('A')
  const wait = clock.waiting('A', () => world.operation(job.id)?.state !== 'running')
  const dispatch = vi.fn(async () => {})
  clock.attach(() => clock.blocked('A'), dispatch)
  vi.setSystemTime(new Date('2040-01-01T00:00:00Z'))
  vi.advanceTimersByTime(3600000)
  await nextTurn()
  expect(world.observe().tick).toBe(0)
  expect(dispatch).not.toHaveBeenCalled()
  model()
  await nextTurn(); await nextTurn()
  expect(world.observe().tick).toBe(job.dueTick)
  expect(world.operation(job.id)?.state).toBe('succeeded')
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(failures).toEqual([])
  wait(); tool()
})

it('retains clock ownership while an event delivery is still pending and reaches quiescence on close', async () => {
  const world = open(), delivery = Promise.withResolvers<void>(), admitted = Promise.withResolvers<void>()
  const job = world.submit('inspect-B', 'project', 'inspect-B', { action: 'inspect', chamber: 'B' })
  const clock = new GreenhouseClock(world, () => {}, 'event-driven'); clocks.push(clock)
  const tool = clock.toolStarted('B'), wait = clock.waiting('B', () => world.operation(job.id)?.state !== 'running')
  clock.attach(() => clock.blocked('B'), async () => { admitted.resolve(); await delivery.promise })
  await admitted.promise
  const closing = clock.close()
  expect(() => new GreenhouseClock(world, () => {}, 'event-driven')).toThrow('Another clock')
  delivery.resolve(); await closing
  const replacement = new GreenhouseClock(world, () => {}, 'event-driven'); clocks.push(replacement)
  expect(replacement.status().running).toBe(true)
  expect(world.observe().tick).toBe(job.dueTick)
  wait(); tool()
})

it('stops at an intervening sensor-range event before a distant scenario event', () => {
  const root = mkdtempSync(join(tmpdir(), 'greenhouse-event-boundary-')); roots.push(root)
  const scenario = scenarioSchema.parse(JSON.parse(readFileSync(new URL('./fixtures/baseline.scenario.json', import.meta.url), 'utf8')))
  scenario.physics.moistureLoss = 1; scenario.physics.lightMoistureLoss = 0
  scenario.initial.chambers.A.moisture = scenario.operatingRange.minimumMoisture + 1
  scenario.events = [{ id: 'later-power', tick: 100, kind: 'power', capacity: 4.5 }]
  const world = new GreenhouseWorld(root, scenario); worlds.push(world)
  expect(world.advanceToNextEvent(30)).toBe(2)
  expect(world.events(0).at(-1)).toMatchObject({ tick: 2, kind: 'environment-range', data: { chamber: 'A', signal: 'moisture' } })
  expect(world.observe().powerCapacity).toBe(scenario.initial.powerCapacity)
})
