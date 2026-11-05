/** Real plugin lifecycle and authenticated Mission Control share one physical laboratory. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as Plugin from './plugin.ts'
const contexts: Context[] = [], roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it('serves actual devices and projects, protects snapshots and advances submitted operations without a host clock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'laboratory-frontend-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  const lines: string[] = [], log = vi.spyOn(console, 'log').mockImplementation(value => lines.push(String(value)))
  try { await ctx.plugin(Plugin, { directory: root, seed: 1, port: 0, refreshMs: 100, providerCallTimeoutMs: 1000 }) }
  finally { log.mockRestore() }
  const link = new URL(lines.find(line => line.startsWith('Mission Control: '))!.slice('Mission Control: '.length))
  const headers = { Authorization: `Bearer ${link.hash.slice(1)}` }, base = link.origin
  expect((await fetch(`${base}/mc/laboratory`)).status).toBe(401)
  expect((await fetch(`${base}/mc/laboratory`, { method: 'POST', headers })).status).toBe(405)
  expect((await fetch(`${base}/mc/laboratory?after=-1`, { headers })).status).toBe(400)
  expect((await fetch(`${base}/mc/laboratory`, { headers: { ...headers, Origin: 'https://foreign.test' } })).status).toBe(403)
  expect(await (await fetch(`${base}/mc/status`, { headers })).json()).toMatchObject({ laboratory: true, science: true })
  expect(await (await fetch(base)).text()).toContain('data-view="laboratory"')
  expect((await fetch(`${base}/laboratory.js`)).status).toBe(200)
  const read = async () => (await fetch(`${base}/mc/laboratory`, { headers })).json()
  const initial = await read()
  expect(initial.projects).toHaveLength(6)
  expect(initial.world.devices).toHaveLength(20)
  expect(initial.world.samples).toHaveLength(48)
  expect(initial.world.tick).toBe(0)
  expect(initial.experiment).toBeNull()
  expect(JSON.stringify(initial)).not.toMatch(/water-filter-interruption|restored-power|extraction-recall/)
  expect((await read()).world.tick).toBe(0)
  const response = await fetch(`${base}/science/api/action`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'submit', project: 'P1', providerId: 'laboratory', requestKey: 'operator-clean', input: { action: 'clean', deviceId: 'heater-1' } }) })
  expect(response.status).toBe(200)
  const accepted = await response.json()
  await vi.waitFor(async () => expect((await read()).world.operations[0].state).toBe('succeeded'))
  const retry = await fetch(`${base}/science/api/action`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'submit', project: 'P1', providerId: 'laboratory', requestKey: 'operator-clean', input: { action: 'clean', deviceId: 'heater-1' } }) })
  expect((await retry.json()).id).toBe(accepted.id)
  const latest = await read()
  expect(latest.world.operations).toHaveLength(1)
  expect(latest.world.tick).toBe(6)
  expect(latest.events.some((event: { kind: string }) => event.kind === 'operation-finished')).toBe(true)
  const createView: (input: { api: (path: string) => Promise<object>, t: (value: string) => string, esc: (value: string) => string,
    num: (value: number) => string, available: () => boolean }) => { mount: (stage: object) => void, load: () => Promise<void> } =
    runInNewContext(readFileSync(new URL('../../../mission-control/public/laboratory.js', import.meta.url), 'utf8').replace('export function', 'function') + '\ncreateLaboratoryView')
  const display = { innerHTML: '', querySelectorAll: () => [] }
  const stage = { innerHTML: '', querySelector: () => display }
  let actorsAvailable = true
  const viewApi = async (path: string) => {
    if (!actorsAvailable && path.startsWith('/science/api/state')) throw new Error('Actor endpoint unavailable')
    return (await fetch(base + path, { headers })).json()
  }
  const displayOptions = { api: viewApi, t: (value: string) => value, esc: (value: string) => value, num: String, available: () => true }
  const view = createView(displayOptions)
  view.mount(stage)
  await vi.waitFor(() => expect(display.innerHTML).toContain('人工介入次数 1</p>'))
  await view.load()
  expect(display.innerHTML).toContain('人工介入次数 1</p>')
  actorsAvailable = false
  const pending = createView(displayOptions)
  pending.mount(stage)
  await vi.waitFor(() => expect(display.innerHTML).toContain('人工介入次数 — · 执行者信息待核验'))
  actorsAvailable = true
  await pending.load()
  expect(display.innerHTML).toContain('人工介入次数 1</p>')
  await ctx.fiber.dispose(); contexts.splice(contexts.indexOf(ctx), 1)
  await expect(fetch(base)).rejects.toThrow()
})
