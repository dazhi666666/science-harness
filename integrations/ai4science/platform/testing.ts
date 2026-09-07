/** Minimal conformance utility for plugin developers. It checks the provider's independent start ledger. */
import {
  canonicalJson,
  validateProvider,
  type ExecutionProvider,
  type ProviderOperation,
  type ProviderObservation,
  type Json,
} from './sdk.ts'

/** Submit the same stable operation across two adapter instances; worldCount must read device-side evidence. */
export async function verifyStableSubmission(
  factory: () => ExecutionProvider | Promise<ExecutionProvider>,
  operation: ProviderOperation,
  worldCount: (id: string) => number,
): Promise<ProviderObservation> {
  const first = validateProvider(await factory())
  const initial = await first.submit(operation)
  if (initial.state === 'not_found' || initial.state === 'unknown')
    throw new Error('Provider did not confirm initial submission')
  const second = validateProvider(await factory())
  if (
    canonicalJson(first.describe() as unknown as Json) !== canonicalJson(second.describe() as unknown as Json)
  )
    throw new Error('Provider configuration changed across restart')
  const repeated = await second.submit(operation)
  if (worldCount(operation.operationId) !== 1)
    throw new Error('Independent device log does not show exactly one start')
  const changed = { ...operation, projectId: operation.projectId + '-different' }
  let rejected = false
  try {
    await second.submit(changed)
  } catch {
    rejected = true
  }
  if (!rejected) throw new Error('Provider accepted changed project for stable operation ID')
  return repeated
}
