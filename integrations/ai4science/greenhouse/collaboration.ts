/** Reuse Agent Router's task board and mailbox, with native Harness delivery and exact project identities. */
import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Board, type RouterMessage } from '../../agent-router/core/board.mjs'
import type { Organization } from '../platform/organization.ts'
import type { ExecutionEngine } from '../platform/execution.ts'
import type { OperationContext } from '../platform/sdk.ts'
import type { GreenhouseWorld } from './world.ts'
import { z } from 'zod'
import type { WorldEvent } from './events.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'greenhouse-coordination': { readonly kind: 'greenhouse-coordination'; readonly form: 'notice'; readonly summary: string }
  }
}
export const collaborationTools = ['lab_status', 'lab_assign', 'lab_message', 'lab_inbox', 'lab_complete']
interface Member { id: SessionId; name: string; parentId?: SessionId; agent: Agent }
interface Delivery { status: 'accepted' | 'failed'; nativeMessageId?: string; error?: string }

/** One run owns the Router Board; restoring tasks never restores old live-agent authority. */
export class GreenhouseCollaboration {
  private readonly board: Board
  private readonly members = new Map<string, Member>()
  private readonly deliveries = new Map<string, Delivery>()
  private disposed = false

  /** Open a fresh run's board, retaining original sender identities in durable execution facts.
   * @param ctx Existing Harness services.
   * @param org Current project organization and authority.
   * @param engine Current execution store.
   * @param world Current greenhouse.
   * @param admin Trusted project-fact writer, never exposed as a member capability.
   * @param file New Router Board snapshot path.
   * @param mode Explicit experiment organization; single mode permits only root self-assignment.
   */
  constructor(private readonly ctx: Context, private readonly org: Organization, private readonly engine: ExecutionEngine,
    private readonly world: GreenhouseWorld, private readonly admin: OperationContext, file: string, private readonly mode: 'single-agent' | 'multi-agent' = 'multi-agent') {
    if (existsSync(file)) throw new Error('Agent run board already exists; use a fresh run directory. History does not restore authority.')
    this.board = new Board(file)
  }

  /** Bind a known native organization role to its exact live incarnation, including native cold continuation.
   * @param agent Actual current Harness participant.
   */
  register(agent: Agent): void {
    if (this.disposed) throw new Error('Collaboration closed')
    const actor = this.org.assertActor(agent)
    const existing = this.members.get(actor.role)
    if (existing && existing.id !== actor.id) throw new Error('Member role is ambiguous')
    this.members.set(actor.role, { id: actor.id, name: actor.role, agent,
      ...(actor.parentId ? { parentId: actor.parentId } : {}) })
    this.record('member-registered', { name: actor.role, id: actor.id, parentId: actor.parentId ?? null })
  }

