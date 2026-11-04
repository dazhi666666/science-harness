/** Credential routes remain native request headers, including usage and persisted history. */
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { toolCallResponse, textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { boot, Gate, type Probe } from '../platform/organization-fixture.ts'
import { mountMultiAgent } from './agents.ts'

let probe: Probe | undefined
afterEach(async () => { await probe?.close(); probe = undefined })

it('rotates one Agent through the same three routes available to the team and records actual route usage', async () => {
  const p = await boot('greenhouse-key-pool', true, async () => ({ withoutScience: true })); probe = p
  const pool = ['teams-probe', 'pool-2', 'pool-3']
  p.ctx.effect(() => p.ctx.llm.registerAdapter(pool.slice(1), p.model), 'greenhouse.test-key-routes')
  const scenarioFile = join(p.root, 'scenario.json')
  writeFileSync(scenarioFile, readFileSync(new URL('./fixtures/baseline.scenario.json', import.meta.url)))
  const continuation = new Gate()
  p.model.queue('lead', toolCallResponse('status-1', 'lab_status', {}), toolCallResponse('status-2', 'lab_status', {}),
    textResponse('Route smoke complete.'), continuation.step())
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  let run: Awaited<ReturnType<typeof mountMultiAgent>>
  try { run = await mountMultiAgent(p.ctx, { mode: 'single-agent', directory: join(p.root, 'run'), scenarioFile,
    project: 'cross-branch-project', port: 0, refreshMs: 100, providerCallTimeoutMs: 1000,
    source: 'scripted', model: { provider: pool[0]!, model: 'script' }, providerPool: pool }) }
  finally { log.mockRestore() }
  await vi.waitFor(() => expect(p.model.requests).toHaveLength(4))
  run.root.cancel({ kind: 'user' })
  await run.root.whenIdle(); continuation.release(); await p.ctx.sessionPersistence.flush()
  const routes = [...pool, pool[0]]
  expect(p.model.requests.map(request => request.options.provider)).toEqual(routes)
  expect(run.root.session.snapshotEvents(SessionLogOffset(0)).filter(event => event.type === 'request/header')
    .map(event => event.data.header.config.provider)).toEqual(routes)
  expect(run.metrics.requests).toBe(4)
  expect(Object.values(run.metrics.byProvider).map(usage => usage.requests)).toEqual([2, 1, 1])
  expect(run.team.snapshot().members).toHaveLength(1)
  const measured = spawnSync('python3', ['-c', 'import sys,json;sys.path.insert(0,sys.argv[1]);from compare import collect;print(json.dumps(collect(sys.argv[2],sessions=sys.argv[3])))',
    fileURLToPath(new URL('.', import.meta.url)), join(p.root, 'run'), join(p.root, 'sessions')], { encoding: 'utf8' })
  expect(measured.status, measured.stdout + measured.stderr).toBe(0)
  const report = JSON.parse(measured.stdout)
  expect(report).toMatchObject({ mode: 'single-agent', source: 'scripted', installation: null,
    perRoute: { 'teams-probe': { requests: 2 }, 'pool-2': { requests: 1 }, 'pool-3': { requests: 1 } } })
})
