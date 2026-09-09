/** Local management UI. Reuses one ExecutionEngine and its configured operator scope. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { ExecutionEngine } from './execution.ts'
import type { PlatformConfig } from './config.ts'
import { HARNESS_BASELINE } from './version.ts'
import { Artifacts } from './artifacts.ts'
import type { Json } from './sdk.ts'

const mutation = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('create'),
      project: z.string().min(1),
      budget: z.number().finite().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal('submit'),
      project: z.string().min(1),
      providerId: z.string().min(1),
      requestKey: z.string().min(1),
      input: z.json(),
    })
    .strict(),
  z
    .object({
      action: z.enum(['query', 'cancel']),
      project: z.string().min(1),
      operationId: z.string().min(1),
    })
    .strict(),
  z.object({ action: z.literal('reconcile'), project: z.string().min(1) }).strict(),
])
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/about', ['about.html', 'text/html; charset=utf-8']],
  ['/about.js', ['about.js', 'text/javascript; charset=utf-8']],
  ['/about.css', ['about.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
])
const maxBodyBytes = 1024 * 1024
const maxArtifactBytes = 16 * 1024 * 1024

async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.toLowerCase() !== 'application/json')
    throw new Error('Use application/json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const data = Buffer.from(chunk)
    size += data.length
    if (size > maxBodyBytes) throw new Error('Request exceeds 1 MiB')
    chunks.push(data)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Bind loopback only; the random per-run bearer must accompany every API request. */
