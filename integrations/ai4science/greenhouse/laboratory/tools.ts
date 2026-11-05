/** Native tools expose project-scoped laboratory execution and verified persistent outputs. */
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { OperationContext } from '../../platform/sdk.ts'
import { Artifacts } from '../../platform/artifacts.ts'
import { laboratorySampleIds } from './commands.ts'
import { LaboratoryRefusal } from './world.ts'
import { laboratoryCommandSchema } from './schema.ts'
import { powerDemand, waterAvailable } from './facilities.ts'
import type { mountLaboratory } from './plugin.ts'

type Runtime = Awaited<ReturnType<typeof mountLaboratory>>
export interface LaboratoryAccess { context(projectId: string): OperationContext }
const id = { type: 'string', required: true } as const
const optionalId = { type: 'string' } as const
const actions: { action: string; description: string; parameters: ParameterSchemaSpec }[] = [
  { action: 'aliquot', description: 'Split a physically delivered sample. Deducted volume survives cancellation and failures.', parameters: { sampleId: id, volumeUl: { type: 'integer', required: true }, container: id } },
  { action: 'process', description: 'Process one or more physically delivered samples in one device cycle. Use sampleId plus additionalSampleIds, volumeUl per sample, and total consumables for all samples. Read batch and balancing limits in the catalog.', parameters: { sampleId: id, additionalSampleIds: { type: 'array', items: { type: 'string' } }, volumeUl: { type: 'integer', required: true }, methodId: id, methodVersion: { type: 'integer', required: true },
    consumables: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { batchId: id, units: { type: 'integer', required: true } } } } } },
  { action: 'transfer', description: 'Use a robot to move a sample to a compatible device with an available position. Quarantined material may be moved for isolation.', parameters: { sampleId: id, destination: id } },
  { action: 'clean', description: 'Clean the selected device before processing or calibration.', parameters: {} },
  { action: 'calibrate', description: 'Calibrate a clean device that has a calibration-dependent method.', parameters: {} },
  { action: 'repair', description: 'Repair a failed device. Then clean it and renew any required calibration.', parameters: {} },
  { action: 'configure', description: 'Enable or disable a device and optionally set its allowed target temperature. Warm-up takes logical time.', parameters: { enabled: { type: 'boolean', required: true }, targetTemperature: { type: 'number' } } },
  { action: 'refill', description: 'Refill the water tank through its reservoir, within physical capacity.', parameters: { volumeUl: { type: 'integer', required: true } } },
  { action: 'order', description: 'Order one catalog lot through the analysis workstation. Stock appears after the logical delivery event.', parameters: { kind: id } },
]
export const laboratoryTools = ['laboratory_observe', 'laboratory_catalog', 'laboratory_samples', 'laboratory_projects',
  'laboratory_history', 'laboratory_measurements', 'laboratory_result', 'laboratory_wait', 'laboratory_cancel', 'laboratory_deliver',
  ...actions.map(action => `laboratory_${action.action}`)]

/** Register domain tools; the caller owns exact native identity and per-project execution grants.
 * @param ctx Native Harness tool registry.
 * @param runtime Physical laboratory, execution engine and owning event clock.
 * @param access Validate the exact live actor and requested tool before granting project authority.
 * @param ownerSignal Application shutdown signal.
 * @param pollMs Program-side observation interval, independent of laboratory time.
 * @param mailbox Check and acknowledge accepted Router mail when returning it from an event wait.
 */
