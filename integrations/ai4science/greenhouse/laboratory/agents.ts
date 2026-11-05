/** Native laboratory participants share Router coordination, device execution and logical barriers. */
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-compaction'
import { createOrganization } from '../../platform/organization.ts'
import { installOrganizationTools } from '../../platform/host-plugin.ts'
import type { OperationContext } from '../../platform/sdk.ts'
import { GreenhouseCollaboration, collaborationTools } from '../collaboration.ts'
import { apply as mountDirectTransport, directTransportSchema } from '../direct-transport.ts'
import { mountLaboratory } from './plugin.ts'
import { laboratoryRecipients } from './events.ts'
import { installLaboratoryTools, laboratoryTools } from './tools.ts'

export const name = 'ai4science-laboratory-agents'
export const inject = ['agents', 'subagents', 'tools', 'systemPrompt', 'llm', 'sessions', 'sessionPersistence']
const configSchema = z.object({ directory: z.string().min(1), scenarioFile: z.string().optional(), seed: z.number().int().positive(),
  project: z.string().min(1), mode: z.enum(['single-agent', 'multi-agent']), source: z.enum(['scripted', 'real-model']),
  port: z.number().int().min(0).max(65535), refreshMs: z.number().int().min(100), providerCallTimeoutMs: z.number().int().positive(),
  providerPool: z.array(z.string().min(1)).min(1), directTransport: directTransportSchema.optional(),
  model: z.object({ provider: z.string().min(1), model: z.string().min(1), maxTokens: z.number().int().positive().optional() }).strict(),
}).strict()
export type Config = z.input<typeof configSchema>
const specialists = ['facilities', 'experiments', 'quality'] as const
const common = `你在联合实验室执行真实工具流程，科研结论不评分。所有进度、期限和完成时刻使用逻辑模拟步，eventCursor 是事件序号，nextTick 是设备下一事件时刻。模型生成期间逻辑时间保持不动。先读 laboratory_catalog、laboratory_projects 和 laboratory_observe。按需要分页读取样品及历史，避免反复读取全部记录。
所有标识来自实际工具返回。新操作使用唯一 requestKey，重试同一操作保持相同键和参数。project_id 使用项目 P1 等，task_id 使用具体工具要求的标识，Router 分派使用 T1 等。
先转运样品到相应设备。检查体积、处理状态、容器、库位、温度、清洁、校准、水、电及耗材。process 必须填写当前方法版本及所需耗材批次数量。批处理用 sampleId 加 additionalSampleIds，volumeUl 是每份样品体积，耗材数量为整批合计。先按设备 maximumBatchSamples 与 batchMultiple 选择兼容样品，一次处理产生多份 outputSampleIds 和 resultIds。温控设定需要预热，订购耗材需要逻辑到货。
提交后通过 laboratory_result 查询并读取经过哈希核验的产物，获取 outputSampleId 和 result.id。未知结果先查询，失败后检查已消耗体积、水量及耗材。保全原样和留样，超温或召回材料可转运隔离。
完成阶段前读取每个检测产物。跨项目依赖先用 laboratory_measurements 查前置项目实际检测及 operationId，再 laboratory_result 读取产物；laboratory_deliver 的 reference_result_ids 必须列出前置项目当前有效交付中的全部 resultIds。以 laboratory_deliver 提交本阶段真实结果 ID，再 lab_complete 关闭自己的 Router 分派。方法升级、校准撤销和耗材召回可能重新打开交付。依赖后续阶段必须使用对应前置交付实际产生的样品。
通过 lab_inbox 接收任务与通知。laboratory_wait 返回的 mail 已确认读取，直接处理其中内容。lab_message 直接交换工作信息和实际引用。没有可执行工作时 laboratory_wait(after_seq=laboratory_observe.eventCursor)，等待操作时同时提供 project_id 和 operation_id。压缩后从任务板和 laboratory_history 恢复待办，再读取真实结果。`

