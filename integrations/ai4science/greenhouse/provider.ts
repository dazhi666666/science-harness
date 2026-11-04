/** Public execution-provider adapter. Polling exports settled results but never advances the greenhouse. */
import { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { canonicalJson, type ExecutionProvider, type Json, type ProviderOperation, type ProviderObservation } from '../platform/sdk.ts'
import { commandSchema, scenarioSchema, type Job } from './schema.ts'
import { GreenhouseWorld, commandResources, GreenhouseActionRejected } from './world.ts'

const configSchema = z.object({ id: z.string().regex(/^[\w.-]+$/), directory: z.string().min(1), scenarioFile: z.string().min(1) }).strict()

/** Build an adapter with explicit connection ownership; plugin compositions close it after their execution engine.
 * @param input Trusted provider configuration JSON.
 * @returns The standard provider and its owned world connection disposer.
 */
export function openProvider(input: Json) {
  const config = configSchema.parse(input)
  const scenario = scenarioSchema.parse(JSON.parse(readFileSync(resolve(config.scenarioFile), 'utf8')))
  const world = new GreenhouseWorld(config.directory, scenario)
  const identity = (operation: ProviderOperation) => canonicalJson({ projectId: operation.projectId,
    input: operation.input, artifactDirectory: resolve(operation.artifactDirectory) })
  const observe = (operation: ProviderOperation, job: Job | undefined): ProviderObservation => {
    if (!job) return { state: 'not_found', detail: 'No accepted greenhouse operation with this identity' }
    if (job.projectId !== operation.projectId || job.identity !== identity(operation))
      throw new Error('Operation query does not match its accepted identity')
    if (job.state === 'succeeded') {
      mkdirSync(operation.artifactDirectory, { recursive: true, mode: 0o700 })
      const path = join(operation.artifactDirectory, 'result.json')
      const bytes = JSON.stringify({ operationId: job.id, completedTick: job.completedTick, result: job.result }, null, 2) + '\n'
      if (existsSync(path)) {
        if (readFileSync(path, 'utf8') !== bytes) throw new Error('Published greenhouse output changed')
      } else writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' })
      return { state: 'succeeded', artifacts: [{ path: 'result.json', mediaType: 'application/json' }] }
    }
    return { state: job.state, progress: { startedTick: job.startedTick, dueTick: job.dueTick },
      ...(job.detail ? { detail: job.detail } : {}) }
  }
  const provider: ExecutionProvider = {
    describe: () => ({ apiVersion: 1, id: config.id, version: '0.1.0',
      configuration: { scenarioHash: world.scenarioHash }, inputSchema: z.json().parse(z.toJSONSchema(commandSchema)),
      outputSchema: { type: 'object' }, units: { water: 'synthetic-litre', time: 'simulation-tick' },
      constraints: ['A separate owning greenhouse clock must be running.', 'Shared robot, water, assay and compute are exclusive.',
        'Observed moisture may require inspection and calibration.', 'Actions and task evidence are validated by the simulator.'],
      completion: 'The independent simulation clock committed the action result; query exports immutable JSON.',
      cancellation: 'Running simulated actions cancel before effects; settled results remain unchanged.' }),
    prepare(input) {
      const command = world.prepare(input)
      return { input: command, resources: commandResources(command), budget: 0 }
    },
    async submit(operation) {
      mkdirSync(operation.artifactDirectory, { recursive: true, mode: 0o700 })
      world.bindDomain(realpathSync(dirname(operation.artifactDirectory)))
      let job: Job
      try { job = world.submit(operation.operationId, operation.projectId, identity(operation), operation.input) }
      catch (error) {
        if (!(error instanceof GreenhouseActionRejected)) throw error
        job = world.recordRefusal(operation.operationId, operation.projectId, identity(operation), operation.input, error)
      }
      return observe(operation, job)
    },
    async query(operation) { return observe(operation, world.operation(operation.operationId)) },
    async cancel(operation) {
      const job = world.operation(operation.operationId)
      observe(operation, job)
      if (!job) return { disposition: 'unsupported', detail: 'Unknown operation is not assumed cancelled' }
      if (job.state !== 'running') return { disposition: 'rejected', observation: observe(operation, job) }
      return { disposition: 'requested', observation: observe(operation, world.cancel(job.id)) }
    },
  }
  return { provider, close: () => world.close() }
}

/** Load the provider through the existing module protocol. Short-lived CLI processes own the connection until exit.
 * @param input Trusted provider configuration JSON.
 * @returns A standard execution provider, without creating a clock or Agent runtime.
 */
export function createProvider(input: Json): ExecutionProvider { return openProvider(input).provider }
