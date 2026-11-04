/** Native multi-Agent greenhouse team with Router task/mailbox semantics and one shared execution environment. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-compaction'
import { createOrganization } from '../platform/organization.ts'
import { installOrganizationTools } from '../platform/host-plugin.ts'
import type { OperationContext } from '../platform/sdk.ts'
import { mountEnvironment, type Config as EnvironmentConfig } from './plugin.ts'
import { GreenhouseCollaboration, collaborationTools } from './collaboration.ts'
import { greenhouseTools, installGreenhouseTools } from './tools.ts'
import { chamberSchema } from './schema.ts'
import { GreenhouseEventDispatch } from './events.ts'
import { readComparison } from './comparison.ts'
import { apply as mountDirectTransport, directTransportSchema } from './direct-transport.ts'
import { keepPendingWork } from './continuation.ts'

export const name = 'ai4science-greenhouse-agents'
export const inject = ['agents', 'subagents', 'tools', 'systemPrompt', 'llm', 'sessions', 'sessionPersistence']
const configSchema = z.object({
  mode: z.enum(['single-agent', 'multi-agent']).optional(),
  directory: z.string().min(1), scenarioFile: z.string().min(1), project: z.string().min(1),
  port: z.number().int().min(0).max(65535), refreshMs: z.number().int().min(100).max(60000),
  providerCallTimeoutMs: z.number().int().positive(), source: z.enum(['scripted', 'real-model']),
  providerPool: z.array(z.string().min(1)).min(1).optional(),
  comparisonFile: z.string().min(1).optional(),
  directTransport: directTransportSchema.optional(),
  model: z.object({ provider: z.string().min(1), model: z.string().min(1), maxTokens: z.number().int().positive().optional() }).strict(),
}).strict()
export type Config = z.infer<typeof configSchema>
const common = `这是火星温室的执行与协作实验，不评分科研结论。所有操作必须使用真实工具和真实返回的标识，不能用文字宣称执行完成。\n标识分两类：lab_complete.task_id 使用分派返回的 Router ID（如 T1）；greenhouse_sample.taskId、greenhouse_analyze.taskId、greenhouse_history.task_id 使用 greenhouse_observe.tasks 的实验 ID（如 light-A）。\n使用结构化参数；每个新动作使用包含自己角色的唯一 requestKey，重试同一动作保持相同键与参数。通过 greenhouse_result 读取实际输出，从输出获取 sampleId 和 assay ID。\n持续值守也是任务：按 operatingRange 维持负责种植舱的温度和水分；读数异常先巡检，确认传感器偏移后校准，真实缺水则灌溉。实验交付后仍处理环境通知与新实验。\n共享机器人、检测设备、计算和供水；资源忙时先读取正在运行的操作，再 greenhouse_wait 等待变化，不能连续重复提交。供电不足时与其他成员协商降低负载；未知操作不能当作失败重做。\n每次收到新工作消息先 lab_inbox 读取并留下回执，再执行动作。lab_status 查看团队任务和成员；lab_message 给具名成员发送工作消息和实际结果引用。投递接受不代表对方已经处理。\n没有任务或正在等待时使用 greenhouse_wait(after_seq=greenhouse_observe 返回的 eventCursor，等待具体操作时同时填写 operation_id)，信箱消息也会提前唤醒。待办、操作和结果保存在工具中；压缩后用 greenhouse_history(task_id=任务标识) 找回真实操作 ID，再用 greenhouse_result 读取结果。不要反复读取全部历史。`

/** Mount a lead and three continuable chamber coordinators through native Harness creation.
 * @param ctx Existing native Agent, tool, model and session services.
 * @param input Explicit model source and greenhouse environment settings.
 * @returns Runtime, organization, Router-backed coordination and owned shutdown handle.
 */
