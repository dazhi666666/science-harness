/** Configured project membership and consent policy; Harness owns all Agent execution and inboxes. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ScienceResultMessage, ScienceResultReader } from '@deepseek-ai/dsh-subagent'

const roleSchema = z
  .object({
    instructions: z.string(),
    model: z
      .object({
        provider: z.string().min(1),
        model: z.string().min(1),
        maxTokens: z.number().int().positive().optional(),
      })
      .strict(),
    tools: z.array(z.string().min(1)),
    creates: z.record(z.string(), z.number().int().positive()),
    maxInstances: z.number().int().positive(),
  })
  .strict()
/** Configuration validates at the file/plugin boundary; no scientific role names are built in. */
export const organizationSchema = z
  .object({
    project: z.string().min(1),
    rootRole: z.string().min(1),
    maxParticipants: z.number().int().positive(),
    maxDepth: z.number().int().nonnegative(),
    roles: z.record(z.string(), roleSchema),
    relations: z.array(z.object({ fromRole: z.string(), toRole: z.string() }).strict()),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const role of [
      value.rootRole,
      ...Object.values(value.roles).flatMap((r) => Object.keys(r.creates)),
      ...value.relations.flatMap((r) => [r.fromRole, r.toRole]),
    ]) {
      if (!value.roles[role]) ctx.addIssue({ code: 'custom', message: `Unknown role ${role}` })
    }
  })
export type OrganizationConfig = z.infer<typeof organizationSchema>
/** Historical associations are facts only; they never constitute restored authority. */
export interface Participant {
  id: SessionId
  project: string
  role: string
  parentId?: SessionId
  depth: number
  task: string
}
/** The composition may persist these facts in its sole execution store. */
export interface OrganizationHooks {
  record?: (event: string, data: Participant | Record<string, unknown>) => void
  resultReader?: ScienceResultReader
}

