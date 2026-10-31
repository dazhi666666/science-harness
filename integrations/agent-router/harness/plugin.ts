/** Agent Router console mounted only through dsh's profile lifecycle (no standalone package bin). */
import http from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentRouterApp, AgentRouterModules } from './modules.ts'

export const name = 'agent-router-console'
export const inject = []

export interface Config {
  /** Main console port; the live-stream port is port + 1. */
  port: number
  /** Run data directory; empty keeps the copied module default (integrations/agent-router/data). */
  dataDir: string
}

export const Config: z<Config> = z.object({
  port: z.number().min(1).max(65535).default(2288),
  dataDir: z.string(),
})

/** Serve the console on 127.0.0.1; stop it, and every running router, on disposal. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const web = (await import('../web/server.mjs')) as AgentRouterModules
  const app: AgentRouterApp = web.createApp(config.dataDir ? { dataDir: config.dataDir } : {})
  const streams = http.createServer(app.handler)

  await listen(app.server, config.port)
  console.log(`Agent Router: http://127.0.0.1:${config.port}`)
  // The live-stream port is best effort: a busy port only loses the dedicated
  // stream pool, and the front end falls back to same-origin streaming.
  try { await listen(streams, config.port + 1) } catch (e) {
    console.warn(`Agent Router 会话流端口 ${config.port + 1} 不可用（${e instanceof Error ? e.message : e}），前端将回退同源流`)
  }

  // effect(execute) runs execute now and collects the returned disposer for fiber unload.
  ctx.effect(() => () => {
    for (const run of app.runs.active.values()) {
      if (run.status !== 'running') continue
      try { app.runs.kill(run.child) } catch {}
    }
    for (const server of [app.server, streams]) server.close()
  }, 'agent-router.console.close')
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
}