export async function mountMultiAgent(ctx: Context, input: Config) {
  const config = configSchema.parse(input)
  const installationFile = join(config.directory, 'installation.json')
  if (existsSync(installationFile)) {
    const installation = z.object({ sourceHashes: z.record(z.string().regex(/^[\w.-]+\.ts$/), z.string().regex(/^[a-f0-9]{64}$/)) }).parse(JSON.parse(readFileSync(installationFile, 'utf8')))
    for (const [file, expected] of Object.entries(installation.sourceHashes)) {
      if (createHash('sha256').update(readFileSync(new URL(file, import.meta.url))).digest('hex') !== expected)
        throw new Error(`Greenhouse source changed after installation: ${file}. Reinstall an unused profile before starting; preserve prior run evidence.`)
    }
  }
  if (config.source === 'real-model' && config.model.provider === 'teams-probe')
    throw new Error('Scripted fixture cannot be labelled a real-model run')
  const { model, source, mode = 'multi-agent', providerPool = [model.provider], comparisonFile, directTransport, ...environmentConfig } = config
  if (directTransport) mountDirectTransport(ctx, directTransport)
  if (!providerPool.includes(model.provider) || new Set(providerPool).size !== providerPool.length)
    throw new Error('Provider pool must contain the default route exactly once and have no duplicates')
  const metrics = { requests: 0, inputTokens: 0, outputTokens: 0, modelErrors: 0, toolErrors: 0, compactionSummaries: 0, compactionFailures: 0,
    byProvider: Object.fromEntries(providerPool.map(provider => [provider, { requests: 0, inputTokens: 0, outputTokens: 0, modelErrors: 0 }])) }
  let collaboration: GreenhouseCollaboration | undefined
  let phase = 'starting'
  let lastFailure: { actorId: string; turn: number; step: number; message: string } | null = null
  let dispatcher: GreenhouseEventDispatch | undefined
  const runtime = await mountEnvironment(ctx, environmentConfig satisfies EnvironmentConfig,
    () => ({ mode, source, phase, model, metrics, lastFailure, comparison: readComparison(comparisonFile), notifications: dispatcher?.status() ?? null,
      ...(collaboration ? collaboration.snapshot() : { members: [], tasks: [], messages: [] }) }))
  const abort = new AbortController()
  const admin = runtime.engine.issueContext(config.project, 'greenhouse-coordination-facts', ['greenhouse'])
  const allTools = [...greenhouseTools, ...collaborationTools]
  const role = (instructions: string, tools: string[], creates: Record<string, number>) => ({
    instructions: `${common}\n${instructions}`, model, tools, creates, maxInstances: 1,
  })
  const org = createOrganization(ctx, {
    project: config.project, rootRole: 'lead', maxParticipants: mode === 'single-agent' ? 1 : 4, maxDepth: mode === 'single-agent' ? 0 : 1,
    roles: {
      lead: mode === 'single-agent' ? role('你是单 Agent 对照中的唯一成员，独自管理三舱目标、设备与实验。通过 lab_assign(assignee=lead) 为自己登记任务，使用全部领域工具执行，可同时提交多个后台操作。读取实际检测结果，保存待办并通过 lab_complete 交付。不创建其他成员。', allTools, {}) : role('你是科研负责人。查看当前温室需求，通过 lab_assign 将每个实验任务分派给对应 chamber-A/B/C；持续处理新增需求、跨舱参考、共享资源冲突和上报。通过消息协调成员执行，不亲自提交设备动作或代替成员完成分派。',
        [...collaborationTools.filter(tool => tool !== 'lab_complete'), 'greenhouse_observe', 'greenhouse_history',
          'greenhouse_result', 'greenhouse_wait', 'greenhouse_cancel', 'org_create'], { 'chamber-A': 1, 'chamber-B': 1, 'chamber-C': 1 }),
      ...Object.fromEntries((mode === 'single-agent' ? [] : chamberSchema.options).map(chamber => [`chamber-${chamber}`, role(
        `你是 ${chamber} 舱实验协调员。只负责自己舱的操作，先 lab_inbox 接收明确任务；根据真实观察完成操作与分析，使用 lab_complete 提交实际分析 operation ID。需要参考结果或共享资源安排时直接给相关成员发送消息；整体方案变更交给 lead。`,
        allTools.filter(tool => tool !== 'lab_assign'), {})])),
    }, relations: [],
  }, { record: (kind, data) => runtime.engine.recordFact(admin, kind, z.json().parse(JSON.parse(JSON.stringify(data)))) })
  try { collaboration = new GreenhouseCollaboration(ctx, org, runtime.engine, runtime.world, admin, join(config.directory, 'router', 'board.json'), mode) }
  catch (error) { abort.abort(error); throw error }
  const team = collaboration
  runtime.engine.recordFact(admin, 'greenhouse-run-config', { mode, source, providerPool, model: z.json().parse(JSON.parse(JSON.stringify(model))), scenarioHash: runtime.world.scenarioHash })
  installOrganizationTools(ctx, org)
  const grants = new WeakMap<Agent, OperationContext>()
  const access = (agent: Agent, tool: string) => {
    const actor = org.assertActor(agent, tool)
    if (abort.signal.aborted) throw new Error('Greenhouse team is closing')
    let context = grants.get(agent)
    if (!context) {
      context = runtime.engine.issueContext(config.project, agent.id, ['greenhouse'])
      grants.set(agent, context)
    }
    const chamber = actor.role.startsWith('chamber-') ? chamberSchema.parse(actor.role.slice('chamber-'.length)) : undefined
    return { context, ...(chamber ? { chamber } : {}) }
  }
  ctx.on('agent/disposed', ({ agent }) => {
    const context = grants.get(agent)
    if (context) runtime.engine.revokeContext(context)
  })
  installGreenhouseTools(ctx, runtime, access, abort.signal, config.refreshMs, agent => team.hasUnread(agent))
  const register = (name: string, description: string, parameters: ParameterSchemaSpec,
    body: (agent: Agent, args: Record<string, unknown>, signal: AbortSignal) => unknown | Promise<unknown>) => {
    ctx.tools.register(defineTool({ name, description, parameters,
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        if (!exec.agent) throw new Error('Exact live greenhouse participant required')
        access(exec.agent, name)
        return JSON.parse(JSON.stringify(await body(exec.agent, args, exec.signal))) as JsonValue
      },
    }))
  }
  const id = { type: 'string', required: true } as const
  register('lab_status', 'Read the actual native team, Router task board and message delivery/read status.', {}, agent => team.status(agent))
  register('lab_assign', 'As lead, assign an available greenhouse task to its chamber member. Repeating the same assignment returns its existing task.',
    { assignee: id, experiment_task: id }, (agent, args, signal) => team.assign(agent,
      z.string().parse(args.assignee), z.string().parse(args.experiment_task), signal))
  register('lab_message', 'Send work information or a real result reference to another named project member. No broadcast.',
    { to: id, content: id, task_id: { type: 'string' } }, (agent, args, signal) => team.message(agent,
      z.string().parse(args.to), z.string().min(1).parse(args.content), z.string().optional().parse(args.task_id), signal))
  register('lab_inbox', 'Read only your unread Router mailbox entries and mark those entries read.', {}, agent => team.inbox(agent))
  register('lab_complete', 'Complete your assignment using its Router task_id from lab_assign/lab_inbox (e.g. T2), plus the successful analysis operation_id; notify its owner.',
    { task_id: id, operation_id: id }, (agent, args, signal) => team.complete(agent,
      z.string().parse(args.task_id), z.string().parse(args.operation_id), access(agent, 'lab_complete').context, signal))
  const rootId = SessionId(`greenhouse-lead-${randomUUID()}`)
  keepPendingWork(ctx, agent => {
    const snapshot = team.snapshot()
    const member = snapshot.members.find(value => value.id === agent.id)
    if (!member || (agent.id !== rootId && agent.session.header.parentSession !== rootId)) return
    const tasks = snapshot.tasks.filter(task => task.status !== 'done'
      && (member.name === 'lead' || task.assignee === member.name))
    const unassigned = member.name === 'lead'
      ? runtime.world.observe().tasks.filter(task => !snapshot.tasks.some(assignment => assignment.title === task.id)) : []
    if (!tasks.length && !unassigned.length) return
    return JSON.stringify({ role: member.name,
      pendingAssignments: tasks.map(task => ({ routerTaskId: task.id, experimentTaskId: task.title, assignee: task.assignee })),
      availableUnassignedExperiments: unassigned.map(task => task.id) })
  }, abort.signal)
  ctx.on('session/event', (session, event) => {
    if (session.id !== rootId && session.header.parentSession !== rootId) return
    if (event.type === 'compaction/summary') metrics.compactionSummaries++
    if (event.type === 'compaction/end' && event.data.error !== undefined) metrics.compactionFailures++
  })
  let routeOrdinal = 0
  ctx.on('agent/request', async ({ agent, turn, step }, next) => {
    const request = await next()
    if ((agent.id !== rootId && agent.session.header.parentSession !== rootId) || !providerPool.includes(request.provider)) return request
    const provider = providerPool[routeOrdinal++ % providerPool.length]!
    runtime.engine.recordFact(admin, 'greenhouse-model-route', { actorId: agent.id, turn, step, provider })
    return { ...request, provider }
  })
  let root: AgentHandle | undefined
  ctx.on('agent/created', ({ agent }) => {
    if (abort.signal.aborted) return
    if (agent.id === rootId) {
      org.registerRoot(agent, 'Coordinate the greenhouse research project using actual task and execution feedback.')
      team.register(agent)
    } else if (agent.session.header.parentSession === rootId) team.register(agent)
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (!exec.agent || (exec.agent.id !== rootId && exec.agent.session.header.parentSession !== rootId)) return next()
    const result = await next()
    if (result.isError) metrics.toolErrors++
    runtime.engine.recordFact(admin, 'greenhouse-tool-result', { actorId: exec.agent.id, name: exec.name,
      callId: exec.callId, isError: result.isError, result: z.json().parse(JSON.parse(JSON.stringify(result.isError ? result.error : result.value))) })
    await ctx.sessionPersistence.flush()
    return result
  })
  ctx.on('agent/error', ({ agent, turn, step, error }) => {
    if (abort.signal.aborted || (agent.id !== rootId && agent.session.header.parentSession !== rootId)) return
    phase = 'attention-required'
    lastFailure = { actorId: agent.id, turn, step, message: error instanceof Error ? error.message : String(error) }
    runtime.engine.recordFact(admin, 'greenhouse-agent-error', lastFailure)
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent.id === rootId || agent.session.header.parentSession === rootId) await ctx.sessionPersistence.flush()
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (!providerPool.includes(options.provider) || options.model !== model.model) return yield* next()
    const routeMetrics = metrics.byProvider[options.provider]!
    metrics.requests++
    routeMetrics.requests++
    runtime.engine.recordFact(admin, 'greenhouse-model-request', { number: metrics.requests, provider: options.provider, model: options.model, source })
    for await (const chunk of next()) {
      if (chunk.type === 'usage') {
        metrics.inputTokens += chunk.usage.inputTokens + (chunk.usage.cacheReadTokens ?? 0) + (chunk.usage.cacheWriteTokens ?? 0)
        metrics.outputTokens += chunk.usage.outputTokens
        routeMetrics.inputTokens += chunk.usage.inputTokens + (chunk.usage.cacheReadTokens ?? 0) + (chunk.usage.cacheWriteTokens ?? 0)
        routeMetrics.outputTokens += chunk.usage.outputTokens
        runtime.engine.recordFact(admin, 'greenhouse-model-usage', z.json().parse({ ...chunk.usage,
          provider: options.provider, model: options.model, purpose: options.purpose ?? 'conversation' }))
      }
      if (chunk.type === 'finish' && chunk.reason.kind === 'error') { metrics.modelErrors++; routeMetrics.modelErrors++ }
      yield chunk
    }
  })
  let closing: Promise<void> | undefined
  const close = () => (closing ??= (async () => {
    phase = 'closing'
    abort.abort(new Error('Greenhouse team stopped by its owner'))
    await dispatcher?.close()
    team.close()
    if (root) {
      await ctx.subagents.drainChildren(root.agent, team.snapshot().members.filter(member => member.parentId === root!.agent.id).map(member => SessionId(member.id)))
      await root.dispose()
    }
    phase = 'stopped'
  })())
  ctx.effect(() => close, 'greenhouse.agents')
  try {
    root = await ctx.agents.create({ sessionId: rootId, agentOptions: { provider: model.provider, model: model.model, ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }) } })
    for (const chamber of mode === 'single-agent' ? [] : chamberSchema.options)
      await org.create(root.agent, `chamber-${chamber}`, `ACTOR chamber-${chamber}\nWait for a Router task assignment; read lab_inbox and greenhouse_observe.`, abort.signal)
    if (phase !== 'attention-required') phase = 'running'
    dispatcher = new GreenhouseEventDispatch(runtime.world, async (role, events, signal) => {
      await team.notify(mode === 'single-agent' ? 'lead' : role, events, signal)
      await ctx.sessionPersistence.flush()
    }, config.refreshMs, abort.signal, error => {
      phase = 'attention-required'
      runtime.engine.recordFact(admin, 'greenhouse-notification-failed', { message: error.message })
      console.error(`Greenhouse notification failed: ${error.message}`)
    })
    root.agent.followup(createUserMessage({ source: { kind: 'greenhouse-coordination', form: 'notice', summary: 'Start greenhouse team' },
      content: [{ type: 'text', text: mode === 'single-agent' ? 'ACTOR lead\n你是本轮唯一 Agent。读取 greenhouse_observe 和 lab_status，自行登记并完成全部实验，持续处理环境变化。' : 'ACTOR lead\n团队已创建。读取 greenhouse_observe 与 lab_status，把当前实验分派给对应舱的成员，协调参考结果、共享资源和新增任务。' }] }))
    return { runtime, org, team, root: root.agent, access, close, metrics, dispatcher }
  } catch (error) { await close(); throw error }
}

/** Loader entry point owns the team lifecycle and returns no installation object. */
export async function apply(ctx: Context, config: Config): Promise<void> { await mountMultiAgent(ctx, config) }
