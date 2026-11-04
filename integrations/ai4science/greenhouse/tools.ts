/** Structured greenhouse actions and event waits for exact native project participants. */
import { setTimeout as delay } from 'node:timers/promises'
import { commandResources } from './world.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import type { OperationContext } from '../platform/sdk.ts'
import { Artifacts } from '../platform/artifacts.ts'
import type { mountEnvironment } from './plugin.ts'
import { chamberSchema, commandSchema, type Command } from './schema.ts'

export const greenhouseTools = ['greenhouse_observe', 'greenhouse_history', 'greenhouse_result', 'greenhouse_wait', 'greenhouse_cancel',
  'greenhouse_light', 'greenhouse_temperature', 'greenhouse_water', 'greenhouse_inspect', 'greenhouse_calibrate',
  'greenhouse_sample', 'greenhouse_assay', 'greenhouse_analyze']
type Runtime = Awaited<ReturnType<typeof mountEnvironment>>
export interface ActorAccess { context: OperationContext; chamber?: z.infer<typeof chamberSchema> }

/** Install only domain tools; member permissions and native identity remain owned by the caller.
 * @param ctx Native Harness services.
 * @param runtime Live world, execution engine and owning clock.
 * @param access Validate the exact participant and tool, and return its execution authority.
 * @param signal Application disposal signal, separate from an individual tool call.
 * @param pollMs Program-side observation interval; there is no model-polling or project deadline.
 * @param inboxReady Project mailbox readiness, including mail already admitted to native input.
 */
