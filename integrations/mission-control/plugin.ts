/** Mission Control mounted only through dsh's profile lifecycle: one page for science execution and agent routing. */
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentRouterApp, AgentRouterModules } from '../agent-router/harness/modules.ts'
import { startMissionControl, type Upstreams } from './server.ts'

export const name = 'mission-control'
export const inject = []

export interface Config {
  port: number
  /** AI4Science platform JSON; empty uses the bundled synthetic example, `off` skips the science side. */
  scienceConfig: string
  /** Agent Router run data directory; empty keeps its default (integrations/agent-router/data). */
  routerDataDir: string
  refreshMs: number
}

export const Config: z<Config> = z.object({
  port: z.number().min(0).max(65535).default(2300),
  scienceConfig: z.string(),
  routerDataDir: z.string(),
  refreshMs: z.number().min(100).max(60000).default(1000),
})

const exampleConfig = fileURLToPath(new URL('../ai4science/platform/examples/local.config.json', import.meta.url))

/** Either side may fail to open; the page then shows that side offline instead of refusing to start. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const abort = new AbortController()
  const upstreams: Upstreams = {}
  let engine: { close(): Promise<void> } | undefined
  let dashboard: { closed: Promise<void> } | undefined
  let router: AgentRouterApp | undefined

  if (config.scienceConfig !== 'off') {
    try {
      const { openConfiguredEngine } = await import('../ai4science/platform/config.ts')
      const { startDashboard } = await import('../ai4science/platform/dashboard.ts')
      const opened = await openConfiguredEngine(config.scienceConfig || exampleConfig)
      engine = opened.engine
      const started = await startDashboard(opened.engine, opened.config, {
        port: 0,
        refreshMs: config.refreshMs,
        signal: abort.signal,
      })
      dashboard = started
      upstreams.science = { url: started.url, token: started.token }
    } catch (error) {
      upstreams.scienceError = error instanceof Error ? error.message : String(error)
      console.warn(`Mission Control: science engine offline (${upstreams.scienceError})`)
    }
  } else upstreams.scienceError = 'Science side disabled (scienceConfig: off)'

  const web = (await import('../agent-router/web/server.mjs')) as AgentRouterModules
  router = web.createApp(config.routerDataDir ? { dataDir: config.routerDataDir } : {})
  upstreams.router = router.handler

  const mc = await startMissionControl(upstreams, { port: config.port })
  console.log(`Mission Control: ${mc.launchUrl}`)

  ctx.effect(
    () => async () => {
      await mc.close()
      for (const run of router?.runs.active.values() ?? []) {
        if (run.status !== 'running') continue
        try {
          router!.runs.kill(run.child)
        } catch {}
      }
      abort.abort()
      await dashboard?.closed
      await engine?.close()
    },
    'mission-control.close',
  )
}
