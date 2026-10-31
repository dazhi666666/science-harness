/** Harness adapter probe: real cordis plugin mounting, console + health over HTTP, clean disposal. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Plugin from './plugin.ts'

const contexts: Context[] = []
const roots: string[] = []

afterAll(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('mounted plugin serves /console/ and /api/health, then disposal closes the port', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-router-probe-'))
  roots.push(dataDir)
  const ctx = new Context()
  contexts.push(ctx)
  // Mount as a child plugin (what the dsh loader does): ctx.effect disposals
  // live on the plugin fiber and run at disposal, not at registration.
  await ctx.plugin(Plugin, { port: 23331, dataDir })

  const consoleRes = await fetch('http://127.0.0.1:23331/console/')
  expect(consoleRes.status).toBe(200)
  expect(await consoleRes.text()).toContain('Agent Router')

  const healthRes = await fetch('http://127.0.0.1:23331/api/health')
  expect(healthRes.status).toBe(200)
  const health = (await healthRes.json()) as Record<string, unknown>
  expect(health).toHaveProperty('dsh')

  await ctx.fiber.dispose()
  contexts.pop()
  await expect(fetch('http://127.0.0.1:23331/api/health')).rejects.toThrow()
}, 20000)