export function installGreenhouseTools(ctx: Context, runtime: Runtime,
  access: (agent: Agent, tool: string) => ActorAccess, signal: AbortSignal, pollMs: number, inboxReady?: (agent: Agent) => boolean): void {
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error('Positive observation interval required')
  const artifacts = new Artifacts(runtime.engine)
  const register = (name: string, description: string, parameters: ParameterSchemaSpec,
    body: (args: Record<string, unknown>, actor: Agent, grant: ActorAccess, signal: AbortSignal) => unknown | Promise<unknown>) => {
    ctx.tools.register(defineTool({ name, description, parameters,
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        if (!exec.agent) throw new Error('Exact live greenhouse participant required')
        const grant = access(exec.agent, name)
        const result = await body(args, exec.agent, grant, exec.signal)
        return JSON.parse(JSON.stringify(result)) as JsonValue
      },
    }))
  }
  register('greenhouse_observe', 'Read sensors, tasks and active operations. No future events or simulator truth are included.', {},
    () => ({ ...runtime.world.observe(), clock: runtime.clock.status(),
      events: runtime.world.events(0).slice(-12) }))
  register('greenhouse_history', 'Recover real operation IDs after context compaction. Filter by experiment task or chamber, then read verified outputs with greenhouse_result.',
    { task_id: { type: 'string' }, chamber: { type: 'string', enum: [...chamberSchema.options] },
      offset: { type: 'integer' }, limit: { type: 'integer' } }, (args, _actor, grant) => {
      const filter = z.object({ task_id: z.string().min(1).optional(), chamber: chamberSchema.optional(),
        offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20) }).parse(args)
      const operations = runtime.engine.list(grant.context)
      const tasks = runtime.world.observe().tasks
      const commands = new Map(operations.map(operation => [operation.id, commandSchema.parse(operation.input)]))
      const selected = operations.filter(operation => {
        const command = commands.get(operation.id)!
        const origin = command.action === 'assay' && command.sampleId.startsWith('sample:')
          ? commands.get(command.sampleId.slice('sample:'.length)) : command
        const task = origin && 'taskId' in origin ? origin.taskId : undefined
        const chamber = origin && 'chamber' in origin ? origin.chamber
          : tasks.find(value => value.id === task)?.chamber
        return (!filter.task_id || filter.task_id === task) && (!filter.chamber || filter.chamber === chamber)
      })
      return { total: selected.length, offset: filter.offset, operations: selected.slice(filter.offset, filter.offset + filter.limit).map(operation => ({
        id: operation.id, state: operation.state, input: operation.input, artifacts: operation.artifacts.map(artifact => ({ id: artifact.id, path: artifact.path })),
      })) }
    })
  register('greenhouse_result', 'Read a real operation and its verified JSON output; querying does not advance the environment.',
    { operation_id: { type: 'string', required: true } }, async (args, _actor, grant) => {
      const id = z.string().min(1).parse(args.operation_id)
      const operation = await runtime.engine.query(grant.context, id)
      return { operation, outputs: operation.artifacts.map(artifact => ({ id: artifact.id,
        path: artifact.path, data: JSON.parse(artifacts.read(grant.context, artifact.id).content) })) }
    })
  register('greenhouse_cancel', 'Request and observe simulated operation cancellation. Completed actions are retained.',
    { operation_id: { type: 'string', required: true } }, (args, _actor, grant) =>
      runtime.engine.cancel(grant.context, z.string().min(1).parse(args.operation_id)))
  register('greenhouse_wait', 'Wait for device events or mail. Set after_seq from greenhouse_observe.eventCursor; include operation_id when waiting for an operation. Valid waits have no project time limit.',
    { after_seq: { type: 'integer', required: true }, operation_id: { type: 'string' } }, async (args, actor, _grant, callSignal) => {
      const after = z.number().int().nonnegative().parse(args.after_seq)
      const current = runtime.world.eventCursor()
      if (after > current) throw new Error(`Device event cursor is ahead of the log. Current eventCursor is ${current}; use greenhouse_observe.eventCursor.`)
      const operationId = z.string().optional().parse(args.operation_id)
      const combined = AbortSignal.any([callSignal, signal])
      combined.throwIfAborted()
      return new Promise((resolve, reject) => {
        const finish = (value?: unknown, error?: unknown) => {
          clearInterval(timer)
          combined.removeEventListener('abort', aborted)
          if (error !== undefined) reject(error); else resolve(value)
        }
        const aborted = () => finish(undefined, combined.reason)
        const check = () => {
          try {
            access(actor, 'greenhouse_wait')
            const health = runtime.clock.status()
            if (health.failure || !health.running) throw new Error(health.failure ?? 'Greenhouse clock stopped')
            if (operationId) {
              const operation = runtime.world.operation(operationId)
              if (!operation) throw new Error('Unknown greenhouse operation')
              if (operation.state !== 'running') return finish({ reason: 'operation', operation_id: operationId, last_seq: after })
            }
            const events = runtime.world.events(after)
            if (events.length) finish({ reason: 'events', events, last_seq: events.at(-1)!.seq })
            else if (inboxReady?.(actor) || actor.inbox.nextStep.length || actor.inbox.nextTurn.length)
              finish({ reason: 'inbox', last_seq: after })
          } catch (error) { finish(undefined, error) }
        }
        const timer = setInterval(check, pollMs)
        combined.addEventListener('abort', aborted, { once: true })
        if (combined.aborted) aborted(); else check()
      })
    })
  const id = { type: 'string', required: true } as const
  const chamber = { type: 'string', enum: [...chamberSchema.options], required: true } as const
  const actions: { action: Command['action']; description: string; parameters: ParameterSchemaSpec }[] = [
    { action: 'light', description: 'Set your chamber light level from 0 to 1, coordinating shared power first.', parameters: { chamber, level: { type: 'number', required: true } } },
    { action: 'temperature', description: 'Set your chamber temperature target from 10 to 35 synthetic degrees.', parameters: { chamber, target: { type: 'number', required: true } } },
    { action: 'water', description: 'Irrigate your chamber using shared water; waits and readings do not consume water.', parameters: { chamber, litres: { type: 'number', required: true } } },
    { action: 'inspect', description: 'Use the shared robot to inspect a chamber and independently check its moisture sensor.', parameters: { chamber } },
    { action: 'calibrate', description: 'Use the shared robot to calibrate a chamber moisture sensor.', parameters: { chamber } },
    { action: 'sample', description: 'Collect a real sample for an available task in your chamber. Task conditions are enforced.', parameters: { chamber, taskId: id } },
    { action: 'assay', description: 'Analyze a completed sample using the shared assay device; never invent sample IDs.', parameters: { sampleId: id } },
    { action: 'analyze', description: 'Complete a task using real assay IDs, distinct samples, spacing and required reference evidence.', parameters: { taskId: id, assayIds: { type: 'array', items: { type: 'string' }, required: true } } },
  ]
  for (const item of actions) register(`greenhouse_${item.action}`, item.description,
    { requestKey: id, ...item.parameters }, async (args, _actor, grant, callSignal) => {
      const combined = AbortSignal.any([signal, callSignal])
      combined.throwIfAborted()
      const { requestKey, ...fields } = args
      const command = commandSchema.parse({ action: item.action, ...fields })
      if (grant.chamber) {
        const target = 'chamber' in command ? command.chamber : command.action === 'analyze'
          ? runtime.world.observe().tasks.find(task => task.id === command.taskId)?.chamber : undefined
        if (target && target !== grant.chamber) throw new Error('Operation belongs to another chamber; coordinate with its member')
      }
      const health = runtime.clock.status()
      if (!health.running || health.failure) throw new Error(health.failure ?? 'Greenhouse clock stopped')
      const request = { providerId: 'greenhouse', requestKey: z.string().min(1).parse(requestKey), input: command }
      const resources = commandResources(command)
      while (true) {
        combined.throwIfAborted()
        access(_actor, `greenhouse_${item.action}`)
        const health = runtime.clock.status()
        if (!health.running || health.failure) throw new Error(health.failure ?? 'Greenhouse clock stopped')
        for (const operation of runtime.engine.list(grant.context)) {
          if (!operation.resources.some(resource => resources.includes(resource))) continue
          if (operation.state === 'unknown') throw new Error('Resource owner has unknown state; explicit reconciliation required')
          if (['registered', 'dispatching', 'accepted', 'running'].includes(operation.state)) {
            const observed = await runtime.engine.query(grant.context, operation.id)
            if (observed.state === 'unknown') throw new Error('Resource owner has unknown state; explicit reconciliation required')
          }
        }
        try { return await runtime.engine.submit(grant.context, request) }
        catch (error) {
          // Only the known pre-dispatch busy refusal is retryable; the stable request key is unchanged.
          if (!(error instanceof Error) || !error.message.startsWith('Resource busy')) throw error
        }
        await delay(pollMs, undefined, { signal: combined })
      }
    })
}
