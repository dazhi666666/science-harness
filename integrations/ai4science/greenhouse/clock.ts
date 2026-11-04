/** One owned simulation clock, with event-driven decision barriers or legacy timer pacing. */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import type { GreenhouseWorld } from './world.ts'

/** Hold ownership through failure; model work and resource waits are explicit event barriers. */
export class GreenhouseClock {
  private readonly lock: DatabaseSync
  private timer: ReturnType<typeof setInterval> | undefined
  private immediate: ReturnType<typeof setImmediate> | undefined
  private pending: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private requested = false
  private disposed = false
  private clockFailure: Error | undefined
  private models = 0
  private readonly tools = new Map<string, number>()
  private readonly waits = new Map<symbol, { actor: string; ready: () => boolean }>()
  private driver: { ready: () => boolean; dispatch: () => Promise<void> } | undefined

  /** Acquire the clock lock; event mode awaits an attached native decision barrier.
   * @param world Owning world; caller closes it after clock disposal.
   * @param onFailure Fatal reporter, which must not throw.
   * @param mode Event-driven evaluation or legacy timer pacing.
   * @param reviewTicks Virtual review interval when no earlier world event occurs.
   */
  constructor(private readonly world: GreenhouseWorld, private readonly onFailure: (error: Error) => void,
    readonly mode: 'timer' | 'event-driven' = 'timer', private readonly reviewTicks = 30) {
    this.lock = new DatabaseSync(join(world.directory, 'clock-owner.sqlite'))
    try { this.lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE') }
    catch (error) { this.lock.close(); throw new Error('Another clock owns this greenhouse', { cause: error }) }
    if (mode === 'timer') this.timer = setInterval(() => {
      try { world.step() }
      catch (error) { this.fail(error) }
    }, world.scenario.tickMs)
  }

  private fail(error: unknown): void {
    if (this.disposed) return
    this.clockFailure = error instanceof Error ? error : new Error(String(error))
    clearInterval(this.timer); this.timer = undefined
    this.onFailure(this.clockFailure)
  }

  /** Attach participant readiness and awaited world-event delivery exactly once.
   * @param ready Whether every participant can allow virtual time to advance.
   * @param dispatch Deliver committed events before any later advance.
   */
  attach(ready: () => boolean, dispatch: () => Promise<void>): void {
    if (this.mode !== 'event-driven' || this.driver) throw new Error('Event clock must be attached exactly once')
    this.driver = { ready, dispatch }; this.wake()
  }

  /** Reconsider advancement after a native transition; no host duration is measured. */
  wake(): void {
    if (this.mode !== 'event-driven' || this.disposed || this.clockFailure || !this.driver) return
    if (this.immediate || this.pending) { this.requested = true; return }
    this.immediate = setImmediate(() => {
      this.immediate = undefined
      this.requested = false
      let advanced = false
      this.pending = (async () => {
        if (this.disposed || this.models || !this.driver!.ready()) return
        this.world.advanceToNextEvent(this.reviewTicks)
        advanced = true
        await this.driver!.dispatch()
      })().catch(error => { this.fail(error) }).finally(() => {
        this.pending = undefined
        if (advanced || this.requested) this.wake()
      })
    })
  }

  /** Hold virtual time during provider generation, including context summaries.
   * @returns Balanced completion callback for the stream's finally block.
   */
  modelStarted(): () => void {
    this.models++
    return () => { this.models--; this.wake() }
  }

  /** Track a participant tool until its result has been persisted.
   * @param actor Native Session identity.
   * @returns Balanced completion callback for the tool's finally block.
   */
  toolStarted(actor: string): () => void {
    this.tools.set(actor, (this.tools.get(actor) ?? 0) + 1)
    return () => {
      const count = this.tools.get(actor)! - 1
      if (count) this.tools.set(actor, count); else this.tools.delete(actor)
      this.wake()
    }
  }

  /** Mark a tool as blocked on simulation events or occupied resources.
   * @param actor Native Session identity.
   * @param ready Whether the tool can return or dispatch at the current tick.
   * @returns Removal callback for completion or cancellation.
   */
  waiting(actor: string, ready: () => boolean): () => void {
    const key = Symbol()
    this.waits.set(key, { actor, ready }); this.wake()
    return () => { this.waits.delete(key); this.wake() }
  }

  /** Check that all current tools for a running participant are genuinely blocked.
   * @param actor Native Session identity.
   * @returns False when a decision, result flush or dispatchable action needs an opportunity.
   */
  blocked(actor: string): boolean {
    const count = this.tools.get(actor) ?? 0
    const waits = [...this.waits.values()].filter(wait => wait.actor === actor)
    return count > 0 && waits.length === count && waits.every(wait => !wait.ready())
  }

  /** Read driver health independently of decision progress.
   * @returns Owned mode, lifecycle state and any fatal error.
   */
  status() { return { running: !this.disposed && !this.clockFailure, mode: this.mode,
    disposed: this.disposed, failure: this.clockFailure?.message ?? null } }

  /** Stop admission and await event delivery before releasing ownership.
   * @returns Quiescent clock disposal; accepted device records remain intact.
   */
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.disposed = true
    clearInterval(this.timer); this.timer = undefined
    clearImmediate(this.immediate); this.immediate = undefined
    const release = () => { this.lock.exec('ROLLBACK'); this.lock.close() }
    if (!this.pending) { release(); return this.closing = Promise.resolve() }
    return this.closing = this.pending.finally(release)
  }
}
