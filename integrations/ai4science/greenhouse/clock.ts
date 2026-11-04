/** One explicitly owned background clock per greenhouse device directory. */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import type { GreenhouseWorld } from './world.ts'

/** Hold the clock lock through failure until disposal; failure never silently permits a second owner. */
export class GreenhouseClock {
  private readonly lock: DatabaseSync
  private timer: ReturnType<typeof setInterval> | undefined
  private disposed = false
  private clockFailure: Error | undefined

  /** Start background ticks independently of Agent requests.
   * @param world The connection advanced by this owner; caller closes it after clock disposal.
   * @param onFailure Required fatal-error reporter. It must not throw.
   */
  constructor(world: GreenhouseWorld, private readonly onFailure: (error: Error) => void) {
    this.lock = new DatabaseSync(join(world.directory, 'clock-owner.sqlite'))
    try { this.lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE') }
    catch (error) { this.lock.close(); throw new Error('Another clock owns this greenhouse', { cause: error }) }
    this.timer = setInterval(() => {
      try { world.step() }
      catch (error) {
        this.clockFailure = error instanceof Error ? error : new Error(String(error))
        clearInterval(this.timer)
        this.timer = undefined
        this.onFailure(this.clockFailure)
      }
    }, world.scenario.tickMs)
  }

  /** Read clock health separately from greenhouse operation status.
   * @returns Whether ticks are scheduled and the error if ticking failed.
   */
  status() { return { running: this.timer !== undefined, disposed: this.disposed, failure: this.clockFailure?.message ?? null } }

  /** Stop future synchronous ticks and release ownership. Accepted device actions remain recorded. */
  close(): void {
    if (this.disposed) return
    clearInterval(this.timer)
    this.timer = undefined
    this.lock.exec('ROLLBACK')
    this.lock.close()
    this.disposed = true
  }
}
