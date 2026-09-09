/** Local HTTP access must preserve project/provider permissions and execution lifecycle. */
import { it, expect } from 'vitest'
import { request as httpRequest } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionEngine } from './execution.ts'
import { startDashboard } from './dashboard.ts'
import { createProvider } from './providers/compute.ts'
import { HARNESS_BASELINE } from './version.ts'
import type { PlatformConfig } from './config.ts'

it('serves real state, rejects foreign origins/callers/scopes, and exports only checked artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'science-dashboard-'))
  const engine = new ExecutionEngine({
    directory: join(root, 'execution'),
    providers: [
      createProvider({
        id: 'compute',
        directory: join(root, 'device'),
        resource: 'cpu',
        tickMs: 1,
        chunkSize: 2,
      }),
    ],
    pollIntervalMs: 2,
    providerCallTimeoutMs: 1000,
  })
  await engine.open()
  engine.createProject('visible', 100)
  engine.createProject('hidden', 100)
  const config = {
    apiVersion: 1,
    enabled: true,
    baseline: HARNESS_BASELINE,
    directory: engine.directory,
    pollIntervalMs: 2,
    providerCallTimeoutMs: 1000,
    management: { actorId: 'operator', projects: ['visible', 'new-project'], allowedProviders: ['compute'] },
    providers: [],
  } as PlatformConfig
  const controller = new AbortController()
  const app = await startDashboard(engine, config, { port: 0, refreshMs: 100, signal: controller.signal })
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(app.url + path, { headers: { Authorization: `Bearer ${app.token}`, ...headers } })
  const post = (value: unknown) =>
    fetch(app.url + '/api/action', {
      method: 'POST',
      headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json', Origin: app.url },
      body: JSON.stringify(value),
    })
  try {
    expect((await fetch(app.url + '/')).status).toBe(200)
    const introduction = await fetch(app.url + '/about')
    expect(introduction.status).toBe(200)
    expect(introduction.headers.get('content-type')).toContain('text/html')
    expect(await introduction.text()).toContain('CONCEPTUAL WALKTHROUGH')
    expect((await fetch(app.url + '/about.css')).headers.get('content-type')).toContain('text/css')
    expect((await fetch(app.url + '/about.js')).headers.get('content-type')).toContain('text/javascript')
    expect((await get('/unknown-asset.js')).status).toBe(404)
    expect((await fetch(app.url + '/api/state')).status).toBe(401)
    expect((await get('/api/state', { Origin: 'https://unrelated.example' })).status).toBe(403)
    const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        app.url + '/api/state',
        { headers: { Host: 'unrelated.example', Authorization: `Bearer ${app.token}` } },
        (response) => {
          response.resume()
          response.on('end', () => resolve(response.statusCode))
        },
      )
      request.on('error', reject)
      request.end()
    })
    expect(foreignHost).toBe(403)
    const stateResponse = await get('/api/state')
    const cookie = stateResponse.headers.get('set-cookie')!.split(';')[0]!
    expect(stateResponse.headers.get('set-cookie')).toContain('HttpOnly')
    expect(stateResponse.headers.get('set-cookie')).toContain('SameSite=Strict')
    expect((await fetch(app.url+'/api/action',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({action:'create',project:'new-project',budget:1})})).status).toBe(401)
    expect((await fetch(app.url + '/api/state', { headers: { Cookie: cookie } })).status).toBe(401)
    const state = await stateResponse.json()
    expect(state.projects.map((p: { id: string }) => p.id)).toEqual(['visible'])
    expect(state.providers[0].configuration).toBeUndefined()
    expect((await get('/api/state?project=hidden')).status).toBe(400)
    expect((await post({ action: 'create', project: 'hidden', budget: 100 })).status).toBe(400)
    expect(
      (
        await post({
          action: 'submit',
          project: 'visible',
          providerId: 'unregistered',
          requestKey: 'bad',
          input: {},
        })
      ).status,
    ).toBe(400)
    const op = await (
      await post({
        action: 'submit',
        project: 'visible',
        providerId: 'compute',
        requestKey: 'one',
        input: { text: 'abc', iterations: 4 },
      })
    ).json()
    expect(op.id).toBeTruthy()
    const result = await engine.wait(engine.issueContext('visible', 'test', ['compute']), op.id, {
      timeoutMs: 1000,
    })
    expect(result.state).toBe('succeeded')
    const duplicate = await (
      await post({
        action: 'submit',
        project: 'visible',
        providerId: 'compute',
        requestKey: 'one',
        input: { text: 'abc', iterations: 4 },
      })
    ).json()
    expect(duplicate.id).toBe(op.id)
    const artifact = result.artifacts[0]!
    expect(
      (await (await get('/api/artifact?project=visible&id=' + artifact.id)).json()).artifact.sha256,
    ).toBe(artifact.sha256)
    const download = await fetch(
      app.url + '/api/artifact?project=visible&id=' + artifact.id + '&download=1',
      { headers: { Cookie: cookie } },
    )
    expect(download.headers.get('content-disposition')).toContain('attachment')
    expect(await download.text()).toContain('sha256-chain')
    writeFileSync(join(engine.directory, artifact.path), 'changed')
    expect((await get('/api/artifact?project=visible&id=' + artifact.id)).status).toBe(400)
    expect((await post({ action: 'create', project: 'new-project', budget: 10 })).status).toBe(200)
  } finally {
    await app.close()
    await engine.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('background monitoring observes cancellation; closing the page server does not cancel equipment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'science-dashboard-close-'))
  const provider = createProvider({
    id: 'compute',
    directory: join(root, 'device'),
    resource: 'cpu',
    tickMs: 1,
    chunkSize: 2,
  })
  const engine = new ExecutionEngine({
    directory: join(root, 'execution'),
    providers: [provider],
    pollIntervalMs: 2,
    providerCallTimeoutMs: 1000,
  })
  await engine.open()
  engine.createProject('p', 10000)
  const config = {
    apiVersion: 1,
    enabled: true,
    baseline: HARNESS_BASELINE,
    directory: engine.directory,
    pollIntervalMs: 2,
    providerCallTimeoutMs: 1000,
    management: { actorId: 'operator', projects: ['p'], allowedProviders: ['compute'] },
    providers: [],
  } as PlatformConfig
  const controller = new AbortController()
  const app = await startDashboard(engine, config, { port: 0, refreshMs: 100, signal: controller.signal })
  const c = engine.issueContext('p', 'operator', ['compute'])
  try {
    const op = await engine.submit(c, {
      providerId: 'compute',
      requestKey: 'cancel',
      input: { text: 'abc', iterations: 1000 },
    })
    await engine.cancel(c, op.id)
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (engine.get(c, op.id).state === 'cancelled') {
          clearInterval(timer)
          clearTimeout(timeout)
          resolve()
        }
      }, 20)
      const timeout = setTimeout(() => {
        clearInterval(timer)
        reject(new Error('Cancellation not observed'))
      }, 2000)
    })
    const remaining = await engine.submit(c, {
      providerId: 'compute',
      requestKey: 'keep',
      input: { text: 'abc', iterations: 1000 },
    })
    controller.abort()
    await app.closed
    expect(engine.get(c, remaining.id).cancelRequested).toBe(false)
    expect(engine.get(c, remaining.id).state).toBe('running')
  } finally {
    await app.close()
    await engine.close()
    rmSync(root, { recursive: true, force: true })
  }
})
