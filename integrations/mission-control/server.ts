/** Mission Control: one loopback page that fuses the AI4Science dashboard and the Agent Router console.
 *
 * Neither source UI is modified. The Agent Router handler runs in-process under /router/*; the AI4Science
 * dashboard keeps its own loopback listener and bearer, and is reverse-proxied under /science/*.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export type Handler = (req: IncomingMessage, res: ServerResponse) => unknown

export interface Upstreams {
  /** Agent Router `createApp().handler`; requests arrive with the /router prefix stripped. */
  router?: Handler
  /** A started AI4Science dashboard: its loopback origin and per-run bearer. */
  science?: { url: string; token: string }
  /** Why the science side is unavailable, shown in the page. */
  scienceError?: string
}

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/fx.js', ['fx.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
])
const forwarded = ['content-type', 'content-disposition', 'content-length', 'cache-control']

/** Bind loopback only. Pages are public; /science, /router and /mc require the launch-link session. */
export async function startMissionControl(upstreams: Upstreams, options: { port: number }) {
  const token = randomBytes(32).toString('hex'),
    secret = Buffer.from(randomBytes(32).toString('hex'))
  let port = options.port
  const cookieName = () => `mission_control_${port}`
  const json = (res: ServerResponse, status: number, value: unknown) => {
    if (res.headersSent) return res.end()
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(value))
  }
  const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b)
  const bearer = (req: IncomingMessage) =>
    same(Buffer.from(req.headers.authorization ?? ''), Buffer.from(`Bearer ${token}`))
  const session = (req: IncomingMessage) => {
    const value = (req.headers.cookie ?? '')
      .split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith(cookieName() + '='))
      ?.slice(cookieName().length + 1)
    return same(Buffer.from(value ?? ''), secret)
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => json(res, 500, { error: error instanceof Error ? error.message : String(error) }))
  })

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`]
    if (!hosts.includes(req.headers.host ?? '')) return json(res, 403, { error: 'Local host required' })
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
      return json(res, 403, { error: 'Local origin required' })
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    if (req.method === 'GET' && assets.has(url.pathname)) {
      const [name, type] = assets.get(url.pathname)!
      res.writeHead(200, {
        'Content-Type': type!,
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      })
      return res.end(await readFile(new URL(`./public/${name}`, import.meta.url)))
    }
    // Exchange the launch-link bearer for an HttpOnly cookie so EventSource and downloads authenticate too.
    if (url.pathname === '/session' && req.method === 'POST') {
      if (!bearer(req)) return json(res, 401, { error: 'Invalid launch token' })
      res.setHeader('Set-Cookie', `${cookieName()}=${secret}; HttpOnly; SameSite=Strict; Path=/`)
      return json(res, 200, { ok: true })
    }
    if (!bearer(req) && !session(req))
      return json(res, 401, { error: 'Open the launch link printed by dsh to connect.' })

    if (url.pathname === '/mc/status')
      return json(res, 200, {
        science: !!upstreams.science,
        router: !!upstreams.router,
        scienceError: upstreams.scienceError ?? null,
      })
    if (url.pathname.startsWith('/router/')) {
      if (!upstreams.router) return json(res, 503, { error: 'Agent Router is not mounted' })
      req.url = url.pathname.slice('/router'.length) + url.search
      return upstreams.router(req, res)
    }
    if (url.pathname.startsWith('/science/api/')) {
      if (!upstreams.science) return json(res, 503, { error: upstreams.scienceError ?? 'Science engine is offline' })
      return proxy(req, res, upstreams.science, url.pathname.slice('/science'.length) + url.search)
    }
    return json(res, 404, { error: 'Not found' })
  }

  function proxy(req: IncomingMessage, res: ServerResponse, science: { url: string; token: string }, path: string) {
    const target = new URL(path, science.url)
    const headers: http.OutgoingHttpHeaders = { host: target.host, authorization: `Bearer ${science.token}` }
    for (const key of ['content-type', 'content-length']) if (req.headers[key]) headers[key] = req.headers[key]
    const upstream = http.request(target, { method: req.method, headers }, (reply) => {
      const out: http.OutgoingHttpHeaders = {}
      for (const key of forwarded) if (reply.headers[key]) out[key] = reply.headers[key]
      res.writeHead(reply.statusCode ?? 502, out)
      reply.pipe(res)
    })
    upstream.on('error', (error) => json(res, 502, { error: `Science engine unreachable: ${error.message}` }))
    req.pipe(upstream)
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No loopback listener')
  port = address.port
  const url = `http://127.0.0.1:${port}`
  return {
    server,
    url,
    token,
    launchUrl: `${url}/#${token}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
