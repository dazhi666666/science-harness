/** Route committed laboratory changes to the responsible native roles. */
import type { LaboratoryWorld } from './world.ts'
type Event = ReturnType<LaboratoryWorld['events']>[number]

/** Select roles for actual environmental changes; operation results use existing operation waits.
 * @param event Committed public laboratory event.
 * @returns Named native recipients, with no future event definitions.
 */
export function laboratoryRecipients(event: Event): string[] {
  switch (event.kind) {
    case 'task-released': case 'task-delivered': return ['lead']
    case 'device-fault': case 'device-temperature-stable': case 'power-capacity-changed': return ['facilities', 'lead']
    case 'sample-temperature-changed': case 'sample-preservation-failed': case 'sample-expired': return ['experiments', 'facilities']
    case 'method-revised': case 'batch-recalled': case 'calibration-results-revoked': case 'deliveries-withdrawn': return ['quality', 'lead']
    case 'supply-arrived': return ['facilities', 'experiments']
    default: return []
  }
}
