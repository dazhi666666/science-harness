/** Public, host-independent provider API for the single-machine execution domain. */
export const PROVIDER_API_VERSION = 1 as const
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type OperationState =
  | 'registered'
  | 'dispatching'
  | 'accepted'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown'
export interface ProviderDescription {
  apiVersion: typeof PROVIDER_API_VERSION
  id: string
  version: string
  configuration: Json
  inputSchema: Json
  outputSchema: Json
  units: Record<string, string>
  constraints: string[]
  completion: string
  cancellation: string
}
/** Resources are domain-wide exclusive names; budget is a nonnegative charge reserved before dispatch. */
export interface PreparedOperation {
  input: Json
  resources: string[]
  budget: number
}
/** Providers write outputs below artifactDirectory; all operations in one management domain share its fixed, real parent directory. Reference providers permanently bind their device journal to that parent. Persisted result files must be immutable. */
export interface ProviderOperation {
  operationId: string
  projectId: string
  input: Json
  artifactDirectory: string
}
export interface ProviderArtifact {
  path: string
  mediaType: string
}
/** not_found never authorizes blind replay after an uncertain dispatch. */
export interface ProviderObservation {
  state: 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown' | 'not_found'
  progress?: Json
  detail?: string
  artifacts?: ProviderArtifact[]
}
/** A cancellation acknowledgement is separate from an observed terminal device state. */
export interface CancellationResponse {
  disposition: 'requested' | 'unsupported' | 'rejected'
  observation?: ProviderObservation
  detail?: string
}
/** A provider must durably deduplicate operationId independently of the platform database. */
export interface ExecutionProvider {
  describe(): ProviderDescription
  prepare(input: Json): PreparedOperation
  submit(operation: ProviderOperation): Promise<ProviderObservation>
  query(operation: ProviderOperation): Promise<ProviderObservation>
  cancel(operation: ProviderOperation): Promise<CancellationResponse>
}
/** Opaque, process-local access granted by a trusted CLI or live-agent adapter; IDs alone grant nothing. */
export interface OperationContext {
  readonly projectId: string
  readonly actorId: string
  readonly allowedProviders: readonly string[]
}
export interface ResultArtifact {
  id: string
  operationId: string
  path: string
  sha256: string
  bytes: number
  mediaType: string
}
export interface OperationRecord {
  /** v0.1 executes single-operation runs: runId is the same durable identity as id, with no implicit workflow. */
  runId: string
  id: string
  projectId: string
  actorId: string
  providerId: string
  providerVersion: string
  requestKey: string
  input: Json
  resources: string[]
  budget: number
  state: OperationState
  cancelRequested: boolean
  progress: Json | null
  detail: string | null
  createdAt: string
  updatedAt: string
  artifacts: ResultArtifact[]
}
/** Canonical JSON for durable request identity. Rejects non-JSON values and nonfinite numbers. */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k]!)}`)
      .join(',')}}`
  throw new Error('Input must contain only finite JSON values')
}
/** Validates registration metadata at the plugin boundary; returns the same provider. */
export function validateProvider(provider: ExecutionProvider): ExecutionProvider {
  if (
    !provider ||
    !['describe', 'prepare', 'submit', 'query', 'cancel'].every(
      (key) => typeof provider[key as keyof ExecutionProvider] === 'function',
    )
  )
    throw new Error('Provider must implement describe, prepare, submit, query and cancel')
  const d = provider.describe()
  if (
    !d ||
    d.apiVersion !== PROVIDER_API_VERSION ||
    typeof d.id !== 'string' ||
    !/^[a-zA-Z0-9._-]+$/.test(d.id) ||
    ![d.version, d.completion, d.cancellation].every((v) => typeof v === 'string' && v.length > 0) ||
    !Array.isArray(d.constraints) ||
    !d.constraints.every((v) => typeof v === 'string') ||
    !d.units ||
    typeof d.units !== 'object' ||
    Array.isArray(d.units) ||
    !Object.values(d.units).every((v) => typeof v === 'string')
  )
    throw new Error('Incompatible or invalid provider metadata')
  canonicalJson(d.inputSchema)
  canonicalJson(d.outputSchema)
  canonicalJson(d.configuration)
  return provider
}