  private actor(agent: Agent, tool: string): Member {
    if (this.disposed) throw new Error('Collaboration closed')
    const actor = this.org.assertActor(agent, tool), member = this.members.get(actor.role)
    if (!member || member.id !== actor.id || member.agent !== agent) throw new Error('Exact registered member required')
    return member
  }
  private record(kind: string, data: unknown): void {
    this.engine.recordFact(this.admin, `greenhouse-${kind}`, z.json().parse(JSON.parse(JSON.stringify(data))))
  }
  private async deliver(from: { name: string; id?: SessionId }, to: Member, content: string, taskId: string | null, signal: AbortSignal): Promise<RouterMessage> {
    signal.throwIfAborted()
    if (this.disposed) throw new Error('Collaboration closed')
    const message = this.board.sendMessage({ from: from.name, to: to.name, content, task_id: taskId })
    const envelope = { kind: 'greenhouse-mail', messageId: message.id, from: from.name, senderSessionId: from.id ?? null,
      to: to.name, taskId, content }
    this.record('mail-written', envelope)
    try {
      if (to.parentId) {
        // A native parent relays into a continuable child; the envelope preserves the original peer sender.
        const parent = this.ctx.agents.get(to.parentId)
        if (!parent) throw new Error('Recipient native parent is no longer live')
        this.org.assertActor(parent)
        const receipt = await this.ctx.subagents.sendMessage(parent, to.id,
          [{ type: 'text', text: JSON.stringify(envelope) }], { signal })
        this.deliveries.set(message.id, { status: 'accepted', nativeMessageId: receipt })
      } else {
        const target = this.ctx.agents.get(to.id)
        if (target !== to.agent) throw new Error('Recipient root instance expired')
        this.org.assertActor(target)
        target.steer(createUserMessage({ source: { kind: 'greenhouse-coordination', form: 'notice',
          summary: `Mailbox ${message.id} from ${from.name}` }, content: [{ type: 'text', text: JSON.stringify(envelope) }] }))
        this.deliveries.set(message.id, { status: 'accepted' })
      }
      this.record('mail-delivered', { messageId: message.id, ...this.deliveries.get(message.id) })
      return message
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.deliveries.set(message.id, { status: 'failed', error: detail })
      this.record('mail-delivery-failed', { messageId: message.id, error: detail })
      throw error
    }
  }

  /** Assign one real greenhouse task to a native direct child, without starting a second Agent runtime.
   * @param agent Exact assigning participant.
   * @param assignee Registered child role.
   * @param taskId Available greenhouse task.
   * @param signal Tool cancellation signal.
   * @returns Router task and accepted native delivery record.
   */
  async assign(agent: Agent, assignee: string, taskId: string, signal: AbortSignal) {
    const sender = this.actor(agent, 'lab_assign'), target = this.members.get(assignee)
    const self = this.mode === 'single-agent' && sender.name === 'lead' && target?.id === sender.id
    if (!target || (!self && target.parentId !== sender.id)) throw new Error('Assignments require an explicitly registered direct child or the single-mode root')
    const experiment = this.world.observe().tasks.find(task => task.id === taskId)
    if (!experiment) throw new Error('Experiment task is not available')
    if (!self && target.name !== `chamber-${experiment.chamber}`) throw new Error('Task belongs to another chamber member')
    const existing = this.board.tasks.find(task => task.assignee === assignee && task.spec === JSON.stringify(experiment))
    if (existing) return { task: existing, duplicate: true }
    const task = this.board.createTask({ title: taskId, spec: JSON.stringify(experiment), assignee }, sender.name)
    this.record('task-assigned', task)
    try {
      const message = self ? null : await this.deliver(sender, target, `Assignment ${task.id}: ${task.spec}`, task.id, signal)
      if (task.status === 'pending') this.board.updateTask(task.id, { status: 'in_progress' }, sender.name)
      return { task, message, duplicate: false }
    } catch (error) {
      this.board.updateTask(task.id, { status: 'failed', result: 'Assignment delivery failed; inspect mailbox evidence before retrying.' }, sender.name)
      throw error
    }
  }

  /** Deliver a project-scoped work message. This is an application mailbox, not a change to native peer-result authorization.
   * @param agent Exact sending participant.
   * @param to Registered project role; no broadcast or external destination.
   * @param content Work message or actual result reference.
   * @param taskId Optional Router task association.
   * @param signal Tool cancellation signal.
   * @returns Message with an accepted-delivery record; acceptance is not processing completion.
   */
  async message(agent: Agent, to: string, content: string, taskId: string | undefined, signal: AbortSignal) {
    const sender = this.actor(agent, 'lab_message'), target = this.members.get(to)
    if (!target || sender.id === target.id) throw new Error('Choose another registered project member')
    if (taskId && !this.board.task(taskId)) throw new Error('Unknown Router task')
    return this.deliver(sender, target, content, taskId ?? null, signal)
  }

