/** Deterministic notification routing and disposal; no model responses are fabricated as environmental progress. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scenarioSchema } from './schema.ts'
import { GreenhouseWorld } from './world.ts'
import { GreenhouseEventDispatch, type WorldEvent } from './events.ts'

const roots: string[] = [], worlds: GreenhouseWorld[] = [], observers: GreenhouseEventDispatch[] = []
afterEach(async () => {
  for (const observer of observers.splice(0)) await observer.close()
  for (const world of worlds.splice(0)) world.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
})
function open() {
  const config = scenarioSchema.parse(JSON.parse(readFileSync(new URL('./scenario.json', import.meta.url), 'utf8')))
  const root = mkdtempSync(join(tmpdir(), 'greenhouse-notices-')); roots.push(root)
  const world = new GreenhouseWorld(root, config); worlds.push(world)
  return world
}

it('coalesces committed power and new-task changes to lead and routes a sensor alert only to its chamber', async () => {
  vi.useFakeTimers()
  const world = open(), sent: { role: string; events: WorldEvent[] }[] = []
  const failed = vi.fn()
  const observer = new GreenhouseEventDispatch(world, async (role, events) => { sent.push({ role, events }) },
    100, new AbortController().signal, failed); observers.push(observer)
  for (let n = 0; n < 40; n++) world.step()
  await vi.advanceTimersByTimeAsync(100)
  expect(sent.map(notice => notice.role)).toEqual(['lead', 'chamber-B'])
  expect(sent[0]!.events.map(event => event.kind)).toEqual(['environment-power', 'environment-task'])
  expect(sent[1]!.events.map(event => event.kind)).toEqual(['environment-sensor'])
  expect(JSON.stringify(sent)).not.toContain('"bias"')
  expect(JSON.stringify(sent)).not.toContain('power-restored')
  await vi.advanceTimersByTimeAsync(500)
  expect(sent).toHaveLength(2)
  expect(observer.status()).toMatchObject({ acceptedNotices: 2, failure: null })
  expect(failed).not.toHaveBeenCalled()
  await observer.close()
  world.step()
  await vi.advanceTimersByTimeAsync(500)
  expect(sent).toHaveLength(2)
})

it('does not advance its cursor or keep retrying an uncertain native delivery', async () => {
  vi.useFakeTimers()
  const world = open(), failed = vi.fn(), send = vi.fn(async () => { throw new Error('native target unavailable') })
  const observer = new GreenhouseEventDispatch(world, send, 100, new AbortController().signal, failed); observers.push(observer)
  for (let n = 0; n < 20; n++) world.step()
  await vi.advanceTimersByTimeAsync(100)
  expect(observer.status()).toMatchObject({ running: false, cursor: 1, failure: 'native target unavailable' })
  expect(failed).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1000)
  expect(send).toHaveBeenCalledOnce()
})

it('awaits cancellation of in-flight native delivery before releasing its consumer', async () => {
  vi.useFakeTimers()
  const world = open(), started = Promise.withResolvers<void>(), cancelled = vi.fn(), failed = vi.fn()
  const observer = new GreenhouseEventDispatch(world, async (_role, _events, signal) => {
    started.resolve()
    return new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => {
      cancelled(); reject(signal.reason)
    }, { once: true }))
  }, 100, new AbortController().signal, failed); observers.push(observer)
  for (let n = 0; n < 20; n++) world.step()
  await vi.advanceTimersByTimeAsync(100)
  await started.promise
  await observer.close()
  expect(cancelled).toHaveBeenCalledOnce()
  expect(observer.status().running).toBe(false)
  expect(failed).not.toHaveBeenCalled()
})

it('emits sensor-visible range transitions once and keeps biased internal moisture hidden', () => {
  const base = scenarioSchema.parse(JSON.parse(readFileSync(new URL('./scenario.json', import.meta.url), 'utf8')))
  base.initial.chambers.B.moisture = 30.05
  base.events = [{ id: 'biased', tick: 1, kind: 'sensor', chamber: 'B', bias: 18 }]
  const root = mkdtempSync(join(tmpdir(), 'greenhouse-sensor-ranges-')); roots.push(root)
  const world = new GreenhouseWorld(root, base); worlds.push(world)
  world.step()
  expect(world.audit().chambers.B.moisture).toBeLessThan(30)
  expect(world.observe().chambers.find(chamber => chamber.chamber === 'B')!.moisture).toBeGreaterThan(30)
  expect(world.events(0).filter(event => event.kind === 'environment-range')).toHaveLength(0)
  world.submit('calibration', 'project', 'calibration', { action: 'calibrate', chamber: 'B' })
  for (let n = 0; n < base.durations.calibrate; n++) world.step()
  const rangeEvents = world.events(0).filter(event => event.kind === 'environment-range')
  expect(rangeEvents).toHaveLength(1)
  expect(rangeEvents[0]!.data).toMatchObject({ chamber: 'B', signal: 'moisture', status: 'outside' })
  world.step(); world.step()
  expect(world.events(0).filter(event => event.kind === 'environment-range')).toHaveLength(1)
  world.submit('water', 'project', 'water', { action: 'water', chamber: 'B', litres: 2 })
  for (let n = 0; n < base.durations.water; n++) world.step()
  expect(world.events(0).filter(event => event.kind === 'environment-range').at(-1)!.data)
    .toMatchObject({ chamber: 'B', signal: 'moisture', status: 'normal' })
})