/** Mount a native coordinator and three specialist roles, or an equally capable single participant.
 * @param ctx Existing native Harness services.
 * @param input Laboratory, model, organization and transport configuration.
 * @returns Actual runtime, Router team, native root and quiescent close handle.
 */
export async function mountLaboratoryAgents(ctx: Context, input: Config) {
  const config = configSchema.parse(input)
  const installationFile = join(config.directory, 'installation.json')
  if (existsSync(installationFile)) {
    const installation = z.object({ sourceHashes: z.record(z.string().regex(/^(?:laboratory\/)?[\w.-]+\.ts$/), z.string().regex(/^[a-f0-9]{64}$/)) }).parse(JSON.parse(readFileSync(installationFile, 'utf8')))
    for (const [file, hash] of Object.entries(installation.sourceHashes))
      if (createHash('sha256').update(readFileSync(new URL(`../${file}`, import.meta.url))).digest('hex') !== hash)
        throw new Error(`Laboratory source changed after installation: ${file}. Install a fresh profile and preserve prior evidence.`)
  }
  if (!config.providerPool.includes(config.model.provider) || new Set(config.providerPool).size !== config.providerPool.length)
    throw new Error('Provider pool must include the default provider exactly once')
  if (config.source === 'real-model' && config.model.provider === 'teams-probe') throw new Error('Fixture provider cannot be labelled real-model')
  if (config.directTransport) mountDirectTransport(ctx, config.directTransport)
  const { model, mode, source, providerPool } = config
  const metrics = { requests: 0, inputTokens: 0, outputTokens: 0, modelErrors: 0, toolErrors: 0, compactionSummaries: 0, compactionFailures: 0,
    byProvider: Object.fromEntries(providerPool.map(provider => [provider, { requests: 0, inputTokens: 0, outputTokens: 0 }])) }
  let team: GreenhouseCollaboration | undefined, phase = 'starting', lastFailure: string | null = null
  const runtime = await mountLaboratory(ctx, { directory: config.directory, seed: config.seed, scenarioFile: config.scenarioFile,
    port: config.port, refreshMs: config.refreshMs, providerCallTimeoutMs: config.providerCallTimeoutMs },
  () => ({ mode, source, model, metrics, phase, lastFailure, ...(team?.snapshot() ?? { members: [], tasks: [], messages: [] }) }))
  const abort = new AbortController(), firstProject = runtime.world.scenario.projects[0]?.id
  if (!firstProject) throw new Error('Laboratory organization needs at least one project')
  const admin = runtime.engine.issueContext(firstProject, 'laboratory-coordination-facts', ['laboratory'])
  const record = (kind: string, data: unknown) => runtime.engine.recordFact(admin, `laboratory-${kind}`, z.json().parse(JSON.parse(JSON.stringify(data))))
  const role = (instructions: string, tools: string[], creates: Record<string, number>) => ({ instructions: `${common}\n${instructions}`, model, tools, creates, maxInstances: 1 })
  const readTools = laboratoryTools.filter(tool => !['aliquot', 'process', 'transfer', 'clean', 'calibrate', 'repair', 'configure', 'refill', 'order', 'deliver'].some(action => tool === `laboratory_${action}`))
  const allTools = [...laboratoryTools, ...collaborationTools]
  const org = createOrganization(ctx, { project: config.project, rootRole: 'lead', maxParticipants: mode === 'single-agent' ? 1 : 4,
    maxDepth: mode === 'single-agent' ? 0 : 1, relations: [], roles: {
      lead: mode === 'single-agent' ? role('你是唯一成员，负责全部项目、设施、实验与质量。lab_assign(assignee=lead) 登记自己的阶段任务。可同时提交无资源冲突的后台操作。', allTools, {}) :
        role('你负责项目优先级、依赖、分工和最终交付。阶段任务可分派给 facilities、experiments 或 quality。协调资源冲突、留样、异常与复测。通过成员执行物理操作。',
          [...readTools, ...collaborationTools.filter(tool => tool !== 'lab_complete'), 'org_create'], { facilities: 1, experiments: 1, quality: 1 }),
      ...(mode === 'single-agent' ? {} : {
        facilities: role('你负责水路、热控、清洗、维护、校准、补水、耗材补给和设备容量。收到请求后执行必要设备操作，向相关成员发送实际操作引用与可用状态。', allTools.filter(tool => tool !== 'lab_assign'), {}),
        experiments: role('你负责采样材料、分装、转运、前处理、培养与检测。按分派交付完整阶段。与 facilities 和 quality 直接协调设备、留样与结果引用。', allTools.filter(tool => tool !== 'lab_assign'), {}),
        quality: role('你负责方法版本、检测结果读取、样品谱系和受影响结果追溯。接收分派后可执行检测与复测，并交付阶段。必要时向其他成员请求设备或样品工作。', allTools.filter(tool => tool !== 'lab_assign'), {}),
      }),
    } }, { record: (kind, data) => record(kind, data) })
  const rootId = SessionId(`laboratory-lead-${randomUUID()}`)
  let root: AgentHandle | undefined, closing: Promise<void> | undefined, route = 0, eventCursor = 0
  const grants = new WeakMap<Agent, Map<string, OperationContext>>()
  const access = (actor: Agent, tool: string) => {
    org.assertActor(actor, tool)
    if (abort.signal.aborted) throw new Error('Laboratory organization is closing')
    return { context(projectId: string) {
      org.assertActor(actor, tool)
      if (!runtime.world.scenario.projects.some(project => project.id === projectId)) throw new Error('Project is outside this laboratory')
      let contexts = grants.get(actor)
      if (!contexts) { contexts = new Map(); grants.set(actor, contexts) }
      let context = contexts.get(projectId)
      if (!context) { context = runtime.engine.issueContext(projectId, actor.id, ['laboratory']); contexts.set(projectId, context) }
      return context
    } }
  }
  const close = () => (closing ??= (async () => {
    phase = 'closing'; abort.abort(new Error('Laboratory organization stopped by its owner'))
    await runtime.clock.close()
    team?.close()
    if (root) {
      await ctx.subagents.drainChildren(root.agent, team!.snapshot().members.filter(member => member.parentId === rootId).map(member => SessionId(member.id)))
      await root.dispose()
    }
    phase = 'stopped'
  })())
  ctx.effect(() => close, 'laboratory.agents')
  try {
    team = new GreenhouseCollaboration(ctx, org, runtime.engine, runtime.world, admin, join(config.directory, 'router', 'board.json'), mode, 'laboratory')
    installOrganizationTools(ctx, org)
    installLaboratoryTools(ctx, runtime, access, abort.signal, config.refreshMs, { hasUnread: actor => team!.hasUnread(actor), read: actor => team!.inbox(actor) })
    const register = (name: string, description: string, parameters: ParameterSchemaSpec,
      body: (actor: Agent, args: Record<string, unknown>, signal: AbortSignal) => unknown | Promise<unknown>) => {
      ctx.tools.register(defineTool({ name, description, parameters,
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, execution) {
          if (!execution.agent) throw new Error('Exact laboratory actor required')
          access(execution.agent, name)
          return JSON.parse(JSON.stringify(await body(execution.agent, args, AbortSignal.any([abort.signal, execution.signal])))) as JsonValue
        },
      }))
    }
    const id = { type: 'string', required: true } as const
    register('lab_status', 'Read native members, Router assignments, actual deliveries and mailbox receipts.', {}, actor => team!.status(actor))
    register('lab_assign', 'Assign a released phase to a registered child, or lead in Single mode. Reopened tasks retain their assignment.',
      { assignee: id, experiment_task: id }, (actor, args, signal) => team!.assign(actor, z.string().parse(args.assignee), z.string().parse(args.experiment_task), signal))
    register('lab_inbox', 'Read your own unread Router messages and record explicit receipt.', {}, actor => team!.inbox(actor))
    register('lab_message', 'Send project work or actual result references to another registered member.',
      { to: id, content: id, task_id: { type: 'string' } }, (actor, args, signal) => team!.message(actor, z.string().parse(args.to), z.string().parse(args.content), z.string().optional().parse(args.task_id), signal))
    register('lab_complete', 'Complete your Router assignment after laboratory_deliver has recorded a valid phase delivery.',
      { task_id: id }, (actor, args, signal) => team!.completeDelivery(actor, z.string().parse(args.task_id), signal))
    const owns = (actor: Agent) => actor.id === rootId || actor.session.header.parentSession === rootId
    ctx.on('agent/created', ({ agent }) => {
      if (abort.signal.aborted) return
      if (agent.id === rootId) org.registerRoot(agent, 'Complete the joint laboratory projects with actual device evidence')
      if (owns(agent)) team!.register(agent)
    })
    ctx.on('agent/disposed', ({ agent }) => { for (const context of grants.get(agent)?.values() ?? []) runtime.engine.revokeContext(context) })
    ctx.on('tools/execute', async (execution, next) => {
      if (!execution.agent || !owns(execution.agent)) return next()
      const finish = runtime.clock.toolStarted(execution.agent.id)
      try {
        const result = await next()
        if (result.isError) metrics.toolErrors++
        record('tool-result', { actorId: execution.agent.id, callId: execution.callId, name: execution.name, isError: result.isError,
          result: result.isError ? result.error : result.value })
        await ctx.sessionPersistence.flush()
        return result
      } finally { finish() }
    })
    ctx.on('agent/request', async ({ agent, turn, step }, next) => {
      const request = await next()
      if (!owns(agent) || !providerPool.includes(request.provider)) return request
      const provider = providerPool[route++ % providerPool.length]!
      record('model-route', { actorId: agent.id, turn, step, provider })
      return { ...request, provider }
    })
    ctx.on('llm/stream', async function* (options, next) {
      if (!providerPool.includes(options.provider) || options.model !== model.model) return yield* next()
      const selected = metrics.byProvider[options.provider]!
      metrics.requests++; selected.requests++
      record('model-request', { number: metrics.requests, provider: options.provider, model: options.model, source })
      const finish = runtime.clock.modelStarted()
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'usage') {
            const input = chunk.usage.inputTokens + (chunk.usage.cacheReadTokens ?? 0) + (chunk.usage.cacheWriteTokens ?? 0)
            metrics.inputTokens += input; selected.inputTokens += input
            metrics.outputTokens += chunk.usage.outputTokens; selected.outputTokens += chunk.usage.outputTokens
            record('model-usage', { ...chunk.usage, provider: options.provider, purpose: options.purpose ?? 'conversation' })
          }
          if (chunk.type === 'finish' && chunk.reason.kind === 'error') metrics.modelErrors++
          yield chunk
        }
      } finally { finish() }
    })
    ctx.on('session/event', (session, event) => {
      if (session.id !== rootId && session.header.parentSession !== rootId) return
      if (event.type === 'compaction/summary') metrics.compactionSummaries++
      if (event.type === 'compaction/end' && event.data.error !== undefined) metrics.compactionFailures++
    })
    ctx.on('agent/error', ({ agent, error }) => {
      if (!owns(agent) || abort.signal.aborted) return
      phase = 'attention-required'; lastFailure = error instanceof Error ? error.message : String(error)
      record('agent-error', { actorId: agent.id, message: lastFailure })
    })
    ctx.on('agent/status', ({ agent }) => { if (owns(agent)) runtime.clock.wake() })
    ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
      if (!owns(agent) || abort.signal.aborted || signal.aborted) return
      const member = team!.snapshot().members.find(value => value.id === agent.id)
      const snapshot = team!.snapshot(), state = runtime.world.observe()
      const pending = snapshot.tasks.filter(task => task.status !== 'done' && (member?.name === 'lead' || task.assignee === member?.name))
      const unassigned = member?.name === 'lead' ? state.tasks.filter(task => !snapshot.tasks.some(value => value.title === task.id)) : []
      if (pending.length || unassigned.length) agent.steer(createUserMessage({ source: { kind: 'greenhouse-coordination', form: 'notice', summary: 'Pending laboratory work' },
        content: [{ type: 'text', text: `继续真实工具工作，处理现有待办和阻塞，必要时等待设备或消息。${JSON.stringify({ pending, unassigned })}` }] }))
      await ctx.sessionPersistence.flush()
    })
    root = await ctx.agents.create({ sessionId: rootId, agentOptions: { provider: model.provider, model: model.model, ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }) } })
    for (const specialist of mode === 'single-agent' ? [] : specialists)
      await org.create(root.agent, specialist, `ACTOR ${specialist}\n读取 laboratory_catalog 与 lab_inbox，处理具名任务及环境通知。`, abort.signal)
    phase = 'running'
    record('run-config', { mode, source, model, providerPool, scenarioHash: runtime.world.scenarioHash })
    root.agent.followup(createUserMessage({ source: { kind: 'greenhouse-coordination', form: 'notice', summary: 'Start laboratory projects' },
      content: [{ type: 'text', text: `ACTOR lead\n${mode === 'single-agent' ? '独自登记并完成全部实验室项目。' : '团队已创建，读取当前项目，按专业分派任务并协调依赖和设施。'}` }] }))
    runtime.clock.attach(() => {
      if (abort.signal.aborted || phase !== 'running') return false
      const state = runtime.world.observe(), snapshot = team!.snapshot()
      if (state.appliedFaults.length === runtime.world.scenario.faults.length && state.appliedRevisions.length === runtime.world.scenario.revisions.length &&
        runtime.world.scenario.tasks.every(task => state.deliveries.some(value => value.taskId === task.id && value.valid)) &&
        snapshot.tasks.every(task => task.status === 'done') && !state.operations.some(operation => operation.state === 'running')) return false
      return snapshot.members.every(member => {
        const actor = ctx.agents.get(member.id)
        if (actor?.status === 'running') return runtime.clock.blocked(member.id)
        return !actor?.inbox.nextStep.length && !actor?.inbox.nextTurn.length
      })
    }, async () => {
      const events = runtime.world.events(eventCursor)
      const grouped = new Map<string, typeof events>()
      for (const event of events) {
        const selected = laboratoryRecipients(event)
        if (mode === 'multi-agent' && event.kind === 'deliveries-withdrawn') {
          const withdrawn = z.object({ taskIds: z.array(z.string()) }).parse(event.payload).taskIds
          for (const assignment of team!.snapshot().tasks.filter(task => withdrawn.includes(task.title)))
            if (!selected.includes(assignment.assignee)) selected.push(assignment.assignee)
        }
        const recipients = mode === 'single-agent' && selected.length ? ['lead'] : selected
        for (const recipient of recipients) grouped.set(recipient, [...(grouped.get(recipient) ?? []), event])
      }
      for (const [recipient, selected] of grouped) await team!.notify(recipient, selected, abort.signal)
      if (grouped.size) await ctx.sessionPersistence.flush()
      eventCursor = events.at(-1)?.seq ?? eventCursor
    })
    return { runtime, org, team, root: root.agent, access, close, metrics }
  } catch (error) { await close(); throw error }
}

/** Standard profile entry for native laboratory experiments.
 * @param ctx Owning Harness plugin context.
 * @param config Native organization and laboratory configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> { await mountLaboratoryAgents(ctx, config) }
