/** Route committed environmental changes to the responsible native members; no Agent runtime or scheduler is created. */
import { z } from 'zod'
import type { GreenhouseWorld } from './world.ts'
import { chamberSchema } from './schema.ts'

export type WorldEvent = ReturnType<GreenhouseWorld['events']>[number]

/** Map only public environmental events to responsible roles. Device results stay with their existing operation waits.
 * @param event Committed public device event.
 * @returns Responsible role, or undefined for an event with no automatic notification.
 */
export function eventRecipient(event: WorldEvent): string | undefined {
  if (event.kind === 'environment-power' || event.kind === 'environment-task') return 'lead'
  if (event.kind === 'environment-sensor' || event.kind === 'environment-range') {
    const data = z.object({ chamber: chamberSchema }).passthrough().parse(event.data)
    return `chamber-${data.chamber}`
  }
  return undefined
}

/** Observe committed world events and deliver coalesced notices, retaining failed deliveries for explicit diagnosis. */
export class GreenhouseEventDispatch {
  private cursor = 0
  private notices = 0
  private failure: Error | undefined
  private readonly abort = new AbortController()
  private readonly signal: AbortSignal
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<void> | undefined
  private closing: Promise<void> | undefined

  /** Start program-side event observation after all native members have registered.
   * @param world Owning runtime's world reader.
   * @param send Trusted application mailbox delivery; no model decisions are made here.
   * @param pollMs Explicit program observation interval.
   * @param signal Application owner cancellation.
   * @param onFailure Fatal notification error reporter; must not throw.
   */
  constructor(private readonly world: GreenhouseWorld,
    private readonly send: (role: string, events: WorldEvent[], signal: AbortSignal) => Promise<void>,
    private readonly pollMs: number, signal: AbortSignal, private readonly onFailure: (error: Error) => void,
    private readonly automatic = true) {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error('Positive event observation interval required')
    this.signal = AbortSignal.any([signal, this.abort.signal])
    this.signal.throwIfAborted()
    this.poll()
  }
  private poll(): void {
    this.timer = undefined
    this.pending = this.dispatch().catch(error => {
      if (this.signal.aborted) return
      this.failure = error instanceof Error ? error : new Error(String(error))
      this.onFailure(this.failure)
    }).finally(() => {
      this.pending = undefined
      if (this.automatic && !this.signal.aborted && !this.failure) this.timer = setTimeout(() => this.poll(), this.pollMs)
    })
  }
  /** Deliver committed events before the event clock admits another advance.
   * @returns Completion once all currently selected messages have been accepted.
   */
  async flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined
    if (this.pending) await this.pending
    clearTimeout(this.timer); this.timer = undefined
    if (this.signal.aborted || this.failure) return
    this.poll()
    await this.pending
  }

  private async dispatch(): Promise<void> {
    this.signal.throwIfAborted()
    const events = this.world.events(this.cursor)
    const grouped = new Map<string, WorldEvent[]>()
    for (const event of events) {
      const role = eventRecipient(event)
      if (!role) continue
      const selected = grouped.get(role) ?? []
      selected.push(event); grouped.set(role, selected)
    }
    for (const [role, selected] of grouped) {
      this.signal.throwIfAborted()
      await this.send(role, selected, this.signal)
      this.notices++
    }
    // Advance only after the selected native deliveries have actually accepted the batch.
    this.cursor = events.at(-1)?.seq ?? this.cursor
  }

  /** Read notification health separately from device and model health.
   * @returns Last consumed event cursor, accepted batch count and any failure.
   */
  status() { return { running: !this.signal.aborted && !this.failure, cursor: this.cursor,
    acceptedNotices: this.notices, failure: this.failure?.message ?? null } }

  /** Stop admission and await an in-flight native delivery before consumers close their Agents or stores.
   * @returns Completion after the current dispatch settled and no polling remains.
   */
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.abort.abort(new Error('Greenhouse event observer stopped by its owner'))
      clearTimeout(this.timer); this.timer = undefined
      await this.pending
    })())
  }
}
