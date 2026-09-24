/** One shared, sequential simulated instrument for a single process lifetime. */
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds))

/** Raw observation; order increases across every run on the instrument. */
export interface Reading {
  runId: string
  operationId: string
  requestedCondition: number
  appliedCondition: number
  order: number
  timestamp: string
  value: number
  unit: string
}

type ExecutionStatus = 'accepted' | 'running' | 'completed' | 'failed'

/** Persisted acquisition request and terminal execution outcome. */
export interface Operation {
  operationId: string
  runId: string
  condition: number
  count: number
  status: ExecutionStatus
  acquiredReadings: number
  createdAt: string
  startedAt?: string
  finishedAt?: string
  error?: string
}

/** A short exclusive reservation containing at most three operations. */
export interface Run {
  runId: string
  ownerId: string
  requestKey: string
  branch: 'A' | 'B'
  phase: 'initial' | 'followup'
  decisionId?: string
  status: ExecutionStatus
  operationIds: string[]
  requestedReadings: number
  acquiredReadings: number
  createdAt: string
  startedAt?: string
  finishedAt?: string
  error?: string
}

/** Model-tool input, validated before reservation or device effects. */
export interface RunRequest {
  requestKey: string
  branch: 'A' | 'B'
  phase: 'initial' | 'followup'
  operations: { condition: number; count: number }[]
  decisionId?: string
}

/** Submission acceptance is distinct from acquisition completion. */
export interface Submission {
  status: 'accepted' | 'busy'
  runId?: string
  operationIds?: string[]
  duplicate?: boolean
}

/** Scenario options; the evaluator controls the seed, never a model tool. */
export interface InstrumentOptions {
  root: string
  budget?: number
  maxOperationsPerRun?: number
  readingDelayMs?: number
  seed?: number
}

/** Budget charged at acceptance; failed reservations remain charged. */
export interface BudgetStatus {
  limit: number
  acquired: number
  reserved: number
  remaining: number
  activeRunId: string | null
  stopped: boolean
}

/** A bounded simulator, without cancellation, recovery, or a provider framework. */
export class SimulatedInstrument {
  private readonly directory: string
  private readonly limit: number
  private readonly maxOperations: number
  private readonly readingDelayMs: number
  private readonly seed: number
  private randomState: number
  private initialized = false
  private closing = false
  private failure: Error | undefined
  private activeRunId: string | null = null
  private activeTask: Promise<void> | undefined
  private readonly runs = new Map<string, Run>()
  private readonly operations = new Map<string, Operation>()
  private readonly requests = new Map<string, { signature: string; runId: string }>()
  private readonly observations: Reading[] = []
  private charged = 0

