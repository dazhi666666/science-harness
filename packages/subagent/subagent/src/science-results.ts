/** Opt-in, single-project, bounded-pair result-reference authority inside the existing subagent runtime. */
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentError } from './error.ts'

/** The only payloads this extension admits. Replies carry no arbitrary instructions or result data. */
export type ScienceResultMessage =
  | { readonly kind: 'reference'; readonly resultId: string }
  | { readonly kind: 'reply'; readonly resultId: string; readonly inReplyTo: MessageId }

/** Synchronous lookup over records published only after a successful durable science-store write. */
export type ScienceResultReader = (id: string) => { readonly project: string; readonly ownerSessionId: SessionId } | undefined

/** Durable provenance distinguishes the original worker from both authorizing parents. */
export interface ScienceResultSource {
  readonly kind: 'science-result'
  readonly form: 'relay'
  readonly project: string
  readonly senderSessionId: SessionId
  readonly senderParentSessionId: SessionId
  readonly recipientParentSessionId: SessionId
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'science-result': ScienceResultSource }
}

/** Explicit consent by the caller for its child to exchange references with one other parent's child. */
export interface SciencePeerConsent {
  readonly childId: SessionId
  readonly peerChildId: SessionId
  readonly peerParent: Agent
}

/** Manager-private adapter; delivery retains its direct-parent check and existing residency owner. */
export interface ScienceResultHost {
  assertLive(agent: Agent): void
  endpoint(parent: Agent, childId: SessionId, signal: AbortSignal): Promise<void>
  deliver(parent: Agent, childId: SessionId, content: (id: MessageId) => ContentBlock[], source: ScienceResultSource,
    signal: AbortSignal, beforeAccept: (id: MessageId) => () => void): Promise<MessageId>
}

interface Endpoint { readonly parent: Agent; readonly childId: SessionId }
interface PendingReference { readonly sender: SessionId; readonly target: SessionId; readonly resultId: string }
interface Pair {
  readonly endpoints: readonly [Endpoint, Endpoint]
  readonly consent: Set<Agent>
  readonly controller: AbortController
  readonly references: Map<MessageId, PendingReference>
}

const payloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reference'), resultId: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal('reply'), resultId: z.string().min(1).max(128), inReplyTo: z.string().min(1).max(128) }).strict(),
])

function reject(code: string, message: string): never { throw new SubagentError(message, code) }

/** Ephemeral consent and reply correlation, with no inbox, scheduler, Team roster or delivery queue. */
export class ScienceResultExchange {
  private readonly pairs = new Set<Pair>()
  private reader: ScienceResultReader | undefined
  private epoch = 0
  private shutdown = false
  /**
   * Read through a call so a `close()` that lands during an awaited check still
   * narrows nothing in the caller; the admission checks below must observe it.
   */
  private isClosed(): boolean { return this.shutdown }

  constructor(
    readonly project: string,
    private readonly maxPending: number,
    private readonly host: ScienceResultHost,
    readonly maxPairs = 1,
  ) {}

  /** Validate exact native residency and teardown admission without granting any communication rights. */
  assertLiveParticipant(agent: Agent): void {
    if (this.isClosed()) reject('SCIENCE_DISABLED', 'science result exchange is closed')
    this.host.assertLive(agent)
  }

  /**
   * Bind the one trusted project-result store. Unbinding revokes consent and pending admission.
   * @param project - Must equal the explicitly configured project.
   * @param reader - Synchronous post-durability metadata lookup; never an asynchronous dispatch hook.
   * @returns disposer for the binding.
   */
  bindResults(project: string, reader: ScienceResultReader): () => void {
    if (this.isClosed() || project !== this.project || this.reader !== undefined) reject('SCIENCE_BINDING_REJECTED', 'science result binding unavailable')
    this.reader = reader
    return () => { if (this.reader === reader) { this.reader = undefined; this.invalidate() } }
  }

  /**
   * Authorize the caller's own continuable child and exact peer/parent pair. Both parents must call.
   * @param parent - Exact live authorizing parent, never supplied by a worker's model arguments.
   * @param request - Own child and exact other parent/child.
   * @param signal - Cancellation before consent is committed.
   * @returns after the caller's consent is installed; this does not imply the other parent's consent.
   */
  async authorize(parent: Agent, request: SciencePeerConsent, signal: AbortSignal): Promise<void> {
    if (this.isClosed()) reject('SCIENCE_DISABLED', 'science result exchange is closed')
    const { childId, peerChildId, peerParent } = request
    this.host.assertLive(parent); this.host.assertLive(peerParent)
    if (parent.id === peerParent.id || childId === peerChildId) reject('SCIENCE_INVALID_PAIR', 'science exchange requires two distinct parents and children')
    const epoch = this.epoch
    await this.host.endpoint(parent, childId, signal)
    await this.host.endpoint(peerParent, peerChildId, signal)
    signal.throwIfAborted()
    this.host.assertLive(parent); this.host.assertLive(peerParent)
    if (this.isClosed() || epoch !== this.epoch) reject('SCIENCE_GRANT_CHANGED', 'consent changed during authorization')
    let pair = [...this.pairs].find(value => value.endpoints.some(endpoint => endpoint.parent === parent && endpoint.childId === childId)
      && value.endpoints.some(endpoint => endpoint.parent === peerParent && endpoint.childId === peerChildId))
    if (pair === undefined) {
      if (this.pairs.size >= this.maxPairs) reject('SCIENCE_PAIR_CONFLICT', 'configured science pair capacity reached; revoke before replacing it')
      pair = {
        endpoints: [{ parent, childId }, { parent: peerParent, childId: peerChildId }],
        consent: new Set(),
        controller: new AbortController(),
        references: new Map(),
      }
      this.pairs.add(pair)
    }
    pair.consent.add(parent)
  }

