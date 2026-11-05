/** Laboratory clock shares the existing native decision, tool and delivery barriers. */
import { SimulationClock } from '../simulation-clock.ts'
import type { LaboratoryWorld } from './world.ts'

/** Event-only clock; no host duration advances laboratory dynamics. */
export class LaboratoryClock extends SimulationClock {
  /** Acquire one physical owner and hold logical time during participant decisions.
   * @param world Live device connection, closed after clock disposal.
   * @param onFailure Fatal reporter, which must not throw.
   */
  constructor(world: LaboratoryWorld, onFailure: (error: Error) => void) {
    super(world.directory, () => world.advance() !== null, onFailure, 'event-driven')
  }
}