/** Thin policy over native Agent creation, exact live callers, direct messages and result relay. */
export class Organization {
  readonly config: OrganizationConfig
  private readonly participants = new Map<SessionId, Participant>()
  private readonly roots = new Set<Agent>()
  private readonly parentInstances = new Map<SessionId, Agent>()
  private closed = false
  private readonly wake = new Set<() => void>()
  constructor(
    private readonly ctx: Context,
    config: OrganizationConfig,
    private readonly hooks: OrganizationHooks = {},
  ) {
    this.config = organizationSchema.parse(config)
    const exchange = ctx.subagents.scienceResults
    if (
      !exchange ||
      exchange.project !== config.project ||
      !('maxPairs' in exchange) ||
      typeof exchange.assertLiveParticipant !== 'function'
    )
      throw new Error(
        'AI4Science v0.1 compatible host extension with matching project must be explicitly enabled',
      )
    if (hooks.resultReader)
      ctx.effect(() => exchange.bindResults(config.project, hooks.resultReader!), 'ai4science.result-store')
    ctx.on('agent/created', ({ agent }) => {
      const p = this.participants.get(agent.id)
      if (p) this.configure(agent, p)
    })
    ctx.on('agent/disposed', () => this.changed())
    ctx.on('agent/status', () => this.changed())
    ctx.on('agent/inbox/inserted', () => this.changed())
    const subagents = ctx.subagents
    ctx.effect(
      () => async () => {
        this.closed = true
        for (const p of this.participants.values()) {
          const live = ctx.agents.get(p.id)
          if (live) exchange.parentDisposed(live)
        }
        this.changed()
        await Promise.all(
          [...this.roots]
            .filter((root) => ctx.agents.get(root.id) === root)
            .map((root) =>
              subagents.drainContinuableChildren(
                root,
                [...this.participants.values()].filter((p) => p.parentId === root.id).map((p) => p.id),
              ),
            ),
        )
      },
      'ai4science.organization',
    )
  }
  /** Attach only the explicitly supplied live root. Session ids from storage do not enroll anyone. */
  registerRoot(agent: Agent, task: string): Participant {
    if (
      this.closed ||
      this.roots.size > 0 ||
      this.ctx.agents.get(agent.id) !== agent ||
      agent.session.header.parentSession ||
      this.participants.has(agent.id)
    )
      throw new Error('Root enrollment requires a fresh exact live root')
    const p: Participant = {
      id: agent.id,
      project: this.config.project,
      role: this.config.rootRole,
      depth: 0,
      task,
    }
    this.participants.set(agent.id, p)
    this.roots.add(agent)
    this.configure(agent, p)
    this.record('participant-created', p)
    return p
  }
  private configure(agent: Agent, p: Participant) {
    const role = this.config.roles[p.role]!
    Object.assign(agent.options, role.model)
    agent.ctx.tools.restrict({ allow: role.tools })
    agent.ctx.systemPrompt.section({
      name: 'ai4science:role',
      order: 1,
      text: () => `${role.instructions}\nProject: ${p.project}\nRole: ${p.role}\nTask: ${p.task}`,
    })
  }
  /** Reject stale objects, foreign projects, removed roots and capabilities absent from role configuration. */
  assertActor(agent: Agent, tool?: string): Participant {
    const p = this.participants.get(agent.id)
    if (this.closed || !p || this.ctx.agents.get(agent.id) !== agent)
      throw new Error('Exact live project participant required')
    this.ctx.subagents.scienceResults!.assertLiveParticipant(agent)
    let ancestor = p
    while (ancestor.parentId) {
      const parent = this.participants.get(ancestor.parentId)
      if (!parent) throw new Error('Missing participant ancestry')
      if (this.ctx.agents.get(parent.id) !== this.parentInstances.get(ancestor.id))
        throw new Error('Ancestor live instance expired')
      this.ctx.subagents.scienceResults!.assertLiveParticipant(this.parentInstances.get(ancestor.id)!)
      ancestor = parent
    }
    if (![...this.roots].some((root) => root.id === ancestor.id && this.ctx.agents.get(root.id) === root))
      throw new Error('Project root instance expired')
    if (agent.session.header.parentSession !== p.parentId) throw new Error('Participant lineage changed')
    if (tool && !this.config.roles[p.role]!.tools.includes(tool)) throw new Error(`Role cannot use ${tool}`)
    return p
  }
  /** Reserve configured role limits synchronously, then let Harness create a true continuable child. */
  async create(parent: Agent, role: string, task: string, signal: AbortSignal) {
    const owner = this.assertActor(parent, 'org_create')
    const spec = this.config.roles[role]
    const limit = this.config.roles[owner.role]!.creates[role]
    if (!spec || !limit || owner.depth >= this.config.maxDepth)
      throw new Error('Role/delegation depth denied')
    const all = [...this.participants.values()]
    if (
      all.length >= this.config.maxParticipants ||
      all.filter((p) => p.role === role).length >= spec.maxInstances ||
      all.filter((p) => p.parentId === parent.id && p.role === role).length >= limit
    )
      throw new Error('Participant limit reached')
    const p: Participant = {
      id: SessionId(randomUUID()),
      project: this.config.project,
      role,
      parentId: parent.id,
      depth: owner.depth + 1,
      task,
    }
    this.participants.set(p.id, p)
    this.parentInstances.set(p.id, parent)
    this.record('participant-reserved', p)
    try {
      const accepted = await this.ctx.subagents.startContinuable({
        provider: 'spawn',
        childId: p.id,
        label: role,
        signal,
        request: {
          parent,
          prompt: [{ type: 'text', text: task }],
          agentOptions: {
            provider: spec.model.provider,
            model: spec.model.model,
            ...(spec.model.maxTokens === undefined ? {} : { maxTokens: spec.model.maxTokens }),
          },
          maxDepth: this.config.maxDepth,
          toolFilter: { allow: spec.tools },
        },
      })
      this.record('participant-created', p)
      return { participant: p, messageId: accepted.messageId }
    } catch (error) {
      this.participants.delete(p.id)
      this.parentInstances.delete(p.id)
      this.record('participant-create-failed', { ...p, error: String(error) })
      throw error
    }
  }
  private related(a: Participant, b: Participant): boolean {
    return (
      a.id !== b.id &&
      a.parentId !== b.parentId &&
      this.config.relations.some(
        (r) =>
          (r.fromRole === a.role && r.toRole === b.role) || (r.toRole === a.role && r.fromRole === b.role),
      )
    )
  }
  /** Discovery is bounded to self, direct relatives, and configured collaboration candidates. Discovery grants no consent. */
  discover(actor: Agent) {
    const p = this.assertActor(actor, 'org_discover')
    const children = [...this.participants.values()].filter((q) => q.parentId === p.id)
    return [...this.participants.values()]
      .filter(
        (q) =>
          q.id === p.id ||
          q.id === p.parentId ||
          q.parentId === p.id ||
          this.related(p, q) ||
          children.some((child) => this.related(child, q)),
      )
      .map((q) => ({ ...q, status: this.ctx.agents.get(q.id)?.status ?? 'inactive' }))
  }
  /** Each exact real parent independently consents to one configured child/peer relationship. */
  async authorize(parent: Agent, childId: SessionId, peerChildId: SessionId, signal: AbortSignal) {
    this.assertActor(parent, 'org_authorize')
    const child = this.participants.get(childId),
      peer = this.participants.get(peerChildId)
    if (!child || !peer || child.parentId !== parent.id || !this.related(child, peer) || !peer.parentId)
      throw new Error('Collaboration target denied')
    const peerParent = this.ctx.agents.get(peer.parentId)
    if (!peerParent) throw new Error('Peer parent is inactive')
    this.assertActor(peerParent)
    await this.ctx.subagents.scienceResults!.authorize(parent, { childId, peerChildId, peerParent }, signal)
    this.record('consent', { parentId: parent.id, childId, peerChildId })
  }
  /** Revokes both consents before future acceptance; accepted native inbox messages are not recalled. */
  revoke(parent: Agent, childId: SessionId, peerChildId: SessionId) {
    this.assertActor(parent, 'org_authorize')
    this.ctx.subagents.scienceResults!.revoke(parent, childId, peerChildId)
    this.record('consent-revoked', { parentId: parent.id, childId, peerChildId })
  }
  /** Return acceptance id only. Correlated reply is an application processing acknowledgment. */
  async send(actor: Agent, target: SessionId, message: ScienceResultMessage, signal: AbortSignal) {
    const p = this.assertActor(actor, 'org_send_result'),
      peer = this.participants.get(target)
    if (!peer || !this.related(p, peer)) throw new Error('Collaboration target denied')
    return this.ctx.subagents.scienceResults!.send(actor, target, message, signal)
  }
  /** Native direct-parent/child communication retains the host's original authorization. */
  async message(actor: Agent, target: SessionId, text: string, signal: AbortSignal) {
    this.assertActor(actor, 'org_message')
    if (!this.participants.has(target)) throw new Error('Target is outside project')
    return this.ctx.subagents.sendMessage(actor, target, [{ type: 'text', text }], { signal })
  }
  /** Event wait, with a race-free inbox recheck. Timeout/abort is not execution cancellation. */
  async wait(
    actor: Agent,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ reason: 'message' | 'timeout' }> {
    this.assertActor(actor, 'org_wait')
    signal.throwIfAborted()
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000)
      throw new Error('Wait timeout must be 1..3600000 ms')
    return new Promise((resolve, reject) => {
      const finish = (reason: 'message' | 'timeout') => {
        cleanup()
        resolve({ reason })
      }
      const abort = () => {
        cleanup()
        reject(signal.reason)
      }
      const check = () => {
        try {
          this.assertActor(actor)
          if (actor.inbox.nextStep.length || actor.inbox.nextTurn.length) finish('message')
        } catch (error) {
          cleanup()
          reject(error)
        }
      }
      const cleanup = () => {
        clearTimeout(timer)
        this.wake.delete(check)
        signal.removeEventListener('abort', abort)
      }
      const timer = setTimeout(() => finish('timeout'), timeoutMs)
      this.wake.add(check)
      signal.addEventListener('abort', abort, { once: true })
      check()
      if (signal.aborted) abort()
    })
  }
  /** Stop admission and drain descendants through the native host. Does not cancel Provider equipment. */
  async close(root: Agent): Promise<void> {
    this.assertActor(root, 'org_finish')
    if (!this.roots.has(root)) throw new Error('Only current project root can finish')
    this.closed = true
    for (const p of this.participants.values()) {
      const live = this.ctx.agents.get(p.id)
      if (live) this.ctx.subagents.scienceResults!.parentDisposed(live)
    }
    this.changed()
    await this.ctx.subagents.drainContinuableChildren(
      root,
      [...this.participants.values()].filter((p) => p.parentId === root.id).map((p) => p.id),
    )
    this.record('organization-closed', { rootId: root.id })
  }
  private record(event: string, data: Participant | Record<string, unknown>) {
    this.hooks.record?.(event, data)
    this.changed()
  }
  private changed() {
    for (const waiter of [...this.wake]) waiter()
  }
}
/** Create a configured policy object inside the existing Cordis host; it owns no scheduler. */
export function createOrganization(ctx: Context, config: OrganizationConfig, hooks: OrganizationHooks = {}) {
  return new Organization(ctx, config, hooks)
}
