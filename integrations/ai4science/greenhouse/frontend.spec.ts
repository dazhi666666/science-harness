/** The existing Mission Control serves actual greenhouse and execution state under one authenticated origin. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { scenarioSchema } from './schema.ts'
import * as Plugin from './plugin.ts'
import { GreenhouseWorld } from './world.ts'

const contexts: Context[] = [], readers: GreenhouseWorld[] = [], roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const reader of readers.splice(0)) reader.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('mounts via the plugin entry, displays live readings, protects APIs and shares submitted operations with the dashboard', async () => {
  const root = mkdtempSync(join(tmpdir(), 'greenhouse-ui-')); roots.push(root)
  const scenario = scenarioSchema.parse(JSON.parse(readFileSync(new URL('./scenario.json', import.meta.url), 'utf8')))
  scenario.tickMs = 20
  const scenarioFile = join(root, 'scenario.json'); writeFileSync(scenarioFile, JSON.stringify(scenario))
  const ctx = new Context(); contexts.push(ctx)
  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation(value => lines.push(String(value)))
  try {
    await ctx.plugin(Plugin, { directory: root, scenarioFile, project: 'mars-greenhouse', port: 0,
      refreshMs: 100, providerCallTimeoutMs: 1000 })
  } finally { log.mockRestore() }
  const launch = lines.find(line => line.startsWith('Mission Control: '))!
  expect(launch).toBeDefined()
  const link = new URL(launch.slice('Mission Control: '.length))
  const base = link.origin, headers = { Authorization: `Bearer ${link.hash.slice(1)}` }
  expect((await fetch(`${base}/mc/greenhouse`)).status).toBe(401)
  expect((await fetch(`${base}/mc/greenhouse`, { headers: { ...headers, Origin: 'https://untrusted.test' } })).status).toBe(403)
  expect((await fetch(`${base}/mc/greenhouse?after=-1`, { headers })).status).toBe(400)
  expect((await fetch(`${base}/mc/greenhouse`, { method: 'POST', headers })).status).toBe(405)
  const page = await (await fetch(base)).text()
  expect(page).toContain('data-view="greenhouse"')
  expect(page).toContain('火星温室')
  expect((await fetch(`${base}/greenhouse.js`)).status).toBe(200)
  expect(await (await fetch(`${base}/mc/status`, { headers })).json()).toMatchObject({ science: true, greenhouse: true, router: false })
  const first = await (await fetch(`${base}/mc/greenhouse`, { headers })).json()
  expect(first.mode).toBe('environment-only')
  expect(first.world.chambers).toHaveLength(3)
  expect(JSON.stringify(first)).not.toMatch(/sensorBias|"bias"|power-restored/)
  const reader = new GreenhouseWorld(join(root, 'device'), scenario); readers.push(reader)
  await vi.waitFor(() => expect(reader.observe().tick).toBeGreaterThan(first.world.tick))
  const submit = await fetch(`${base}/science/api/action`, { method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'submit',
      project: 'mars-greenhouse', providerId: 'greenhouse', requestKey: 'inspect-B', input: { action: 'inspect', chamber: 'B' } }) })
  expect(submit.status).toBe(200)
  await vi.waitFor(() => expect(reader.audit().jobs.some(job => job.state === 'succeeded')).toBe(true))
  const state = await (await fetch(`${base}/science/api/state?project=mars-greenhouse`, { headers })).json()
  expect(state.operations).toHaveLength(1)
  expect(state.operations[0].requestKey).toBe('inspect-B')
  const latest = await (await fetch(`${base}/mc/greenhouse?after=${first.events.at(-1).seq}`, { headers })).json()
  expect(latest.events.some((event: { kind: string }) => event.kind === 'operation-completed')).toBe(true)
  await ctx.fiber.dispose(); contexts.splice(contexts.indexOf(ctx), 1)
  await expect(fetch(base)).rejects.toThrow()
  const stoppedTick = reader.observe().tick
  // No timer survives disposal, even when its due time arrives later.
  vi.useFakeTimers()
  try { vi.advanceTimersByTime(10000); expect(reader.observe().tick).toBe(stoppedTick) }
  finally { vi.useRealTimers() }
})