  /**
   * Revoke the entire pair immediately. Both parents must reauthorize; accepted messages are not recalled.
   * @param parent - One of the exact live parents that owns this pair.
   */
  revoke(parent: Agent, childId?: SessionId, peerChildId?: SessionId): void {
    this.host.assertLive(parent)
    const owned = [...this.pairs].filter(pair =>
      pair.endpoints.some(endpoint =>
        endpoint.parent === parent && (childId === undefined || endpoint.childId === childId))
      && (peerChildId === undefined || pair.endpoints.some(endpoint => endpoint.childId === peerChildId)))
    if (!owned.length) reject('SCIENCE_NO_GRANT', 'caller does not own the science pair')
    for (const pair of owned) this.invalidate(pair)
  }

  /** Invalidate consent when an exact parent leaves the registry; worker cold resume does not revoke it. */
  parentDisposed(agent: Agent): void {
    for (const pair of this.pairs) if (pair.endpoints.some(endpoint => endpoint.parent === agent)) this.invalidate(pair)
  }

  /** Close extension admission on host teardown or disable. Already accepted inbox work remains host-owned. */
  close(): void { this.shutdown = true; this.reader = undefined; this.invalidate() }

  /**
   * Admit a result reference or one correlated reverse reply through the existing continuation manager.
   * @param sender - Exact current live worker; stale same-id instances are rejected.
   * @param targetId - The one peer authorized by both real parents.
   * @param input - Strict reference/reply payload; the referenced record must exist in this project.
   * @param signal - Cancellation before acceptance, not ownership of the recipient's work.
   * @returns the actual recipient inbox message id, not a processing/completion receipt.
   */
  async send(sender: Agent, targetId: SessionId, input: ScienceResultMessage, signal: AbortSignal): Promise<MessageId> {
    const message = payloadSchema.parse(input) as ScienceResultMessage
    const pair = [...this.pairs].find(value =>
      value.endpoints.some(endpoint => endpoint.childId === sender.id)
      && value.endpoints.some(endpoint => endpoint.childId === targetId))
    if (this.isClosed() || this.pairs.size === 0) reject('SCIENCE_NO_GRANT', 'no active science pair')
    if (!pair) reject('SCIENCE_TARGET_DENIED', 'target is not the authorized science peer')
    const senderEndpoint = pair.endpoints.find(endpoint => endpoint.childId === sender.id)
    const target = pair.endpoints.find(endpoint => endpoint.childId === targetId)
    if (!senderEndpoint || !target || senderEndpoint === target) reject('SCIENCE_TARGET_DENIED', 'target is not the authorized science peer')
    const check = () => {
      if (this.isClosed() || !this.pairs.has(pair) || pair.consent.size !== 2) reject('SCIENCE_NO_GRANT', 'both exact parents must authorize the science pair')
      this.host.assertLive(sender)
      for (const endpoint of pair.endpoints) this.host.assertLive(endpoint.parent)
      if (sender.session.header.parentSession !== senderEndpoint.parent.id) reject('SCIENCE_LINEAGE_DENIED', 'sender is not its authorizing parent child')
      const result = this.reader?.(message.resultId)
      if (!result || result.project !== this.project) reject('SCIENCE_RESULT_UNAVAILABLE', 'persisted result is unavailable in this project')
      if (message.kind === 'reference') {
        if (result.ownerSessionId !== sender.id) reject('SCIENCE_RESULT_OWNER', 'reference must originate from its recorded science worker')
        if (pair.references.size >= this.maxPending) reject('SCIENCE_REFERENCE_LIMIT', 'too many pending science references')
      } else {
        const prior = pair.references.get(message.inReplyTo)
        if (!prior || prior.sender !== targetId || prior.target !== sender.id || prior.resultId !== message.resultId) reject('SCIENCE_REPLY_MISMATCH', 'reply must match one accepted reverse reference')
      }
    }
    check()
    const combined = AbortSignal.any([signal, pair.controller.signal])
    combined.throwIfAborted()
    return this.host.deliver(target.parent, targetId, id => [{ type: 'text', text: JSON.stringify({ messageId: id, project: this.project, senderSessionId: sender.id, ...message }) }], {
      kind: 'science-result', form: 'relay', project: this.project, senderSessionId: sender.id,
      senderParentSessionId: senderEndpoint.parent.id, recipientParentSessionId: target.parent.id,
    }, combined, (id) => {
      // Final no-await cutoff: checks and correlation reservation precede synchronous host enqueue.
      check()
      combined.throwIfAborted()
      if (message.kind === 'reference') {
        pair.references.set(id, { sender: sender.id, target: targetId, resultId: message.resultId })
        return () => { pair.references.delete(id) }
      }
      const prior = pair.references.get(message.inReplyTo)
      if (prior === undefined) reject('SCIENCE_REPLY_MISMATCH', 'reply must match one accepted reverse reference')
      pair.references.delete(message.inReplyTo)
      return () => { pair.references.set(message.inReplyTo, prior) }
    })
  }

  private invalidate(target?: Pair): void {
    const previous = target ? [target] : [...this.pairs]
    this.epoch++
    for (const pair of previous) {
      this.pairs.delete(pair)
      pair.controller.abort(new SubagentError('science consent was revoked before message acceptance', 'SCIENCE_REVOKED'))
    }
  }
}