export async function startDashboard(
  engine: ExecutionEngine,
  config: PlatformConfig,
  options: { port: number; refreshMs: number; signal: AbortSignal },
) {
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535)
    throw new Error('Port must be 0..65535')
  if (!Number.isSafeInteger(options.refreshMs) || options.refreshMs < 100 || options.refreshMs > 60000)
    throw new Error('Refresh interval must be 100..60000 ms')
  const downloadSecret = randomBytes(32).toString('hex')
  const token = randomBytes(32).toString('hex'),
    artifacts = new Artifacts(engine)
  let monitorError: string | null = null
  let origin = '',
    closing = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    monitoring: Promise<void> | undefined
  const pending = new Set<Promise<void>>()
  const completion = Promise.withResolvers<void>()
  const access = (project: string) => {
    if (!config.management.projects.includes(project))
      throw new Error('Project is outside configured management scope')
    return engine.issueContext(project, config.management.actorId, config.management.allowedProviders)
  }
  const inventory = () => engine.projects().filter((p) => config.management.projects.includes(p.id))
  const json = (response: ServerResponse, value: unknown, status = 200) => {
    if (response.destroyed) return
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(value))
  }
  const server = createServer((request, response) => {
    const task = handle(request, response).catch((error) =>
      json(response, { error: error instanceof Error ? error.message : String(error) }, 400),
    )
    pending.add(task)
    void task.finally(() => pending.delete(task))
  })
  server.requestTimeout = 10000
  server.headersTimeout = 10000
  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    )
    response.setHeader('Referrer-Policy', 'no-referrer')
    if (
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin && request.headers.origin !== origin)
    )
      return json(response, { error: 'Local origin required' }, 403)
    const url = new URL(request.url ?? '/', origin)
    if (request.method === 'GET' && assets.has(url.pathname)) {
      const [name, type] = assets.get(url.pathname)!
      const bytes = readFileSync(new URL(`./dashboard/${name}`, import.meta.url))
      response.writeHead(200, { 'Content-Type': type! })
      response.end(bytes)
      return
    }
    const received = Buffer.from(request.headers.authorization ?? ''),
      expected = Buffer.from(`Bearer ${token}`)
    const headerAuthorized = received.length === expected.length && timingSafeEqual(received, expected)
    const cookieName = 'science_download_' + new URL(origin).port
    const cookie = Buffer.from(
      (request.headers.cookie ?? '')
        .split(';')
        .map((v) => v.trim())
        .find((v) => v.startsWith(cookieName + '='))
        ?.slice(cookieName.length + 1) ?? '',
    )
    const downloadKey = Buffer.from(downloadSecret)
    const downloadAuthorized =
      request.method === 'GET' &&
      url.pathname === '/api/artifact' &&
      url.searchParams.get('download') === '1' &&
      cookie.length === downloadKey.length &&
      timingSafeEqual(cookie, downloadKey)
    if (!headerAuthorized && !downloadAuthorized)
      return json(response, { error: 'Open the launch link printed by the local server to connect.' }, 401)
    // Only native artifact downloads accept this HttpOnly session cookie; control APIs still require the bearer.
    if (headerAuthorized)
      response.setHeader(
        'Set-Cookie',
        `${cookieName}=${downloadSecret}; HttpOnly; SameSite=Strict; Path=/api/artifact`,
      )
    if (closing) return json(response, { error: 'Management is closing; equipment state is unchanged' }, 503)
    if (request.method === 'GET' && url.pathname === '/api/state') {
      const project = url.searchParams.get('project') ?? inventory()[0]?.id
      let operations: ReturnType<ExecutionEngine['list']> = [],
        providers: unknown[] = [],
        outputs: unknown[] = []
      if (project) {
        const c = access(project)
        operations = engine.list(c)
        providers = engine.descriptions(c).map(({ configuration: _, ...description }) => description)
        outputs = operations.flatMap((o) => o.artifacts.map((a) => ({ ...a, requestKey: o.requestKey })))
        // Project artifacts also use the existing recursive source and integrity checks.
        for (const a of artifacts.list(c)) {
          if (a.bytes > maxArtifactBytes) continue
          try {
            artifacts.read(c, a.id)
            outputs.push({ ...a, requestKey: 'Project artifact' })
          } catch {
            /* Inaccessible or damaged derived output is not advertised as readable. */
          }
        }
      }
      return json(response, {
        projects: inventory(),
        allowedProjects: config.management.projects,
        selectedProject: project ?? null,
        operations,
        providers,
        artifacts: outputs,
        baseline: HARNESS_BASELINE,
        monitorError,
        observedAt: new Date().toISOString(),
        refreshMs: options.refreshMs,
      })
    }
    if (request.method === 'GET' && url.pathname === '/api/artifact') {
      const project = url.searchParams.get('project') ?? '',
        id = url.searchParams.get('id') ?? '',
        c = access(project)
      const metadata =
        engine
          .list(c)
          .flatMap((o) => o.artifacts)
          .find((a) => a.id === id) ?? artifacts.list(c).find((a) => a.id === id)
      if (!metadata) throw new Error('Unknown or inaccessible artifact')
      if (metadata.bytes > maxArtifactBytes)
        throw new Error('Artifact exceeds the 16 MiB browser limit; export it with the CLI')
      const result = artifacts.read(c, id)
      if (url.searchParams.get('download') === '1') {
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${metadata.path
            .split('/')
            .at(-1)!
            .replace(/[^\w.-]/g, '_')}"`,
        })
        response.end(Buffer.from(result.content, result.encoding))
        return
      }
      return json(response, result)
    }
    if (request.method === 'POST' && url.pathname === '/api/action') {
      const action = mutation.parse(await body(request))
      if (!config.management.projects.includes(action.project))
        throw new Error('Project is outside configured management scope')
      if (action.action === 'create') {
        engine.createProject(action.project, action.budget)
        return json(response, { created: true })
      }
      const c = access(action.project)
      switch (action.action) {
        case 'submit':
          return json(
            response,
            await engine.submit(c, {
              providerId: action.providerId,
              requestKey: action.requestKey,
              input: action.input as Json,
            }),
          )
        case 'query':
          return json(response, await engine.query(c, action.operationId))
        case 'cancel':
          return json(response, await engine.cancel(c, action.operationId))
        case 'reconcile':
          return json(response, await engine.reconcile(c))
      }
    }
    return json(response, { error: 'Not found' }, 404)
  }
  async function monitor() {
    try {
      monitorError = null
      for (const p of inventory()) {
        if (closing) break
        const c = access(p.id)
        for (const op of engine.list(c))
          if (['registered', 'dispatching', 'accepted', 'running'].includes(op.state)) {
            if (closing) break
            await engine.query(c, op.id)
          }
      }
    } finally {
      if (!closing)
        timer = setTimeout(() => {
          monitoring = monitor().catch((error) => {
            if (!closing) monitorError = String(error)
          })
        }, options.refreshMs)
    }
  }
  let closePromise: Promise<void> | undefined
  function close() {
    return (closePromise ??= (async () => {
      closing = true
      clearTimeout(timer)
      options.signal.removeEventListener('abort', abort)
      const stopped = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      server.closeAllConnections()
      await Promise.allSettled([...pending, ...(monitoring ? [monitoring] : [])])
      await stopped
      completion.resolve()
    })())
  }
  const abort = () => {
    void close().catch(completion.reject)
  }
  options.signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No loopback listener')
  origin = `http://127.0.0.1:${address.port}`
  options.signal.addEventListener('abort', abort, { once: true })
  if (options.signal.aborted) await close()
  else
    timer = setTimeout(() => {
      monitoring = monitor().catch((error) => {
        if (!closing) monitorError = String(error)
      })
    }, options.refreshMs)
  return { url: origin, launchUrl: `${origin}/#${token}`, token, close, closed: completion.promise }
}