  constructor(private readonly options: InstrumentOptions) {
    this.directory = path.join(options.root, 'instrument')
    this.limit = options.budget ?? 96
    this.maxOperations = options.maxOperationsPerRun ?? 3
    this.readingDelayMs = options.readingDelayMs ?? 15
    this.seed = options.seed ?? randomBytes(4).readUInt32LE()
    this.randomState = this.seed >>> 0
    if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 96) throw new Error('budget must be an integer from 1 to 96')
    if (!Number.isInteger(this.maxOperations) || this.maxOperations < 1 || this.maxOperations > 3) throw new Error('maxOperationsPerRun must be from 1 to 3')
    if (!Number.isFinite(this.readingDelayMs) || this.readingDelayMs < 0 || this.readingDelayMs > 10000) throw new Error('readingDelayMs must be from 0 to 10000')
    if (!Number.isInteger(this.seed) || this.seed < 0 || this.seed > 0xffffffff) throw new Error('seed must be an unsigned 32-bit integer')
  }

  /** Claim a fresh instrument directory; an existing directory always blocks launch. */
  async initialize(): Promise<void> {
    if (this.initialized || this.closing) throw new Error('instrument cannot initialize twice or after close')
    mkdirSync(this.options.root, { recursive: true, mode: 0o700 })
    try {
      mkdirSync(this.directory, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('existing instrument state: second controller and recovery are unsupported')
      throw error
    }
    for (const name of ['runs', 'operations', 'raw']) mkdirSync(path.join(this.directory, name), { mode: 0o700 })
    mkdirSync(path.join(this.options.root, '_evaluator'), { recursive: true, mode: 0o700 })
    this.writeJson(path.join(this.options.root, '_evaluator', 'simulator.json'), {
      version: 1, seed: this.seed, reference: 10, conditionSlope: 0.27,
      driftPerReading: 0.012, uniformNoiseHalfWidth: 0.18,
      noSettlingTransient: true, generator: 'mulberry32-uniform',
    })
    this.initialized = true
    this.event('initialized', { budget: this.limit, maxOperationsPerRun: this.maxOperations, noSettlingTransient: true })
  }

  /** Validate and reserve atomically; a replay never draws noise or charges twice.
   * @param ownerId Exact host caller identity checked by the plugin.
   * @param request Measurement inputs and stable owner-scoped request key.
   * @returns Accepted references or busy; acceptance does not imply execution success.
   */
  async submit(ownerId: string, request: RunRequest): Promise<Submission> {
    this.assertReady()
    this.validate(ownerId, request)
    const key = JSON.stringify([ownerId, request.requestKey])
    const signature = JSON.stringify({ branch: request.branch, phase: request.phase, operations: request.operations.map(({ condition, count }) => ({ condition, count })), decisionId: request.decisionId ?? null })
    const previous = this.requests.get(key)
    if (previous) {
      if (previous.signature !== signature) throw new Error('requestKey already used with different inputs')
      const run = this.runs.get(previous.runId)!
      return { status: 'accepted', runId: run.runId, operationIds: [...run.operationIds], duplicate: true }
    }
    if (this.closing) throw new Error('instrument is closing; new work is refused')
    if (this.failure) throw new Error(`instrument stopped after execution failure: ${this.failure.message}`)
    if (this.activeRunId) return { status: 'busy' }
    const requestedReadings = request.operations.reduce((sum, operation) => sum + operation.count, 0)
    if (this.charged + requestedReadings > this.limit) throw new Error('acquisition budget exceeded')
    const runId = `run-${randomUUID()}`
    const createdAt = new Date().toISOString()
    const operationIds = request.operations.map(() => `operation-${randomUUID()}`)
    const run: Run = { runId, ownerId, requestKey: request.requestKey, branch: request.branch, phase: request.phase, ...(request.decisionId ? { decisionId: request.decisionId } : {}), status: 'accepted', operationIds, requestedReadings, acquiredReadings: 0, createdAt }
    this.activeRunId = runId
    this.charged += requestedReadings
    this.runs.set(runId, run)
    this.requests.set(key, { signature, runId })
    request.operations.forEach(({ condition, count }, index) => {
      this.operations.set(operationIds[index]!, { operationId: operationIds[index]!, runId, condition, count, status: 'accepted', acquiredReadings: 0, createdAt })
    })
    try {
      this.persist(run)
      this.event('accepted', { runId, ownerId, requestKey: request.requestKey, requestedReadings })
    } catch (error) {
      this.markFailed(run, error)
      throw this.failure
    }
    // Start after the submitting call has received its references.
    this.activeTask = delay(0).then(() => this.acquire(run)).catch(error => this.markFailed(run, error))
    return { status: 'accepted', runId, operationIds: [...operationIds], duplicate: false }
  }

  /** @param runId Persisted run reference. @returns A detached status snapshot. */
  queryRun(runId: string): Run {
    const run = this.runs.get(runId)
    if (!run) throw new Error(`unknown run: ${runId}`)
    return structuredClone(run)
  }

  /** @param operationId Persisted operation reference. @returns A detached status snapshot. */
  queryOperation(operationId: string): Operation {
    const operation = this.operations.get(operationId)
    if (!operation) throw new Error(`unknown operation: ${operationId}`)
    return structuredClone(operation)
  }

  /** @returns Detached run records, including partial failures. */
  listRuns(): Run[] { return [...this.runs.values()].map(run => structuredClone(run)) }

  /** @param runIds Input run references. @returns Acquired observations, including retained partial readings. */
  readings(runIds: string[]): Reading[] {
    for (const runId of runIds) this.queryRun(runId)
    const ids = new Set(runIds)
    return this.observations.filter(reading => ids.has(reading.runId)).map(reading => ({ ...reading }))
  }

  /** @returns Current acquired and outstanding reserved capacity. */
  budgetStatus(): BudgetStatus {
    return { limit: this.limit, acquired: this.observations.length, reserved: this.charged - this.observations.length, remaining: this.limit - this.charged, activeRunId: this.activeRunId, stopped: this.closing || !!this.failure }
  }

  /** Await terminal acquisition; abort only stops waiting, never the instrument.
   * @param runId Accepted run reference.
   * @param signal Optional cancellation of this wait only.
   * @returns Completed record; throws for a failed run or aborted wait.
   */
  async waitRun(runId: string, signal?: AbortSignal): Promise<Run> {
    const run = this.queryRun(runId)
    if (run.status === 'accepted' || run.status === 'running') await this.waitTask(signal)
    signal?.throwIfAborted()
    const result = this.queryRun(runId)
    if (result.status !== 'completed') throw new Error(`run ${runId} ${result.status}: ${result.error ?? 'not complete'}`)
    return result
  }

  /** Wait for reservation release; failed execution remains stopped.
   * @param signal Optional cancellation of this wait only.
   */
  async waitAvailable(signal?: AbortSignal): Promise<void> {
    this.assertReady()
    await this.waitTask(signal)
    signal?.throwIfAborted()
    if (this.failure) throw new Error(`instrument stopped: ${this.failure.message}`)
    if (this.closing) throw new Error('instrument is closing')
  }

  /** Stop submissions, reconcile the active run, and retain all records. */
  async close(): Promise<void> {
    this.closing = true
    await this.activeTask
    if (this.initialized) this.event('closed', { failed: !!this.failure, budget: this.budgetStatus() })
  }

  private assertReady(): void {
    if (!this.initialized) throw new Error('instrument is not initialized')
  }

  private validate(ownerId: string, request: RunRequest): void {
    if (typeof ownerId !== 'string' || !ownerId.trim()) throw new Error('ownerId is required')
    if (!request || typeof request.requestKey !== 'string' || !request.requestKey.trim() || request.requestKey.length > 200) throw new Error('requestKey must contain 1 to 200 characters')
    if (request.branch !== 'A' && request.branch !== 'B') throw new Error('branch must be A or B')
    if (request.phase !== 'initial' && request.phase !== 'followup') throw new Error('phase must be initial or followup')
    if (request.phase === 'followup' && (typeof request.decisionId !== 'string' || !request.decisionId.trim())) throw new Error('followup requires a decisionId')
    if (!Array.isArray(request.operations) || request.operations.length < 1 || request.operations.length > this.maxOperations) throw new Error(`run requires 1 to ${this.maxOperations} operations`)
    for (const operation of request.operations) {
      if (!operation || !Number.isFinite(operation.condition) || operation.condition < -1 || operation.condition > 1) throw new Error('condition must be from -1 to 1')
      if (!Number.isInteger(operation.count) || operation.count < 1 || operation.count > 8) throw new Error('reading count must be an integer from 1 to 8')
    }
  }

  private async acquire(run: Run): Promise<void> {
    run.status = 'running'
    run.startedAt = new Date().toISOString()
    this.persist(run)
    this.event('started', { runId: run.runId })
    for (const operationId of run.operationIds) {
      const operation = this.operations.get(operationId)!
      operation.status = 'running'
      operation.startedAt = new Date().toISOString()
      this.persist(run)
      this.event('condition-applied', { runId: run.runId, operationId, requestedCondition: operation.condition, appliedCondition: operation.condition })
      for (let index = 0; index < operation.count; index++) {
        await delay(this.readingDelayMs)
        const order = this.observations.length + 1
        const value = 10 + 0.27 * operation.condition + 0.012 * (order - 1) + 0.18 * (2 * this.random() - 1)
        const reading: Reading = { runId: run.runId, operationId, requestedCondition: operation.condition, appliedCondition: operation.condition, order, timestamp: new Date().toISOString(), value, unit: 'simulated output units' }
        this.observations.push(reading)
        operation.acquiredReadings++
        run.acquiredReadings++
        this.event('reading-acquired', reading)
        this.persistRaw(run)
        this.persist(run)
      }
      operation.status = 'completed'
      operation.finishedAt = new Date().toISOString()
      this.persist(run)
      this.event('operation-completed', { runId: run.runId, operationId })
    }
    run.status = 'completed'
    run.finishedAt = new Date().toISOString()
    this.activeRunId = null
    this.persist(run)
    this.event('completed', { runId: run.runId, acquiredReadings: run.acquiredReadings })
  }

  private markFailed(run: Run, error: unknown): void {
    this.failure = error instanceof Error ? error : new Error(String(error))
    this.activeRunId = run.runId
    run.status = 'failed'
    run.finishedAt = new Date().toISOString()
    run.error = this.failure.message
    for (const operationId of run.operationIds) {
      const operation = this.operations.get(operationId)!
      if (operation.status !== 'completed') Object.assign(operation, { status: 'failed', finishedAt: run.finishedAt, error: run.error })
    }
    // Failed runs retain the reservation. A broken disk may prevent recording failure.
    try { this.persist(run); this.event('failed', { runId: run.runId, error: run.error, acquiredReadings: run.acquiredReadings }) }
    catch (persistenceError) { run.error += `; failure record could not be saved: ${String(persistenceError)}` }
  }

  private persist(run: Run): void {
    for (const id of run.operationIds) this.writeJson(path.join(this.directory, 'operations', `${id}.json`), this.operations.get(id))
    this.writeJson(path.join(this.directory, 'runs', `${run.runId}.json`), run)
    this.writeJson(path.join(this.directory, 'budget.json'), this.budgetStatus())
  }

  private persistRaw(run: Run): void {
    const readings = this.readings([run.runId])
    this.writeJson(path.join(this.directory, 'raw', `${run.runId}.json`), readings)
    const fields: (keyof Reading)[] = ['runId', 'operationId', 'requestedCondition', 'appliedCondition', 'order', 'timestamp', 'value', 'unit']
    const csv = [fields.join(','), ...readings.map(reading => fields.map(field => JSON.stringify(reading[field])).join(','))].join('\n') + '\n'
    this.writeAtomic(path.join(this.directory, 'raw', `${run.runId}.csv`), csv)
  }

  private writeJson(filename: string, value: unknown): void { this.writeAtomic(filename, JSON.stringify(value, null, 2) + '\n') }
  private writeAtomic(filename: string, content: string): void {
    const temporary = `${filename}.${randomUUID()}.tmp`
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, filename)
  }
  private event(type: string, data: unknown): void { appendFileSync(path.join(this.directory, 'events.jsonl'), JSON.stringify({ type, timestamp: new Date().toISOString(), data }) + '\n', { mode: 0o600 }) }
  private random(): number {
    let n = this.randomState += 0x6d2b79f5
    n = Math.imul(n ^ n >>> 15, n | 1)
    n ^= n + Math.imul(n ^ n >>> 7, n | 61)
    return ((n ^ n >>> 14) >>> 0) / 4294967296
  }
  private async waitTask(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (!this.activeTask) return
    if (!signal) return this.activeTask
    let onAbort: () => void = () => {}
    const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason ?? new Error('wait aborted')); signal.addEventListener('abort', onAbort, { once: true }) })
    try { await Promise.race([this.activeTask, aborted]) }
    finally { signal.removeEventListener('abort', onAbort) }
  }
}
