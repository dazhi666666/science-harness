/** Shared identities for physical sample locks and output references. */
import type { LaboratoryCommand } from './schema.ts'

/** Enumerate every input sample reserved by one accepted device operation.
 * @param command Validated device command.
 * @returns Ordered sample IDs, starting with the primary sample.
 */
export function laboratorySampleIds(command: LaboratoryCommand): string[] {
  if (!('sampleId' in command)) return []
  return command.action === 'process' ? [command.sampleId, ...(command.additionalSampleIds ?? [])] : [command.sampleId]
}

/** Compute the output identities for one batch position while retaining single-sample identities.
 * @param operationId Accepted execution operation.
 * @param index Zero-based batch position.
 * @returns Immutable child-sample and measurement identities.
 */
export function laboratoryOutputIds(operationId: string, index: number) {
  const suffix = index === 0 ? operationId : `${operationId}:${index + 1}`
  return { sampleId: `sample:${suffix}`, resultId: `result:${suffix}` }
}
