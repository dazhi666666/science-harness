/** Laboratory ownership and decision barriers exercise the shared production clock. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LaboratoryClock } from './clock.ts'
import { LaboratoryWorld } from './world.ts'
import { laboratoryFixture } from './fixture.ts'
const roots: string[] = [], worlds: LaboratoryWorld[] = [], clocks: LaboratoryClock[] = []
afterEach(async () => {
  for (const clock of clocks.splice(0)) await clock.close()
  for (const world of worlds.splice(0)) world.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'laboratory-clock-')); roots.push(directory)
  const world = new LaboratoryWorld(directory, laboratoryFixture()); worlds.push(world)
  const errors: Error[] = [], clock = new LaboratoryClock(world, error => errors.push(error)); clocks.push(clock)
  return { world, clock, errors }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
it('holds logical time for model generation, running decisions and unpersisted tool output', async () => {
  const { world, clock } = setup()
  world.submit('split', 'P1', 'split', { action: 'aliquot', deviceId: 'liquid', sampleId: 'water', volumeUl: 20, container: 'tube' })
  let ready = false
  clock.attach(() => ready, async () => {})
  await turn(); expect(world.observe().tick).toBe(0)
  const modelDone = clock.modelStarted(); ready = true; clock.wake()
  await turn(); expect(world.observe().tick).toBe(0)
  modelDone(); ready = false
  const toolDone = clock.toolStarted('worker')
  const stopWaiting = clock.waiting('worker', () => false)
  expect(clock.blocked('worker')).toBe(true)
  ready = true
  await turn(); expect(world.observe().tick).toBe(1)
  ready = false
  stopWaiting(); expect(clock.blocked('worker')).toBe(false)
  toolDone()
})
it('awaits event delivery before advancing again and retains ownership until disposal is quiescent', async () => {
  const { world, clock } = setup()
  world.submit('split', 'P1', 'split', { action: 'aliquot', deviceId: 'liquid', sampleId: 'water', volumeUl: 20, container: 'tube' })
  let finish!: () => void
  const delivery = new Promise<void>(resolve => { finish = resolve })
  clock.attach(() => true, () => delivery)
  await turn(); expect(world.observe().tick).toBe(1)
  await turn(); expect(world.observe().tick).toBe(1)
  const closed = clock.close()
  expect(() => new LaboratoryClock(world, () => {})).toThrow('Another clock')
  finish(); await closed
  const replacement = new LaboratoryClock(world, () => {}); clocks.push(replacement)
  expect(world.observe().tick).toBe(1)
})
it('keeps the physical owner after a fault and stops admission of future clock work', async () => {
  const { world, clock, errors } = setup()
  vi.spyOn(world, 'advance').mockImplementation(() => { throw new Error('device storage failure') })
  clock.attach(() => true, async () => {})
  await turn(); await turn()
  expect(clock.status()).toMatchObject({ running: false, failure: 'device storage failure' })
  expect(errors).toHaveLength(1)
  expect(() => new LaboratoryClock(world, () => {})).toThrow('Another clock')
})
