/** Durable execution management. Harness remains the owner of agents and sessions. */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, realpathSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve, relative, isAbsolute, dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  canonicalJson,
  validateProvider,
  type ExecutionProvider,
  type OperationContext,
  type OperationRecord,
  type ProviderOperation,
  type ProviderObservation,
  type ResultArtifact,
  type Json,
} from './sdk.ts'

import {
  ExperimentStore,
  EXPERIMENT_SCHEMA,
  type ExperimentAPI,
  type ExperimentBinding,
} from './experiments.ts'
import { Artifacts } from './artifacts.ts'

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])
const SCHEMA_VERSION = 2
interface Row {
  id: string
  project_id: string
  actor_id: string
  provider_id: string
  provider_version: string
  provider_fingerprint: string
  request_key: string
  request_json: string
  input_json: string
  resources_json: string
  budget: number
  state: OperationRecord['state']
  cancel_requested: number
  progress_json: string | null
  detail: string | null
  created_at: string
  updated_at: string
}
export interface ExecutionOptions {
  directory: string
  providers: ExecutionProvider[]
  pollIntervalMs: number
  providerCallTimeoutMs: number
}
export interface SubmitOperation {
  providerId: string
  requestKey: string
  input: Json
}

/** One effective controller holds a separate SQLite exclusive transaction for its entire lifetime. */
export class ExecutionEngine {
  readonly directory: string
  private experimentStore!: ExperimentStore
  private db!: DatabaseSync
  private lock!: DatabaseSync
  private readonly providers = new Map<string, ExecutionProvider>()
  private readonly blockedProviders = new Set<string>()
  private readonly contexts = new WeakSet<OperationContext>()
  private readonly managementAbort = new AbortController()
  private ready = false
  private closing = false
  private opening = false
  private readonly activeProviderOperations = new Set<string>()
  private readonly providerCalls = new Set<Promise<unknown>>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly operationLocks = new Map<string, Promise<unknown>>()
  constructor(private readonly options: ExecutionOptions) {
    if (!Number.isSafeInteger(options.providerCallTimeoutMs) || options.providerCallTimeoutMs < 1)
      throw new Error('providerCallTimeoutMs must be a positive integer')
    if (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs < 1)
      throw new Error('pollIntervalMs must be a positive integer')
    this.directory = resolve(options.directory)
    for (const provider of options.providers) {
      validateProvider(provider)
      const id = provider.describe().id
      if (this.providers.has(id)) throw new Error(`Duplicate provider: ${id}`)
      this.providers.set(id, provider)
    }
  }
  /** Acquires control and reconciles durable unfinished operations before admitting submissions. */
  async open(): Promise<void> {
    if (this.ready || this.opening || this.closing) throw new Error('Engine already opened or closed')
    this.opening = true
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    this.lock = new DatabaseSync(resolve(this.directory, 'controller.sqlite'))
    try {
      this.lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
    } catch (error) {
      this.lock.close()
      this.opening = false
      throw new Error('Another controller owns this execution domain', { cause: error })
    }
    try {
      this.db = new DatabaseSync(resolve(this.directory, 'execution.sqlite'))
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;')
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      if (version !== 0 && version !== 1 && version !== SCHEMA_VERSION)
        throw new Error(`Unsupported execution schema ${version}`)
      this.db
        .exec(`BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,budget_limit REAL NOT NULL,budget_used REAL NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),actor_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_version TEXT NOT NULL,provider_fingerprint TEXT NOT NULL,request_key TEXT NOT NULL,request_json TEXT NOT NULL,input_json TEXT NOT NULL,resources_json TEXT NOT NULL,budget REAL NOT NULL,state TEXT NOT NULL,cancel_requested INTEGER NOT NULL DEFAULT 0,progress_json TEXT,detail TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,request_key));
        CREATE TABLE IF NOT EXISTS resources(name TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES operations(id));
        CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES operations(id),path TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,media_type TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT,project_id TEXT,type TEXT NOT NULL,data_json TEXT NOT NULL,at TEXT NOT NULL);
        ${EXPERIMENT_SCHEMA}
        PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`)
      this.experimentStore = new ExperimentStore({
        db: this.db,
        pollMs: this.options.pollIntervalMs,
        signal: this.managementAbort.signal,
        binding: (providerId) => {
          const d = this.providers.get(providerId)!.describe()
          return {
            version: d.version,
            sha256: createHash('sha256')
              .update(canonicalJson(d as unknown as Json))
              .digest('hex'),
          }
        },
        authorize: (context, providerId) => this.authorize(context, providerId),
        transaction: (body) => this.transaction(body),
        submit: (context, request, binding) => this.submitBound(context, request, binding),
        get: (context, id) => this.get(context, id),
        query: (context, id) => this.query(context, id),
        cancel: (context, id) => this.cancel(context, id),
        artifact: (context, id) => new Artifacts(this).read(context, id),
      })
      for (const row of this.unfinished()) await this.refresh(row, 'recovery')
      this.ready = true
    } catch (error) {
      this.db?.close()
      this.lock.exec('ROLLBACK')
      this.lock.close()
      throw error
    } finally {
      this.opening = false
    }
  }
  /** Experiment facts and bounded decisions share this engine's authority and transaction store. */
  get experiments(): ExperimentAPI {
    this.assertReady()
    return this.experimentStore
  }
  private assertReady(): void {
    if (!this.ready || this.closing) throw new Error('Execution engine is not active')
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  private event(row: Pick<Row, 'id' | 'project_id'> | null, type: string, data: Json): void {
    this.db
      .prepare('INSERT INTO events(operation_id,project_id,type,data_json,at) VALUES(?,?,?,?,?)')
      .run(row?.id ?? null, row?.project_id ?? null, type, canonicalJson(data), new Date().toISOString())
  }
  /** Trusted adapters issue fresh contexts only after validating their actual caller instance. */
  issueContext(projectId: string, actorId: string, allowedProviders: readonly string[]): OperationContext {
    this.assertReady()
    if (!this.db.prepare('SELECT id FROM projects WHERE id=?').get(projectId))
      throw new Error('Unknown project')
    if (!actorId || allowedProviders.some((id) => !this.providers.has(id)))
      throw new Error('Invalid actor or provider scope')
    const context = Object.freeze({
      projectId,
      actorId,
      allowedProviders: Object.freeze([...allowedProviders]),
    })
    this.contexts.add(context)
    return context
  }
  /** Revocation denies subsequent calls; an already registered operation remains managed. */
  revokeContext(context: OperationContext): void {
    this.contexts.delete(context)
  }
  private authorize(context: OperationContext, providerId?: string): void {
    this.assertReady()
    if (!this.contexts.has(context)) throw new Error('Invalid or expired execution context')
    if (providerId && !context.allowedProviders.includes(providerId))
      throw new Error('Provider capability not authorized')
  }
  /** Creates a project or verifies the existing immutable budget limit. */
  createProject(id: string, budgetLimit: number): void {
    this.assertReady()
    if (!id || !Number.isFinite(budgetLimit) || budgetLimit < 0) throw new Error('Invalid project or budget')
    this.transaction(() => {
      const prior = this.db.prepare('SELECT budget_limit FROM projects WHERE id=?').get(id) as
        | { budget_limit: number }
        | undefined
      if (prior) {
        if (prior.budget_limit !== budgetLimit) throw new Error('Existing project budget differs')
        return
      }
      this.db.prepare('INSERT INTO projects(id,budget_limit) VALUES(?,?)').run(id, budgetLimit)
      this.event({ id: '', project_id: id }, 'project-created', { budgetLimit })
    })
  }
  /** Trusted management inventory; model-facing adapters must expose only their scoped project. */
  projects(): { id: string; budgetLimit: number; budgetUsed: number }[] {
    this.assertReady()
    return (
      this.db.prepare('SELECT * FROM projects ORDER BY id').all() as unknown as {
        id: string
        budget_limit: number
        budget_used: number
      }[]
    ).map((x) => ({ id: x.id, budgetLimit: x.budget_limit, budgetUsed: x.budget_used }))
  }
  private row(id: string): Row {
    const row = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as unknown as Row | undefined
    if (!row) throw new Error('Unknown operation')
    return row
  }
  private scoped(context: OperationContext, id: string): Row {
    this.authorize(context)
    const row = this.row(id)
    if (row.project_id !== context.projectId) throw new Error('Operation belongs to another project')
    this.authorize(context, row.provider_id)
    return row
  }
  private unfinished(): Row[] {
    return this.db
      .prepare(
        "SELECT * FROM operations WHERE state NOT IN ('succeeded','failed','cancelled') ORDER BY created_at",
      )
      .all() as unknown as Row[]
  }
  private record(row: Row): OperationRecord {
    const artifacts = (
      this.db.prepare('SELECT * FROM artifacts WHERE operation_id=? ORDER BY id').all(row.id) as unknown as {
        id: string
        operation_id: string
        path: string
        sha256: string
        bytes: number
        media_type: string
      }[]
    ).map((a) => ({
      id: a.id,
      operationId: a.operation_id,
      path: a.path,
      sha256: a.sha256,
      bytes: a.bytes,
      mediaType: a.media_type,
    }))
    return {
      id: row.id,
      runId: row.id,
      projectId: row.project_id,
      actorId: row.actor_id,
      providerId: row.provider_id,
      providerVersion: row.provider_version,
      requestKey: row.request_key,
      input: JSON.parse(row.input_json),
      resources: JSON.parse(row.resources_json),
      budget: row.budget,
      state: row.state,
      cancelRequested: Boolean(row.cancel_requested),
      progress: row.progress_json ? JSON.parse(row.progress_json) : null,
      detail: row.detail,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      artifacts,
    }
  }
  private operation(row: Row): ProviderOperation {
    const artifactDirectory = resolve(this.directory, 'artifacts', row.id)
    mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 })
    return {
      operationId: row.id,
      projectId: row.project_id,
      input: JSON.parse(row.input_json),
      artifactDirectory,
    }
  }
  private async providerCall<T>(operationId: string, call: () => Promise<T>): Promise<T> {
    if (this.activeProviderOperations.has(operationId))
      throw new Error('Prior provider call is still unresolved; operation remains blocked')
    this.activeProviderOperations.add(operationId)
    const actual = Promise.resolve().then(call)
    this.providerCalls.add(actual)
    void actual.then(
      () => {
        this.providerCalls.delete(actual)
        this.activeProviderOperations.delete(operationId)
      },
      () => {
        this.providerCalls.delete(actual)
        this.activeProviderOperations.delete(operationId)
      },
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        actual,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Provider call timed out; underlying device action may still continue')),
            this.options.providerCallTimeoutMs,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise)
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    )
    return promise
  }
  private serialized<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.operationLocks.get(id) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(fn)
    this.operationLocks.set(id, result)
    void result
      .finally(() => {
        if (this.operationLocks.get(id) === result) this.operationLocks.delete(id)
      })
      .catch(() => {})
    return this.track(result)
  }
  /** Resource reservation, budget charge and registration commit together before any provider action. */
  submit(context: OperationContext, request: SubmitOperation): Promise<OperationRecord> {
    return this.submitBound(context, request)
  }
  private submitBound(
    context: OperationContext,
    request: SubmitOperation,
    binding?: ExperimentBinding,
  ): Promise<OperationRecord> {
    this.authorize(context, request.providerId)
    if (!request.requestKey) throw new Error('Request key must be nonempty')
    const provider = this.providers.get(request.providerId)!
    const requestJson = canonicalJson({ providerId: request.providerId, input: request.input })
    const existing = this.db
      .prepare('SELECT * FROM operations WHERE project_id=? AND request_key=?')
      .get(context.projectId, request.requestKey) as unknown as Row | undefined
    if (existing) {
      if (existing.request_json !== requestJson) throw new Error('Request key reused with different input')
      if (binding) {
        const linked = this.db
          .prepare('SELECT experiment_id,action_id FROM experiment_steps WHERE operation_id=?')
          .get(existing.id) as { experiment_id: string; action_id: string } | undefined
        if (
          !linked ||
          linked.experiment_id !== binding.experimentId ||
          linked.action_id !== binding.action.actionId
        )
          throw new Error('Request key belongs to another operation scope')
      }
      return Promise.resolve(this.record(existing))
    }
    if (this.blockedProviders.has(request.providerId))
      throw new Error('Provider configuration differs from an unfinished operation; new submissions blocked')
    const prepared = provider.prepare(request.input)
    const inputJson = canonicalJson(prepared.input)
    if (
      !Number.isFinite(prepared.budget) ||
      prepared.budget < 0 ||
      !Array.isArray(prepared.resources) ||
      prepared.resources.some((x) => typeof x !== 'string' || !x) ||
      new Set(prepared.resources).size !== prepared.resources.length
    )
      throw new Error('Invalid provider resource or budget requirements')
    const id = randomUUID(),
      at = new Date().toISOString()
    this.transaction(() => {
      for (const resource of prepared.resources)
        if (this.db.prepare('SELECT operation_id FROM resources WHERE name=?').get(resource))
          throw new Error(`Resource busy: ${resource}`)
      const project = this.db
        .prepare('SELECT budget_limit,budget_used FROM projects WHERE id=?')
        .get(context.projectId) as { budget_limit: number; budget_used: number }
      if (project.budget_used + prepared.budget > project.budget_limit)
        throw new Error('Project budget exceeded')
      this.db
        .prepare(
          'INSERT INTO operations(id,project_id,actor_id,provider_id,provider_version,provider_fingerprint,request_key,request_json,input_json,resources_json,budget,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          context.projectId,
          context.actorId,
          request.providerId,
          provider.describe().version,
          canonicalJson(provider.describe() as unknown as Json),
          request.requestKey,
          requestJson,
          inputJson,
          canonicalJson(prepared.resources),
          prepared.budget,
          'registered',
          at,
          at,
        )
      if (binding) this.experimentStore.register(context, binding, prepared.budget, id)
      for (const resource of prepared.resources)
        this.db.prepare('INSERT INTO resources(name,operation_id) VALUES(?,?)').run(resource, id)
      this.db
        .prepare('UPDATE projects SET budget_used=budget_used+? WHERE id=?')
        .run(prepared.budget, context.projectId)
      this.event({ id, project_id: context.projectId }, 'registered', {
        resources: prepared.resources,
        budget: prepared.budget,
        actorId: context.actorId,
      })
    })
    return this.serialized(id, async () => {
      const row = this.row(id)
      this.transaction(() => {
        this.db
          .prepare("UPDATE operations SET state='dispatching',updated_at=? WHERE id=?")
          .run(new Date().toISOString(), id)
        this.event(row, 'dispatch-intent', {})
      })
      try {
        this.observe(
          row,
          await this.providerCall(row.id, () => provider.submit(this.operation(row))),
          'submit',
        )
      } catch (error) {
        this.observe(
          row,
          { state: 'unknown', detail: `Submit outcome uncertain: ${String(error)}` },
          'submit-error',
        )
      }
      return this.record(this.row(id))
    })
  }
  private observe(row: Row, observation: ProviderObservation, source: string): void {
    if (
      !['accepted', 'running', 'succeeded', 'failed', 'cancelled', 'unknown', 'not_found'].includes(
        observation.state,
      )
    )
      throw new Error('Invalid provider observation state')
    const artifacts: ResultArtifact[] = []
    if (observation.artifacts?.length) {
      const base = realpathSync(this.operation(row).artifactDirectory)
      for (const artifact of observation.artifacts) {
        const path = realpathSync(resolve(base, artifact.path))
        const rel = relative(base, path)
        if (rel.startsWith('..') || isAbsolute(rel) || !statSync(path).isFile())
          throw new Error('Provider artifact escapes operation directory')
        const bytes = readFileSync(path)
        const published = {
          id: createHash('sha256').update(`${row.id}/${rel}`).digest('hex'),
          operationId: row.id,
          path: relative(realpathSync(this.directory), path),
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.length,
          mediaType: artifact.mediaType,
        }
        const prior = this.db
          .prepare('SELECT sha256,bytes,media_type FROM artifacts WHERE id=?')
          .get(published.id) as { sha256: string; bytes: number; media_type: string } | undefined
        if (
          prior &&
          (prior.sha256 !== published.sha256 ||
            prior.bytes !== published.bytes ||
            prior.media_type !== published.mediaType)
        )
          throw new Error('Provider changed an already published immutable artifact')
        artifacts.push(published)
      }
    }
    const state = observation.state === 'not_found' ? 'unknown' : observation.state
    const detail =
      observation.state === 'not_found'
        ? 'Provider reports not_found after durable registration; no automatic replay, resources remain held'
        : (observation.detail ?? null)
    const progressJson = observation.progress === undefined ? null : canonicalJson(observation.progress)
    const priorArtifacts = this.record(row).artifacts
    this.transaction(() => {
      this.db
        .prepare('UPDATE operations SET state=?,progress_json=?,detail=?,updated_at=? WHERE id=?')
        .run(state, progressJson, detail, new Date().toISOString(), row.id)
      for (const a of artifacts)
        this.db
          .prepare(
            'INSERT OR IGNORE INTO artifacts(id,operation_id,path,sha256,bytes,media_type) VALUES(?,?,?,?,?,?)',
          )
          .run(a.id, a.operationId, a.path, a.sha256, a.bytes, a.mediaType)
      if (TERMINAL.has(state)) this.db.prepare('DELETE FROM resources WHERE operation_id=?').run(row.id)
      this.event(row, source, { state, detail, artifacts: artifacts.map((a) => a.id) })
      if (
        row.state !== state ||
        row.progress_json !== progressJson ||
        row.detail !== detail ||
        artifacts.some((a) => !priorArtifacts.some((p) => p.id === a.id))
      )
        this.experimentStore.observed(row.id, { state, detail, progress: observation.progress ?? null })
    })
  }
  private async refresh(row: Row, source: string): Promise<void> {
    if (TERMINAL.has(row.state)) return
    const provider = this.providers.get(row.provider_id)
    if (!provider || canonicalJson(provider.describe() as unknown as Json) !== row.provider_fingerprint) {
      this.blockedProviders.add(row.provider_id)
      this.observe(
        row,
        {
          state: 'unknown',
          detail:
            'Required provider version or configuration unavailable; resource retained and provider submissions blocked',
        },
        source,
      )
      return
    }
    try {
      this.observe(row, await this.providerCall(row.id, () => provider.query(this.operation(row))), source)
    } catch (error) {
      this.observe(row, { state: 'unknown', detail: `Query outcome uncertain: ${String(error)}` }, source)
    }
  }
  /** Queries the provider once; terminal operations are read without executing or querying them again. */
  query(context: OperationContext, id: string): Promise<OperationRecord> {
    this.scoped(context, id)
    return this.serialized(id, async () => {
      const row = this.scoped(context, id)
      await this.refresh(row, 'query')
      return this.record(this.row(id))
    })
  }
  /** Reads persisted facts only. */
  get(context: OperationContext, id: string): OperationRecord {
    return this.record(this.scoped(context, id))
  }
  /** Lists only operations in this project and its explicitly allowed provider scope. */
  list(context: OperationContext): OperationRecord[] {
    this.authorize(context)
    return (
      this.db
        .prepare('SELECT * FROM operations WHERE project_id=? ORDER BY created_at')
        .all(context.projectId) as unknown as Row[]
    )
      .filter((r) => context.allowedProviders.includes(r.provider_id))
      .map((r) => this.record(r))
  }
  /** Public capability descriptions, restricted to the current context's registered Providers. */
  descriptions(context: OperationContext) {
    this.authorize(context)
    return context.allowedProviders.map((id) => this.providers.get(id)!.describe())
  }
  /** Reconciles scoped unfinished records; never implicitly submits an uncertain operation. */
  async reconcile(context: OperationContext): Promise<OperationRecord[]> {
    this.authorize(context)
    for (const row of this.list(context)) if (!TERMINAL.has(row.state)) await this.query(context, row.id)
    return this.list(context)
  }
  /** Records request before invoking provider; cancellation refusal never releases resources. */
  cancel(context: OperationContext, id: string): Promise<OperationRecord> {
    this.scoped(context, id)
    return this.serialized(id, async () => {
      const row = this.scoped(context, id)
      if (TERMINAL.has(row.state)) return this.record(row)
      this.transaction(() => {
        this.db.prepare('UPDATE operations SET cancel_requested=1 WHERE id=?').run(id)
        this.event(row, 'cancel-requested', { actorId: context.actorId })
      })
      const provider = this.providers.get(row.provider_id)
      if (!provider || canonicalJson(provider.describe() as unknown as Json) !== row.provider_fingerprint) {
        this.observe(
          row,
          { state: 'unknown', detail: 'Cancellation unavailable: provider version missing' },
          'cancel',
        )
        return this.record(this.row(id))
      }
      try {
        const response = await this.providerCall(row.id, () => provider.cancel(this.operation(row)))
        this.event(row, 'cancel-response', {
          disposition: response.disposition,
          detail: response.detail ?? null,
        })
        if (response.observation) this.observe(row, response.observation, 'cancel-observation')
        else
          this.db
            .prepare('UPDATE operations SET detail=? WHERE id=?')
            .run(`Cancellation ${response.disposition}: ${response.detail ?? ''}`, id)
      } catch (error) {
        this.observe(
          row,
          { state: 'unknown', detail: `Cancellation outcome uncertain: ${String(error)}` },
          'cancel-error',
        )
      }
      return this.record(this.row(id))
    })
  }
  /** Program-owned provider polling; timeout or caller abort does not claim equipment cancellation. */
  wait(
    context: OperationContext,
    id: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<OperationRecord> {
    this.scoped(context, id)
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.managementAbort.signal])
      : this.managementAbort.signal
    return this.track(this.waitLoop(context, id, { ...options, signal }))
  }
  private async waitLoop(
    context: OperationContext,
    id: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<OperationRecord> {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) throw new Error('Invalid timeout')
    const deadline = Date.now() + options.timeoutMs
    while (true) {
      options.signal?.throwIfAborted()
      const operation = await this.query(context, id)
      if (TERMINAL.has(operation.state) || operation.state === 'unknown') return operation
      if (Date.now() >= deadline) throw new Error('Operation wait timed out; equipment state unchanged')
      await delay(Math.min(this.options.pollIntervalMs, Math.max(1, deadline - Date.now())), undefined, {
        signal: options.signal,
      })
    }
  }
  /** Exports a verified artifact by identity; refuses altered or missing original bytes. */
  exportArtifact(context: OperationContext, artifactId: string, destination: string): ResultArtifact {
    this.authorize(context)
    const match = this.db.prepare('SELECT operation_id FROM artifacts WHERE id=?').get(artifactId) as
      | { operation_id: string }
      | undefined
    if (!match) throw new Error('Unknown artifact')
    const artifact = this.get(context, match.operation_id).artifacts.find((a) => a.id === artifactId)!
    const base = realpathSync(this.directory),
      path = realpathSync(resolve(base, artifact.path)),
      rel = relative(base, path)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Artifact escapes execution domain')
    const bytes = readFileSync(path)
    if (
      bytes.length !== artifact.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
    )
      throw new Error('Artifact integrity check failed')
    mkdirSync(dirname(resolve(destination)), { recursive: true })
    writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 })
    return artifact
  }
  /** Appends project/task facts; these records never restore process-local authorization. */
  recordFact(context: OperationContext, kind: string, data: Json): void {
    this.authorize(context)
    if (!kind) throw new Error('Fact kind must be nonempty')
    this.event({ id: '', project_id: context.projectId }, 'fact', { actorId: context.actorId, kind, data })
  }
  /** Reads durable project/task facts for a currently authorized project participant. */
  readFacts(context: OperationContext): { actorId: string; kind: string; data: Json }[] {
    this.authorize(context)
    return (
      this.db
        .prepare("SELECT data_json FROM events WHERE project_id=? AND type='fact' ORDER BY seq")
        .all(context.projectId) as { data_json: string }[]
    ).map((row) => JSON.parse(row.data_json))
  }
  /** Durable event audit restricted to the same project and allowed operation capabilities. */
  events(context: OperationContext): unknown[] {
    this.authorize(context)
    const ids = new Set(this.list(context).map((r) => r.id))
    return (
      this.db.prepare('SELECT * FROM events WHERE project_id=? ORDER BY seq').all(context.projectId) as {
        operation_id: string
      }[]
    ).filter((e) => !e.operation_id || ids.has(e.operation_id))
  }
  /** Stops management after actual in-flight calls settle; a hung provider requires external process termination. It never cancels equipment or frees persistent resources. */
  async close(): Promise<void> {
    if (!this.ready || this.closing) return
    this.closing = true
    this.managementAbort.abort(new Error('Execution management stopped; equipment state unchanged'))
    await Promise.allSettled([...this.pending])
    await Promise.allSettled([...this.providerCalls])
    this.ready = false
    this.db.close()
    this.lock.exec('ROLLBACK')
    this.lock.close()
  }
}
