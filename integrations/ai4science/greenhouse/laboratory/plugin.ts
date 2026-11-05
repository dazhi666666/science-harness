/** Laboratory dsh environment with the existing execution dashboard and Mission Control. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { ExecutionEngine } from '../../platform/execution.ts'
import { startDashboard } from '../../platform/dashboard.ts'
import { canonicalJson } from '../../platform/sdk.ts'
import { HARNESS_BASELINE } from '../../platform/version.ts'
import { startMissionControl } from '../../../mission-control/server.ts'
import { laboratoryScenarioSchema } from './schema.ts'
import { jointLaboratoryScenario } from './scenario.ts'
import { LaboratoryWorld } from './world.ts'
import { LaboratoryClock } from './clock.ts'
import { openLaboratoryProvider } from './provider.ts'
import { powerDemand, thermalEvent, waterAvailable } from './facilities.ts'

export const name = 'ai4science-laboratory-environment'
export const inject = []
const configSchema = z.object({ directory: z.string().min(1), seed: z.number().int().positive(), scenarioFile: z.string().min(1).optional(),
  port: z.number().int().min(0).max(65535), refreshMs: z.number().int().min(100), providerCallTimeoutMs: z.number().int().positive() }).strict()
export type Config = z.input<typeof configSchema>

/** Mount physical laboratory state and existing UI; a native Agent composition may attach its own clock driver.
 * @param ctx Owning Harness plugin context.
 * @param input Private runtime directory, source scenario or seed and local server settings.
 * @param experimentView Optional live native team view, owned by the calling composition.
 * @returns Runtime handles and one quiescent disposer.
 */
export async function mountLaboratory(ctx: Context, input: Config, experimentView?: () => Record<string, unknown>) {
  const config = configSchema.parse(input), directory = resolve(config.directory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const scenario = config.scenarioFile ? laboratoryScenarioSchema.parse(JSON.parse(readFileSync(resolve(config.scenarioFile), 'utf8'))) : jointLaboratoryScenario(config.seed)
  const scenarioFile = join(directory, 'scenario.json')
  const serialized = JSON.stringify(scenario, null, 2) + '\n'
  if (existsSync(scenarioFile)) {
    const previous = laboratoryScenarioSchema.parse(JSON.parse(readFileSync(scenarioFile, 'utf8')))
    if (canonicalJson(z.json().parse(previous)) !== canonicalJson(z.json().parse(scenario))) throw new Error('Laboratory scenario changed; use a new runtime directory')
  } else writeFileSync(scenarioFile, serialized, { mode: 0o600, flag: 'wx' })
  const world = new LaboratoryWorld(join(directory, 'device'), scenario)
  let clock: LaboratoryClock | undefined, engine: ExecutionEngine | undefined
  let opened: ReturnType<typeof openLaboratoryProvider> | undefined
  let dashboard: Awaited<ReturnType<typeof startDashboard>> | undefined
  let mission: Awaited<ReturnType<typeof startMissionControl>> | undefined
  const abort = new AbortController()
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
    clock = new LaboratoryClock(world, error => console.error(`Laboratory clock failed: ${error.message}`))
    opened = openLaboratoryProvider({ id: 'laboratory', directory: world.directory, scenarioFile }, () => clock!.wake())
    engine = new ExecutionEngine({ directory: join(directory, 'execution'), providers: [opened.provider],
      pollIntervalMs: config.refreshMs, providerCallTimeoutMs: config.providerCallTimeoutMs })
    await engine.open()
    for (const project of scenario.projects) engine.createProject(project.id, 0)
    dashboard = await startDashboard(engine, { apiVersion: 1, enabled: true, baseline: HARNESS_BASELINE,
      directory: engine.directory, pollIntervalMs: config.refreshMs, providerCallTimeoutMs: config.providerCallTimeoutMs,
      management: { actorId: 'laboratory-operator', projects: scenario.projects.map(project => project.id), allowedProviders: ['laboratory'] },
      providers: [{ module: fileURLToPath(new URL('./provider.ts', import.meta.url)), config: { id: 'laboratory', directory: world.directory, scenarioFile } }],
    }, { port: 0, refreshMs: config.refreshMs, signal: abort.signal })
    mission = await startMissionControl({ science: { url: dashboard.url, token: dashboard.token },
      laboratory: { snapshot: after => {
        const state = world.observe(), experiment = experimentView?.() ?? null
        return { mode: experiment?.mode ?? 'environment-only', experiment, scenarioHash: world.scenarioHash,
          utilities: { powerDemand: powerDemand(state), waterAvailable: waterAvailable(state) },
          projects: scenario.projects, clock: clock!.status(), world: state, events: world.events(after) }
      } },
    }, { port: config.port })
    if (!experimentView) clock.attach(() => {
      const state = world.observe()
      return state.operations.some(operation => operation.state === 'running') || state.shipments.some(shipment => !shipment.delivered) || thermalEvent(state) !== null
    }, async () => {})
    ctx.effect(() => close, 'laboratory.environment')
    console.log(`Mission Control: ${mission.launchUrl}`)
    return { world, clock, engine, mission, close }
  } catch (error) { await close(); throw error }
}

/** Mount the environment through the standard dsh profile lifecycle.
 * @param ctx Owning Harness plugin context.
 * @param config Laboratory directory and local server settings.
 */
export async function apply(ctx: Context, config: Config): Promise<void> { await mountLaboratory(ctx, config) }
