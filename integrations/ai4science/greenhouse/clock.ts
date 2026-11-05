/** Greenhouse clock uses shared physical ownership and native decision barriers. */
import type { GreenhouseWorld } from './world.ts'
import { SimulationClock } from './simulation-clock.ts'

/** Bind greenhouse event advancement and legacy environment pacing to the shared simulation clock. */
export class GreenhouseClock extends SimulationClock {
  /** Acquire exclusive ownership and bind the greenhouse's event or timer advancement.
   * @param world Owning world; close it after clock disposal.
   * @param onFailure Fatal reporter, which must not throw.
   * @param mode Event-driven evaluation or legacy timer pacing.
   * @param reviewTicks Virtual review interval during quiet environment periods.
   */
  constructor(world: GreenhouseWorld, onFailure: (error: Error) => void,
    mode: 'timer' | 'event-driven' = 'timer', reviewTicks = 30) {
    super(world.directory, () => { world.advanceToNextEvent(reviewTicks); return true }, onFailure, mode,
      { tickMs: world.scenario.tickMs, step: () => world.step() })
  }
}
