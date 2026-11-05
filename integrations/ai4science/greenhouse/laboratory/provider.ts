/** Standard Provider adapter for staged laboratory operations and immutable JSON artifacts. */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { canonicalJson, type ExecutionProvider, type Json, type ProviderObservation, type ProviderOperation } from '../../platform/sdk.ts'
import { laboratoryCommandSchema, laboratoryScenarioSchema, type LaboratoryOperation } from './schema.ts'
import { laboratorySampleIds } from './commands.ts'
import { LaboratoryRefusal, LaboratoryWorld } from './world.ts'

const configSchema = z.object({ id: z.string().regex(/^[\w.-]+$/), directory: z.string().min(1), scenarioFile: z.string().min(1) }).strict()

/** Open the existing execution-provider protocol; its owner must supply logical event advancement.
 * @param input Private device directory and scenario file.
 * @param onChange Notify the owning clock after admission or cancellation; callback must not throw.
 * @returns Provider and explicit connection disposer.
 */
export function openLaboratoryProvider(input: Json, onChange: () => void = () => {}) {
  const config = configSchema.parse(input)
  const scenario = laboratoryScenarioSchema.parse(JSON.parse(readFileSync(resolve(config.scenarioFile), 'utf8')))
  const world = new LaboratoryWorld(resolve(config.directory), scenario)
  const identity = (operation: ProviderOperation) => canonicalJson({ projectId: operation.projectId,
    input: operation.input, artifactDirectory: resolve(operation.artifactDirectory) })
  const observe = (operation: ProviderOperation, job: LaboratoryOperation | undefined): ProviderObservation => {
    if (!job) return { state: 'not_found', detail: 'No laboratory operation with this ID' }
    if (job.projectId !== operation.projectId || job.identity !== identity(operation))
      throw new LaboratoryRefusal('identity', 'Query differs from accepted operation identity')
    if (job.state === 'succeeded') {
      const result = world.observe().results.find(value => value.id === job.resultId)
      const results = world.observe().results.filter(value => (job.resultIds ?? (job.resultId ? [job.resultId] : [])).includes(value.id))
      const bytes = JSON.stringify({ operation: job, result: result ?? null, results }, null, 2) + '\n'
      mkdirSync(operation.artifactDirectory, { recursive: true, mode: 0o700 })
      const path = join(operation.artifactDirectory, 'result.json')
      if (existsSync(path)) {
        if (readFileSync(path, 'utf8') !== bytes) throw new Error('Published laboratory result changed')
      } else writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' })
      return { state: 'succeeded', artifacts: [{ path: 'result.json', mediaType: 'application/json' }] }
    }
    return { state: job.state, progress: { stage: job.stage, nextTick: job.nextTick, consumedUl: job.consumedUl, consumedWaterUl: job.consumedWaterUl },
      ...(job.detail ? { detail: job.detail } : {}) }
  }
  const provider: ExecutionProvider = {
    describe: () => ({ apiVersion: 1, id: config.id, version: '0.1.0', configuration: { scenarioHash: world.scenarioHash },
      inputSchema: z.json().parse(z.toJSONSchema(laboratoryCommandSchema)), outputSchema: { type: 'object' },
      units: { time: 'simulation-tick', sampleVolume: 'microlitre' },
      constraints: ['An owning logical clock must advance device events.',
        'Accepted operations reserve their device and input sample.', 'Only the sample project can process or transfer it.'],
      completion: 'The owning clock commits each stage; query publishes settled immutable output.',
      cancellation: 'Cancellation retains consumed volume and other committed stage effects.' }),
    prepare(input) {
      const command = laboratoryCommandSchema.parse(input)
      const state = world.observe()
      const project = 'sampleId' in command ? state.samples.find(value => value.id === command.sampleId)?.projectId : 'maintenance'
      world.prepare(project ?? '', input)
      return { input: z.json().parse(command), resources: [`laboratory:device:${command.deviceId}`,
        ...laboratorySampleIds(command).map(id => `laboratory:sample:${id}`)], budget: 0 }
    },
    async submit(operation) {
      mkdirSync(operation.artifactDirectory, { recursive: true, mode: 0o700 })
      world.bindDomain(realpathSync(dirname(operation.artifactDirectory)))
      let job: LaboratoryOperation
      try { job = world.submit(operation.operationId, operation.projectId, identity(operation), operation.input) }
      catch (error) {
        if (!(error instanceof LaboratoryRefusal) || error.code === 'identity') throw error
        job = world.recordRefusal(operation.operationId, operation.projectId, identity(operation), operation.input, error)
      }
      onChange()
      return observe(operation, job)
    },
    async query(operation) { return observe(operation, world.observe().operations.find(value => value.id === operation.operationId)) },
    async cancel(operation) {
      const job = world.observe().operations.find(value => value.id === operation.operationId)
      observe(operation, job)
      if (!job) return { disposition: 'unsupported', detail: 'Unknown work requires investigation' }
      if (job.state !== 'running') return { disposition: 'rejected', observation: observe(operation, job) }
      const observation = observe(operation, world.cancel(job.id))
      onChange()
      return { disposition: 'requested', observation }
    },
  }
  return { provider, close: () => world.close() }
}

/** Module-protocol entry; the host process owns the connection until exit.
 * @param input Private provider configuration.
 * @returns Laboratory execution provider.
 */
export function createProvider(input: Json): ExecutionProvider { return openLaboratoryProvider(input).provider }
