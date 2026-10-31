/** Mission Control probe: real cordis mounting, both upstreams reachable through one authenticated origin, clean disposal. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Plugin from './plugin.ts'

const contexts: Context[] = []
const roots: string[] = []
const port = 23340
const base = `http://127.0.0.1:${port}`

afterAll(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** The bundled example, rewritten so provider modules stay absolute and every data directory is temporary. */
async function scienceConfig(root: string) {
  const example = fileURLToPath(new URL('../ai4science/platform/examples/local.config.json', import.meta.url))
  const config = JSON.parse(await readFile(example, 'utf8'))
  config.directory = join(root, 'platform')
  for (const provider of config.providers) {
    provider.module = resolve(dirname(example), provider.module)
    provider.config.directory = join(root, String(provider.config.id))
  }
  const path = join(root, 'science.json')
  await writeFile(path, JSON.stringify(config))
  return path
}

it('serves the fused page, gates APIs on the launch token, and proxies both upstreams', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mission-control-probe-'))
  roots.push(root)
  const log = vi.spyOn(console, 'log')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Plugin, { port, scienceConfig: await scienceConfig(root), routerDataDir: join(root, 'router'), refreshMs: 1000 })

  const launch = log.mock.calls.map((c) => String(c[0])).find((line) => line.startsWith('Mission Control: '))
  log.mockRestore()
  expect(launch).toBeDefined()
  const token = launch!.split('#')[1]!

  const page = await fetch(`${base}/`)
  expect(page.status).toBe(200)
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  expect(await page.text()).toContain('Mission Control')

  expect((await fetch(`${base}/mc/status`)).status).toBe(401)
  expect((await fetch(`${base}/mc/status`, { headers: { Origin: 'http://evil.test' } })).status).toBe(403)
  expect((await fetch(`${base}/session`, { method: 'POST', headers: { Authorization: 'Bearer nope' } })).status).toBe(401)

  const session = await fetch(`${base}/session`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
  expect(session.status).toBe(200)
  const cookie = session.headers.get('set-cookie')!.split(';')[0]!
  const headers = { Cookie: cookie }

  expect(await (await fetch(`${base}/mc/status`, { headers })).json()).toMatchObject({ science: true, router: true })

  // /router/api/health is skipped: it scans every CLI (tens of seconds) and the agent-router probe covers it.
  const workspace = (await (await fetch(`${base}/router/api/workspace`, { headers })).json()) as Record<string, unknown>
  expect(workspace).toHaveProperty('repo')
  expect(await (await fetch(`${base}/router/api/runs`, { headers })).json()).toEqual([])

  const state = (await (await fetch(`${base}/science/api/state`, { headers })).json()) as Record<string, unknown>
  expect(state.allowedProjects).toEqual(['example'])
  const created = await fetch(`${base}/science/api/action`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create', project: 'example', budget: 100 }),
  })
  expect(await created.json()).toEqual({ created: true })
  const after = (await (await fetch(`${base}/science/api/state`, { headers })).json()) as { providers: unknown[] }
  expect(after.providers.length).toBe(2)

  await ctx.fiber.dispose()
  contexts.pop()
  await expect(fetch(`${base}/`)).rejects.toThrow()
}, 30000)
