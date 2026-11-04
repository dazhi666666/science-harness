/** Repeated workloads reveal only released tasks and require new physical preparation. */
import { afterEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { scenarioSchema } from './schema.ts'
import { GreenhouseWorld } from './world.ts'

let world: GreenhouseWorld | undefined, directory: string | undefined
afterEach(() => { world?.close(); if (directory) rmSync(directory, { recursive: true, force: true }) })

it('generates distinct cross-chamber batches and refuses old watering as preparation for a newly released experiment', () => {
  directory = mkdtempSync(join(tmpdir(), 'greenhouse-repeated-'))
  const output = join(directory, 'scenario.json')
  const generated = spawnSync('python3', [fileURLToPath(new URL('./make-scenario.py', import.meta.url)), output,
    '--batches', '2', '--interval-ticks', '30'], { encoding: 'utf8' })
  expect(generated.status, generated.stderr).toBe(0)
  const scenario = scenarioSchema.parse(JSON.parse(readFileSync(output, 'utf8')))
  expect(scenario.tickMs).toBe(60000)
  world = new GreenhouseWorld(join(directory, 'device'), scenario)
  expect(world.observe().tasks.map(task => task.id)).toEqual(['light-A-01', 'water-B-01', 'reference-C-01'])
  world.submit('old-water', 'project', 'old-water', { action: 'water', chamber: 'B', litres: 2 })
  for (let tick = 0; tick < 30; tick++) world.step()
  expect(world.observe().tasks).toHaveLength(6)
  expect(world.observe().tasks.find(task => task.id === 'reference-C-02')).toMatchObject({ referenceTaskId: 'water-B-02' })
  expect(() => world!.prepare({ action: 'sample', chamber: 'B', taskId: 'water-B-02' })).toThrow('watering')
  world.submit('new-water', 'project', 'new-water', { action: 'water', chamber: 'B', litres: 2 })
  for (let tick = 0; tick < 3; tick++) world.step()
  expect(world.prepare({ action: 'sample', chamber: 'B', taskId: 'water-B-02' })).toMatchObject({ taskId: 'water-B-02' })
  expect(JSON.stringify(world.observe())).not.toContain('power-down-1')
})
