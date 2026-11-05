/** Evidence-based project delivery and dependency invalidation. */
import type { LaboratoryState } from './schema.ts'

/** Check current methods, distinct original samples and previously delivered prerequisites.
 * @param state Transactional laboratory snapshot.
 * @param taskId Task being delivered or reviewed.
 * @param resultIds Exact measurement references.
 * @param referenceResultIds Explicit measurements from prerequisite projects.
 * @returns Whether the references satisfy the currently released task.
 */
export function deliveryValid(state: LaboratoryState, taskId: string, resultIds: string[], referenceResultIds: string[] = []): boolean {
  const task = state.tasks.find(value => value.id === taskId)
  if (!task || task.releaseTick > state.tick || new Set(resultIds).size !== resultIds.length) return false
  if (task.prerequisites.some(id => !state.deliveries.some(delivery => delivery.taskId === id && delivery.valid))) return false
  if (state.externalReferences || referenceResultIds.length) {
    const expected = new Set(task.prerequisites.filter(id => state.tasks.find(value => value.id === id)?.projectId !== task.projectId)
      .flatMap(id => state.deliveries.find(delivery => delivery.taskId === id && delivery.valid)!.resultIds))
    if (referenceResultIds.length !== new Set(referenceResultIds).size || expected.size !== referenceResultIds.length ||
      referenceResultIds.some(id => !expected.has(id) || state.revocations.some(value => value.resultId === id))) return false
  }
  const roots = new Set<string>()
  for (const id of resultIds) {
    const result = state.results.find(value => value.id === id)
    if (!result || result.methodId !== task.methodId || result.methodVersion !== task.methodVersion ||
      !task.rootSampleIds.includes(result.rootSampleId) || state.revocations.some(value => value.resultId === id)) return false
    const ancestry = new Set<string>()
    let sample = state.samples.find(value => value.id === result.sampleId)
    while (sample) { ancestry.add(sample.id); sample = state.samples.find(value => value.id === sample!.parentId) }
    for (const prerequisite of task.prerequisites) {
      if (state.tasks.find(value => value.id === prerequisite)?.projectId !== task.projectId) continue
      const delivered = state.deliveries.filter(value => value.taskId === prerequisite && value.valid)
      if (!delivered.some(delivery => delivery.resultIds.some(id => {
        const reference = state.results.find(value => value.id === id)!
        return reference.rootSampleId === result.rootSampleId && ancestry.has(reference.outputSampleId ?? `sample:${reference.operationId}`)
      }))) return false
    }
    roots.add(result.rootSampleId)
  }
  return roots.size >= task.requiredResults
}

/** Withdraw invalid deliveries and their dependent deliveries while retaining their records.
 * @param state Mutable transaction snapshot.
 * @returns Task IDs whose previously valid deliveries were withdrawn.
 */
export function refreshDeliveries(state: LaboratoryState): string[] {
  const withdrawn = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const delivery of state.deliveries) {
      if (delivery.valid && !deliveryValid(state, delivery.taskId, delivery.resultIds, delivery.referenceResultIds)) {
        delivery.valid = false
        withdrawn.add(delivery.taskId)
        changed = true
      }
    }
  }
  return [...withdrawn]
}