export function installLaboratoryTools(ctx: Context, runtime: Runtime,
  access: (actor: Agent, tool: string) => LaboratoryAccess, ownerSignal: AbortSignal, pollMs: number, mailbox?: { hasUnread(actor: Agent): boolean; read(actor: Agent): unknown[] }): void {
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error('Positive tool observation interval required')
  const artifacts = new Artifacts(runtime.engine), readResults = new Map<string, Set<string>>()
  const register = (name: string, description: string, parameters: ParameterSchemaSpec,
    body: (args: Record<string, unknown>, actor: Agent, grant: LaboratoryAccess, signal: AbortSignal) => unknown | Promise<unknown>) => {
    ctx.tools.register(defineTool({ name, description, parameters,
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, execution) {
        if (!execution.agent) throw new Error('Exact live laboratory participant required')
        const grant = access(execution.agent, name), signal = AbortSignal.any([ownerSignal, execution.signal])
        signal.throwIfAborted()
        return JSON.parse(JSON.stringify(await body(args, execution.agent, grant, signal))) as JsonValue
      },
    }))
  }
  const page = (args: Record<string, unknown>) => z.object({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20) }).parse(args)
  const pageParameters: ParameterSchemaSpec = { offset: { type: 'integer' }, limit: { type: 'integer' } }
  register('laboratory_observe', 'Read current utilities, active operations and the committed event cursor. Reading never advances time.', {}, () => {
    const state = runtime.world.observe()
    return { tick: state.tick, eventCursor: runtime.world.eventCursor(), clock: runtime.clock.status(), facilities: state.facilities,
      utilities: { powerDemand: powerDemand(state), waterAvailable: waterAvailable(state) }, metrics: state.facilityMetrics,
      activeOperations: state.operations.filter(operation => operation.state === 'running').map(operation => ({ id: operation.id,
        projectId: operation.projectId, command: operation.command, stage: operation.stage, nextTick: operation.nextTick })),
      events: runtime.world.events(Math.max(0, runtime.world.eventCursor() - 8)) }
  })
  register('laboratory_catalog', 'Read current device capabilities, measured temperatures, current method versions, consumable requirements and supply ordering rules.', {}, () => {
    const state = runtime.world.observe()
    return { devices: state.devices, methods: state.methods, batches: state.batches, supplyCatalog: runtime.world.scenario.supplyCatalog,
      shipments: state.shipments.filter(shipment => !shipment.delivered) }
  })
  register('laboratory_samples', 'Page actual sample lineage, remaining volume, locations and preservation state. Filter by project or sample identity.',
    { project_id: optionalId, sample_id: optionalId, ...pageParameters }, (args, _actor, grant) => {
      const project = z.string().optional().parse(args.project_id), sampleId = z.string().optional().parse(args.sample_id), pagination = page(args)
      if (project) grant.context(project)
      const selected = runtime.world.observe().samples.filter(sample => (!project || sample.projectId === project) && (!sampleId || sample.id === sampleId || sample.parentId === sampleId))
      return { total: selected.length, offset: pagination.offset, samples: selected.slice(pagination.offset, pagination.offset + pagination.limit) }
    })
  register('laboratory_projects', 'Read registered projects, released phase tasks, current dependencies and valid or withdrawn deliveries.',
    { project_id: optionalId }, (args, _actor, grant) => {
      const project = z.string().optional().parse(args.project_id)
      if (project) grant.context(project)
      const state = runtime.world.observe(), tasks = state.tasks.filter(task => !project || task.projectId === project)
      return { projects: runtime.world.scenario.projects.filter(value => !project || value.id === project), tasks,
        deliveries: state.deliveries.filter(delivery => tasks.some(task => task.id === delivery.taskId)), revocations: state.revocations }
    })
  register('laboratory_history', 'Recover actual project operation IDs and artifact references after context compression. Then use laboratory_result.',
    { project_id: id, sample_id: optionalId, device_id: optionalId, ...pageParameters }, (args, _actor, grant) => {
      const context = grant.context(z.string().min(1).parse(args.project_id)), pagination = page(args)
      const sampleId = z.string().optional().parse(args.sample_id), deviceId = z.string().optional().parse(args.device_id)
      const selected = runtime.engine.list(context).filter(operation => {
        const command = laboratoryCommandSchema.parse(operation.input)
        return (!deviceId || command.deviceId === deviceId) && (!sampleId || laboratorySampleIds(command).includes(sampleId))
      })
      return { total: selected.length, offset: pagination.offset, operations: selected.slice(pagination.offset, pagination.offset + pagination.limit)
        .map(operation => ({ id: operation.id, state: operation.state, input: operation.input, artifacts: operation.artifacts })) }
    })
  register('laboratory_measurements', 'Find actual measurement and source operation IDs by project, original sample or method. Read their artifacts with laboratory_result before using them.',
    { project_id: optionalId, root_sample_id: optionalId, method_id: optionalId, ...pageParameters }, (args, _actor, grant) => {
      const filter = z.object({ project_id: z.string().optional(), root_sample_id: z.string().optional(), method_id: z.string().optional() }).parse(args)
      if (filter.project_id) grant.context(filter.project_id)
      const state = runtime.world.observe(), pagination = page(args)
      const selected = state.results.filter(result => (!filter.project_id || state.samples.find(sample => sample.id === result.rootSampleId)?.projectId === filter.project_id) &&
        (!filter.root_sample_id || result.rootSampleId === filter.root_sample_id) && (!filter.method_id || result.methodId === filter.method_id))
      return { total: selected.length, offset: pagination.offset, measurements: selected.slice(pagination.offset, pagination.offset + pagination.limit),
        revokedResultIds: state.revocations.map(revocation => revocation.resultId) }
    })
  register('laboratory_result', 'Read a real operation and its hash-verified artifact. Obtain actual outputSampleId and measurement result IDs here before delivery.',
    { project_id: id, operation_id: id }, async (args, actor, grant) => {
      const context = grant.context(z.string().parse(args.project_id)), operation = await runtime.engine.query(context, z.string().parse(args.operation_id))
      const outputs = operation.artifacts.map(artifact => ({ id: artifact.id, data: JSON.parse(artifacts.read(context, artifact.id).content) }))
      const read = readResults.get(actor.id) ?? new Set<string>()
      for (const output of outputs) {
        const record = z.object({ result: z.object({ id: z.string() }).passthrough().nullable(), results: z.array(z.object({ id: z.string() }).passthrough()).optional() }).passthrough().parse(output.data)
        if (record.result) read.add(record.result.id)
        for (const result of record.results ?? []) read.add(result.id)
      }
      readResults.set(actor.id, read)
      return { operation, outputs }
    })
  register('laboratory_deliver', 'Deliver a phase using actual measurement IDs already read with laboratory_result. Supply reference_result_ids for all current measurements of cross-project prerequisites, after reading their actual operation artifacts. Distinct roots, methods and lineage are verified.',
    { project_id: id, task_id: id, result_ids: { type: 'array', items: { type: 'string' }, required: true }, reference_result_ids: { type: 'array', items: { type: 'string' } } }, async (args, actor, grant) => {
      const project = z.string().parse(args.project_id), task = z.string().parse(args.task_id), results = z.array(z.string()).parse(args.result_ids)
      const references = z.array(z.string()).default([]).parse(args.reference_result_ids)
      grant.context(project)
      const allResults = [...results, ...references]
      if (!allResults.every(result => readResults.get(actor.id)?.has(result))) throw new Error('Read every referenced measurement through laboratory_result before delivery')
      for (const resultId of allResults) {
        const measurement = runtime.world.observe().results.find(value => value.id === resultId)
        if (!measurement) throw new Error('Unknown measurement reference')
        const sourceProject = runtime.world.operation(measurement.operationId)?.projectId
        if (!sourceProject) throw new Error('Measurement has no known project operation')
        const context = grant.context(sourceProject), operation = await runtime.engine.query(context, measurement.operationId)
        for (const artifact of operation.artifacts) artifacts.read(context, artifact.id)
      }
      const delivery = runtime.world.deliver(project, task, results, references)
      runtime.engine.recordFact(grant.context(project), 'laboratory-task-delivered', { actorId: actor.id, taskId: task, resultIds: results, referenceResultIds: references, tick: delivery.tick })
      return delivery
    })
  register('laboratory_cancel', 'Cancel project work through the execution engine. Already committed sample and resource effects remain recorded.',
    { project_id: id, operation_id: id }, (args, _actor, grant) => runtime.engine.cancel(grant.context(z.string().parse(args.project_id)), z.string().parse(args.operation_id)))
  register('laboratory_wait', 'Wait for actual device events, an accepted operation or native mail. Unread Router mail is returned and acknowledged in this tool result. Use the eventCursor from laboratory_observe. Waiting has no task deadline.',
    { after_seq: { type: 'integer', required: true }, operation_id: optionalId, project_id: optionalId }, async (args, actor, grant, signal) => {
      const after = z.number().int().nonnegative().parse(args.after_seq), operationId = z.string().optional().parse(args.operation_id)
      if (after > runtime.world.eventCursor()) throw new Error(`Cursor is ahead of the device log; current eventCursor is ${runtime.world.eventCursor()}`)
      if (operationId) {
        const project = z.string().min(1).parse(args.project_id)
        runtime.engine.get(grant.context(project), operationId)
      }
      const ready = () => signal.aborted || runtime.world.eventCursor() > after || mailbox?.hasUnread(actor) || !!actor.inbox.nextStep.length || !!actor.inbox.nextTurn.length ||
        operationId !== undefined && runtime.world.operation(operationId)?.state !== 'running'
      const release = runtime.clock.waiting(actor.id, ready)
      try {
        while (!ready()) {
          access(actor, 'laboratory_wait')
          const health = runtime.clock.status()
          if (!health.running || health.failure) throw new Error(health.failure ?? 'Laboratory clock stopped')
          await delay(pollMs, undefined, { signal })
        }
        signal.throwIfAborted()
        const events = runtime.world.events(after)
        const mail = mailbox?.hasUnread(actor) ? mailbox.read(actor) : []
        return { mail, events, last_seq: events.at(-1)?.seq ?? after, reason: events.length ? 'events' : operationId && runtime.world.operation(operationId)?.state !== 'running' ? 'operation' : 'inbox' }
      } finally { release() }
    })
  for (const action of actions) register(`laboratory_${action.action}`, action.description,
    { project_id: id, requestKey: id, deviceId: id, ...action.parameters }, async (args, actor, grant, signal) => {
      const { project_id, requestKey, ...fields } = args
      const context = grant.context(z.string().min(1).parse(project_id)), command = laboratoryCommandSchema.parse({ action: action.action, ...fields })
      const request = { providerId: 'laboratory', requestKey: z.string().min(1).parse(requestKey), input: z.json().parse(command) }
      const resources = [`laboratory:device:${command.deviceId}`, ...laboratorySampleIds(command).map(id => `laboratory:sample:${id}`)]
      for (;;) {
        signal.throwIfAborted(); access(actor, `laboratory_${action.action}`)
        const health = runtime.clock.status()
        if (!health.running || health.failure) throw new Error(health.failure ?? 'Laboratory clock stopped')
        for (const project of runtime.world.scenario.projects) {
          const otherContext = grant.context(project.id)
          for (const operation of runtime.engine.list(otherContext).filter(operation => operation.resources.some(resource => resources.includes(resource)))) {
            if (operation.state === 'unknown') throw new Error('Resource outcome is unknown; reconcile the accepted operation before new work')
            if (['registered', 'dispatching', 'accepted', 'running'].includes(operation.state)) {
              const observed = await runtime.engine.query(otherContext, operation.id)
              if (observed.state === 'unknown') throw new Error('Resource outcome is unknown; explicit reconciliation is required')
            }
          }
        }
        try { return await runtime.engine.submit(context, request) }
        catch (error) {
          if (!(error instanceof LaboratoryRefusal && error.code === 'busy') && !(error instanceof Error && error.message.startsWith('Resource busy'))) throw error
        }
        const release = runtime.clock.waiting(actor.id, () => !runtime.world.observe().operations.some(operation => operation.state === 'running' &&
          (operation.command.deviceId === command.deviceId || command.action === 'transfer' && operation.command.deviceId === command.destination || laboratorySampleIds(command).some(id => laboratorySampleIds(operation.command).includes(id)))))
        try { await delay(pollMs, undefined, { signal }) } finally { release() }
      }
    })
}
