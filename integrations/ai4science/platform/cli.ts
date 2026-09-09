/** Management application mounted only through dsh's profile lifecycle. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-cmdline'
import z from '@deepseek-ai/schemastery'
import { openConfiguredEngine } from './config.ts'
import type { ExecutionEngine } from './execution.ts'
import type { Json } from './sdk.ts'
import { Artifacts } from './artifacts.ts'
import { startDashboard } from './dashboard.ts'
import { pathToFileURL } from 'node:url'

export const name = 'ai4science-management'
export const inject = ['cmdlineArgs', 'appReady', 'appExit']
export interface Config {
  configPath: string
}
export const Config: z<Config> = z.object({ configPath: z.string().required() })

const help = `AI4Science infrastructure v0.2 — dsh --profile ai4science <command> [options]
  create    --project ID --budget NUMBER
  start     --project ID --provider ID --key KEY --input JSON_FILE [--wait --timeout-ms NUMBER]
  status    --project ID
  describe  --project ID
  facts     --project ID
  list      --project ID
  query     --project ID --operation ID
  wait      --project ID --operation ID [--timeout-ms NUMBER]
  cancel    --project ID --operation ID
  export    --project ID --artifact ID --target FILE
  reconcile --project ID
  stop      --project ID
  serve     [--port NUMBER --refresh-ms NUMBER]
  experiment-create --project ID --key KEY --input REQUEST_JSON
  experiment-list   --project ID
  experiment-status --project ID --experiment ID
  experiment-act    --project ID --experiment ID --input DECISION_JSON
  experiment-wait   --project ID --experiment ID [--after NUMBER --until change|decision --timeout-ms NUMBER]
  experiment-cancel --project ID --experiment ID
  experiment-escalate --project ID --experiment ID --input PROPOSAL_JSON --reason TEXT
  experiment-resolve --project ID --experiment ID --reason TEXT
  experiment-finish --project ID --experiment ID --input COMPLETION_JSON
  experiment-assess --project ID --experiment ID --assessor TRUSTED_MODULE
Existing experiment mutations explicitly claim control as the currently configured CLI operator; persisted actor IDs confer no authority.
Each invocation opens the same durable domain, reconciles unfinished operations, then closes its controller.
stop closes management only. It does not cancel or prove that a device has stopped.
Cancellation is a request; inspect the returned observed operation state.
Only projects and Providers in the operator's configured management scope are accessible.
export accepts operation outputs and project artifacts, verifies source accessibility and content integrity, and refuses to overwrite files.
`

/** Registers a one-shot command after host startup; host disposal aborts waits and closes management. */
export function apply(ctx: Context, config: Config): void {
  const args = ctx.get('cmdlineArgs')!
  const ready = ctx.get('appReady')!
  const exit = ctx.get('appExit')!
  const abort = new AbortController()
  let engine: ExecutionEngine | undefined
  ctx.effect(
    () => () => {
      abort.abort()
      return engine?.close()
    },
    'science.management.close',
  )
  ctx.effect(
    () =>
      ready.onReady(() => {
        void execute(args.get(), config.configPath, abort.signal, (value) => {
          engine = value
        })
          .then((value) => {
            if (value !== undefined) process.stdout.write(`${JSON.stringify(value)}\n`)
            exit(0)
          })
          .catch((error) => {
            process.stderr.write(
              `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
            )
            exit(1)
          })
      }),
    'science.management.ready',
  )
}

async function execute(
  args: readonly string[],
  configPath: string,
  signal: AbortSignal,
  opened: (engine: ExecutionEngine) => void,
): Promise<unknown> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      project: { type: 'string' },
      budget: { type: 'string' },
      provider: { type: 'string' },
      key: { type: 'string' },
      input: { type: 'string' },
      wait: { type: 'boolean' },
      'timeout-ms': { type: 'string' },
      operation: { type: 'string' },
      experiment: { type: 'string' },
      assessor: { type: 'string' },
      after: { type: 'string' },
      until: { type: 'string' },
      reason: { type: 'string' },
      artifact: { type: 'string' },
      target: { type: 'string' },
      port: { type: 'string' },
      'refresh-ms': { type: 'string' },
    },
  })
  if (values.help || args.length === 0) {
    process.stdout.write(help)
    return
  }
  const commands = [
    'create',
    'start',
    'status',
    'describe',
    'facts',
    'list',
    'query',
    'wait',
    'cancel',
    'export',
    'reconcile',
    'stop',
    'serve',
    'experiment-create',
    'experiment-list',
    'experiment-status',
    'experiment-act',
    'experiment-wait',
    'experiment-cancel',
    'experiment-escalate',
    'experiment-resolve',
    'experiment-finish',
    'experiment-assess',
  ]
  const command = positionals[0]
  if (positionals.length !== 1 || command === undefined || !commands.includes(command))
    throw new Error('Expected one supported command; use --help')
  const required = (key: keyof typeof values): string => {
    const value = values[key]
    if (typeof value !== 'string' || !value) throw new Error(`Missing --${key}`)
    return value
  }
  const project = command === 'serve' ? undefined : required('project')
  const { engine, config } = await openConfiguredEngine(configPath)
  opened(engine)
  try {
    signal.throwIfAborted()
    if (command === 'serve') {
      const dashboard = await startDashboard(engine, config, {
        port: values.port === undefined ? 8787 : Number(values.port),
        refreshMs: values['refresh-ms'] === undefined ? 1000 : Number(values['refresh-ms']),
        signal,
      })
      process.stdout.write(
        JSON.stringify({ url: dashboard.launchUrl, mode: 'local-dashboard', deviceStopOnClose: false }) +
          '\n',
      )
      await dashboard.closed
      return
    }
    if (project === undefined || !config.management.projects.includes(project))
      throw new Error('Project is outside configured management scope')
    if (command === 'create') {
      const budget = Number(required('budget'))
      if (!Number.isFinite(budget) || budget < 0) throw new Error('--budget must be finite and nonnegative')
      engine.createProject(project, budget)
      return { project: engine.projects().find((value) => value.id === project), createdOrExisting: true }
    }
    const access = engine.issueContext(project, config.management.actorId, config.management.allowedProviders)
    const timeoutMs = values['timeout-ms'] === undefined ? 30000 : Number(values['timeout-ms'])
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new Error('--timeout-ms must be a positive safe integer')
    if (command.startsWith('experiment-')) {
      const api = engine.experiments
      const input = () => JSON.parse(readFileSync(required('input'), 'utf8'))
      if (command === 'experiment-create') return api.create(access, required('key'), input())
      if (command === 'experiment-list') return api.list(access)
      const id = required('experiment')
      if (command === 'experiment-status') return api.get(access, id)
      if (command === 'experiment-wait') {
        const until = values.until ?? 'decision'
        if (until !== 'change' && until !== 'decision') throw new Error('--until must be change or decision')
        return await api.wait(access, id, {
          after: values.after === undefined ? api.get(access, id).cursor : Number(values.after),
          until,
          timeoutMs,
          signal,
        })
      }
      api.claim(access, id, values.reason ?? `Explicit local operator command: ${command}`)
      if (command === 'experiment-act') return await api.submit(access, id, input())
      if (command === 'experiment-cancel') return await api.cancel(access, id)
      if (command === 'experiment-escalate') return api.escalate(access, id, required('reason'), input())
      if (command === 'experiment-resolve') return api.resolve(access, id, required('reason'))
      if (command === 'experiment-assess') {
        const module = (await import(pathToFileURL(resolve(required('assessor'))).href)) as {
          assessExperiment?: (engine: ExecutionEngine, context: typeof access, id: string) => unknown
        }
        if (typeof module.assessExperiment !== 'function')
          throw new Error('Trusted domain module must export assessExperiment')
        return await module.assessExperiment(engine, access, id)
      }
      const completion = input()
      if (
        !completion ||
        typeof completion.summary !== 'string' ||
        !Array.isArray(completion.artifactIds) ||
        !Array.isArray(completion.assessmentIds) ||
        ![...completion.artifactIds, ...completion.assessmentIds].every((v) => typeof v === 'string')
      )
        throw new Error('Completion requires summary, artifactIds and assessmentIds')
      return api.finish(access, id, completion.summary, completion.artifactIds, completion.assessmentIds)
    }
    switch (command) {
      case 'start': {
        const input: Json = JSON.parse(readFileSync(required('input'), 'utf8'))
        const operation = await engine.submit(access, {
          providerId: required('provider'),
          requestKey: required('key'),
          input,
        })
        return values.wait ? await engine.wait(access, operation.id, { timeoutMs, signal }) : operation
      }
      case 'query':
        return await engine.query(access, required('operation'))
      case 'wait':
        return await engine.wait(access, required('operation'), { timeoutMs, signal })
      case 'cancel':
        return await engine.cancel(access, required('operation'))
      case 'export': {
        const artifactId = required('artifact'),
          target = required('target')
        if (
          engine
            .list(access)
            .some((operation) => operation.artifacts.some((artifact) => artifact.id === artifactId))
        )
          return engine.exportArtifact(access, artifactId, target)
        const result = new Artifacts(engine).read(access, artifactId)
        mkdirSync(dirname(resolve(target)), { recursive: true })
        writeFileSync(target, Buffer.from(result.content, result.encoding), { flag: 'wx', mode: 0o600 })
        return result.artifact
      }
      case 'describe':
        return engine.descriptions(access)
      case 'facts':
        return engine.readFacts(access)
      case 'list':
        return engine.list(access)
      case 'status':
        return {
          project: engine.projects().find((value) => value.id === project),
          operations: engine.list(access),
        }
      case 'reconcile':
        await engine.reconcile(access)
        return { project, operations: engine.list(access), reconciled: true }
      case 'stop':
        return { project, management: 'closing', deviceStopConfirmed: false, operations: engine.list(access) }
      default:
        throw new Error('Unsupported command')
    }
  } finally {
    await engine.close()
  }
}