  /** Notify only the role responsible for a committed environmental change.
   * @param role Registered recipient selected by application policy, never a model-supplied sender.
   * @param events Public committed environmental events, without hidden state or future definitions.
   * @param signal Application owner cancellation.
   * @returns Accepted native-mailbox message; no environmental action is executed here.
   */
  async notify(role: string, events: WorldEvent[], signal: AbortSignal) {
    const target = this.members.get(role)
    if (!target) throw new Error('Environmental notification recipient is not registered')
    const message = await this.deliver({ name: 'environment' }, target,
      JSON.stringify({ kind: 'environment-events', events }), null, signal)
    this.record('environment-notified', { role, messageId: message.id, eventSeqs: events.map(event => event.seq) })
    return message
  }

  /** Read the authenticated member's mailbox, marking only its own messages read.
   * @param agent Exact recipient.
   * @returns Unread messages for that recipient; no foreign mailbox is exposed.
   */
  inbox(agent: Agent) {
    const member = this.actor(agent, 'lab_inbox')
    const messages = this.board.inbox(member.name, { unreadOnly: true, markRead: true })
    if (messages.length) this.record('mail-read', { member: member.name, messageIds: messages.map(message => message.id) })
    return messages
  }

  /** Complete an assignment only after the simulator and execution store confirm its actual analysis.
   * @param agent Exact assignee.
   * @param taskId Router assignment identity.
   * @param operationId Successful analysis operation, not a model-authored success claim.
   * @param context Assignee's execution authority.
   * @param signal Tool cancellation signal.
   * @returns Completed Router task and actual result identity.
   */
  async complete(agent: Agent, taskId: string, operationId: string, context: OperationContext, signal: AbortSignal) {
    const sender = this.actor(agent, 'lab_complete'), task = this.board.task(taskId)
    if (!task || task.assignee !== sender.name) throw new Error('Only the current assignee can complete its Router task')
    const experiment = z.object({ id: z.string() }).passthrough().parse(JSON.parse(task.spec))
    const operation = await this.engine.query(context, operationId)
    const input = z.object({ action: z.literal('analyze'), taskId: z.string() }).passthrough().parse(operation.input)
    if (operation.state !== 'succeeded' || input.taskId !== experiment.id || !this.world.observe().completedTasks.includes(experiment.id))
      throw new Error('Assignment requires a successful analysis of its actual greenhouse task')
    if (task.status === 'done') return { task, duplicate: true }
    this.board.updateTask(task.id, { status: 'done', result: operation.id, artifacts: operation.artifacts.map(artifact => artifact.id) }, sender.name)
    this.record('task-completed', { taskId, operationId, actorId: sender.id })
    const creator = this.members.get(task.created_by)
    if (!creator) throw new Error('Assignment owner is unavailable; completion remains recorded')
    if (creator.id !== sender.id) await this.deliver(sender, creator, `Task ${task.id} completed. Analysis operation: ${operation.id}. Artifacts: ${operation.artifacts.map(a => a.id).join(', ')}`, task.id, signal)
    return { task, duplicate: false }
  }

  /** Read shared task state and public member status; exact caller validation is required at the tool entry.
   * @returns The Router Board and delivery receipts used by the frontend as well.
   */
  snapshot() {
    return { members: [...this.members.values()].map(member => ({ name: member.name, id: member.id,
      parentId: member.parentId ?? null, status: this.ctx.agents.get(member.id)?.status ?? 'inactive' })),
      tasks: this.board.tasks, messages: this.board.messages.map(message => ({ ...message,
        delivery: this.deliveries.get(message.id) ?? { status: 'pending' } })) }
  }

  /** Validate a status-tool caller before returning shared project state.
   * @param agent Exact current member.
   * @returns Shared task, member and mailbox delivery state.
   */
  status(agent: Agent) { this.actor(agent, 'lab_status'); return this.snapshot() }

  /** Stop new collaboration admission; task/mailbox files and execution evidence remain intact. */
  close(): void { this.disposed = true; this.board.removeAllListeners() }
}
