/** Environment-only dsh profile: one clock and execution engine feed the existing Mission Control UI. */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { ExecutionEngine } from '../platform/execution.ts'
import { startDashboard } from '../platform/dashboard.ts'
import { HARNESS_BASELINE } from '../platform/version.ts'
import { startMissionControl } from '../../mission-control/server.ts'
import { scenarioSchema } from './schema.ts'
import { GreenhouseWorld } from './world.ts'
import { GreenhouseClock } from './clock.ts'
import { openProvider } from './provider.ts'

export const name = 'ai4science-greenhouse-environment'
export const inject = []
const configSchema = z.object({ directory: z.string().min(1), scenarioFile: z.string().min(1),
  project: z.string().min(1), port: z.number().int().min(0).max(65535),
  clockMode: z.enum(['timer', 'event-driven']).default('timer'), idleReviewTicks: z.number().int().positive().default(30),
  refreshMs: z.number().int().min(100).max(60000), providerCallTimeoutMs: z.number().int().positive() }).strict()
export type Config = z.input<typeof configSchema>

/** Mount the environment and authenticated frontend without creating Agents or calling models.
 * @param ctx Existing Harness plugin context.
 * @param input World location, scenario, local port and observation settings.
 * @param experimentView Optional project-scoped live Agent/task view, shared with the existing frontend.
 * @returns Runtime handles for integration tests and later Agent compositions.
 */
export async function mountEnvironment(ctx: Context, input: Config, experimentView?: () => Record<string, unknown>) {
  const config = configSchema.parse(input)
  const directory = resolve(config.directory), scenarioFile = resolve(config.scenarioFile)
  const scenario = scenarioSchema.parse(JSON.parse(readFileSync(scenarioFile, 'utf8')))
  const world = new GreenhouseWorld(join(directory, 'device'), scenario)
  let clock: GreenhouseClock | undefined
  let opened: ReturnType<typeof openProvider> | undefined
  let engine: ExecutionEngine | undefined
  const abort = new AbortController()
  let dashboard: Awaited<ReturnType<typeof startDashboard>> | undefined
  let mission: Awaited<ReturnType<typeof startMissionControl>> | undefined
  let closing: Promise<void> | undefined
  const close = () => (closing ??= (async () => {
    await mission?.close()
    abort.abort()
    await dashboard?.closed
    await clock?.close()
    await engine?.close()
    opened?.close()
    world.close()
  })())
  try {
    opened = openProvider({ id: 'greenhouse', directory: world.directory, scenarioFile })
    engine = new ExecutionEngine({ directory: join(directory, 'execution'), providers: [opened.provider],
      pollIntervalMs: config.refreshMs, providerCallTimeoutMs: config.providerCallTimeoutMs })
    await engine.open()
    engine.createProject(config.project, 0)
    clock = new GreenhouseClock(world, error => console.error(`Greenhouse clock failed: ${error.message}`), config.clockMode, config.idleReviewTicks)
    dashboard = await startDashboard(engine, {
      apiVersion: 1, enabled: true, baseline: HARNESS_BASELINE, directory: engine.directory,
      pollIntervalMs: config.refreshMs, providerCallTimeoutMs: config.providerCallTimeoutMs,
      management: { actorId: 'greenhouse-operator', projects: [config.project], allowedProviders: ['greenhouse'] },
      providers: [{ module: fileURLToPath(new URL('./provider.ts', import.meta.url)),
        config: { id: 'greenhouse', directory: world.directory, scenarioFile } }],
    }, { port: 0, refreshMs: config.refreshMs, signal: abort.signal })
    mission = await startMissionControl({ science: { url: dashboard.url, token: dashboard.token },
      greenhouse: { snapshot: after => ({ mode: experimentView?.().mode ?? 'environment-only', experiment: experimentView?.() ?? null, scenarioHash: world.scenarioHash,
        project: config.project, clock: clock!.status(), world: world.observe(), events: world.events(after) }) },
    }, { port: config.port })
    ctx.effect(() => close, 'greenhouse.environment')
    console.log(`Mission Control: ${mission.launchUrl}`)
    return { world, clock, engine, mission }
  } catch (error) {
    await close()
    throw error
  }
}

/** Loader entry owns the environment lifecycle and returns no installation object. */
export async function apply(ctx: Context, config: Config): Promise<void> { await mountEnvironment(ctx, config) }
