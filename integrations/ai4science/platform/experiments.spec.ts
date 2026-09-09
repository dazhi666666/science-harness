/** Experiment admission, recovery and cancellation are checked against real Provider journals and files. */
import { it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { canonicalJson } from './sdk.ts'
import { ExecutionEngine } from './execution.ts'
import { createProvider } from './providers/instrument.ts'
import { Artifacts } from './artifacts.ts'
import { samplingRequest, assessSampling, finishSampling } from './scenes/sampling.ts'
import type { ExecutionProvider, ProviderOperation, ProviderObservation, ExperimentRequest } from './index.ts'

const engines: ExecutionEngine[] = [],
  roots: string[] = []
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close()
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true })
})
async function world(options?: { budget?: number; provider?: ExecutionProvider; directory?: string }) {
  const root = options?.directory ?? mkdtempSync(join(tmpdir(), 'experiment-v02-'))
  if (!options?.directory) roots.push(root)
  const provider =
    options?.provider ??
    createProvider({
      id: 'instrument',
      directory: join(root, 'device'),
      resource: 'shared-instrument',
      tickMs: 1,
      reference: 10,
      slope: 0.27,
      drift: 0.012,
      noise: 0.18,
      seed: 7,
    })
  const e = new ExecutionEngine({
    directory: join(root, 'execution'),
    providers: [provider],
    pollIntervalMs: 5,
    providerCallTimeoutMs: 1000,
  })
  engines.push(e)
  await e.open()
  e.createProject('p', options?.budget ?? 100)
  const c = e.issueContext('p', 'controller', [provider.describe().id])
  return { root, e, c, provider }
}
const decision = (
  actionId: string,
  requestKey = actionId,
  evidenceOperationIds: string[] = [],
  evidenceArtifactIds: string[] = [],
) => ({
  actionId,
  requestKey,
  rationale: 'Decision based on actual recorded execution feedback.',
  evidenceOperationIds,
  evidenceArtifactIds,
})
function journal(path: string) {
  const db = new DatabaseSync(path)
  try {
    return db.prepare('SELECT COUNT(*) n FROM starts').get()?.n
  } finally {
    db.close()
  }
}

it('records a bounded initial acquisition, checks data, chooses an evidenced supplement and closes a sourced report', async () => {
  const { root, e, c } = await world()
  expect(
    JSON.parse(readFileSync(new URL('./examples/sampling.request.json', import.meta.url), 'utf8')),
  ).toEqual(samplingRequest('instrument'))
  const x = e.experiments.create(c, 'one', samplingRequest('instrument'))
  const first = await e.experiments.submit(c, x.id, decision('measure'))
  const feedback = await e.experiments.wait(c, x.id, { after: 0, until: 'decision', timeoutMs: 1000 })
  expect(feedback.reason).toBe('decision')
  expect(feedback.experiment.state).toBe('awaiting_decision')
  const quality = assessSampling(e, c, x.id)
  expect(quality.status).toBe('insufficient')
  expect(quality.observed).toBe(4)
  expect(() => e.experiments.submit(c, x.id, decision('supplement'))).toThrow('evidence')
  expect(e.experiments.get(c, x.id).operations).toHaveLength(1)
  expect(e.projects()[0]?.budgetUsed).toBe(4)
  const extra = await e.experiments.submit(
    c,
    x.id,
    decision('supplement', 'additional', [], [quality.artifactId]),
  )
  expect(extra.id).not.toBe(first.id)
  await e.experiments.wait(c, x.id, { after: 0, until: 'decision', timeoutMs: 1000 })
  const finished = finishSampling(e, c, x.id)
  expect(finished.state).toBe('completed')
  expect(finished.budgetUsed).toBe(6)
  expect(finished.scientificConclusion).toBe('not-evaluated-by-platform')
  expect(finished.decisions[1]).toMatchObject({
    evidenceArtifactIds: [quality.artifactId],
    actorId: 'controller',
  })
  expect(journal(join(root, 'device/instrument.sqlite'))).toBe(2)
  expect(e.experiments.create(c, 'one', samplingRequest('instrument')).id).toBe(x.id)
  expect(
    (await e.experiments.submit(c, x.id, decision('supplement', 'additional', [], [quality.artifactId]))).id,
  ).toBe(extra.id)
  expect(() =>
    e.experiments.submit(c, x.id, decision('supplement', 'new-key', [], [quality.artifactId])),
  ).toThrow('closed')
  expect(e.experiments.get(c, x.id).operations).toHaveLength(2)
})

it('persists experiment facts and task identity across reopen without restoring a controller or replaying accepted work', async () => {
  const { root, e, c } = await world()
  const spec = samplingRequest('instrument')
  const x = e.experiments.create(c, 'persist', spec)
  const op = await e.experiments.submit(c, x.id, decision('measure'))
  await e.close()
  const next = await world({ directory: root })
  const recovered = next.e.experiments.get(next.c, x.id)
  expect(recovered.controllerActive).toBe(false)
  expect(recovered.operations[0]?.id).toBe(op.id)
  expect(() => next.e.experiments.get(c, x.id)).toThrow('context')
  expect(() => next.e.experiments.submit(next.c, x.id, decision('supplement', 'retry', [op.id]))).toThrow(
    'claim',
  )
  next.e.experiments.claim(next.c, x.id, 'New authorized execution owner after process restart')
  await next.e.experiments.wait(next.c, x.id, { after: 0, until: 'decision', timeoutMs: 1000 })
  expect((await next.e.experiments.submit(next.c, x.id, decision('measure'))).id).toBe(op.id)
  expect(journal(join(root, 'device/instrument.sqlite'))).toBe(1)
  expect(next.e.experiments.get(next.c, x.id).request.goal).toBe(spec.goal)
})

it('enforces project, capability and live-controller boundaries, including replacement with the same actor ID', async () => {
  const { e, c } = await world()
  const x = e.experiments.create(c, 'auth', samplingRequest('instrument'))
  e.createProject('other', 100)
  const foreign = e.issueContext('other', 'controller', ['instrument'])
  expect(() => e.experiments.get(foreign, x.id)).toThrow('project')
  const denied = e.issueContext('p', 'controller', [])
  expect(() => e.experiments.get(denied, x.id)).toThrow('authorized')
  const replacement = e.issueContext('p', 'controller', ['instrument'])
  expect(() => e.experiments.claim(replacement, x.id, 'same textual ID')).toThrow('live')
  expect(() => e.experiments.finish(replacement, x.id, 'not owner', [], [])).toThrow('controller')
  e.revokeContext(c)
  expect(() => e.experiments.submit(replacement, x.id, decision('measure'))).toThrow('context')
  e.experiments.claim(replacement, x.id, 'Explicit replacement after old instance expired')
  expect(e.experiments.get(replacement, x.id).controllerActive).toBe(true)
})

it('resource conflicts, project budget and experiment limits roll back both operation and decision registration', async () => {
  const { e, c } = await world({ budget: 5 })
  const spec = samplingRequest('instrument'),
    x = e.experiments.create(c, 'limits', spec),
    other = e.experiments.create(c, 'other', spec)
  const first = await e.experiments.submit(c, x.id, decision('measure'))
  expect(() => e.experiments.submit(c, other.id, decision('measure'))).toThrow('busy')
  expect(e.experiments.get(c, other.id).operations).toEqual([])
  expect(e.experiments.get(c, other.id).budgetUsed).toBe(0)
  await e.experiments.wait(c, x.id, { after: 0, until: 'decision', timeoutMs: 1000 })
  expect(() => e.experiments.submit(c, x.id, decision('supplement', 'budget', [first.id]))).toThrow(
    'Project budget',
  )
  expect(e.experiments.get(c, x.id).operations).toHaveLength(1)
  expect(e.experiments.get(c, x.id).budgetUsed).toBe(4)
  expect(e.experiments.get(c, x.id).lastIssue).toMatchObject({ reason: expect.stringContaining('budget') })
  expect(() =>
    e.experiments.submit(c, x.id, { ...decision('supplement'), input: { conditions: [] } }),
  ).toThrow()
  expect(() => e.experiments.submit(c, x.id, decision('unlisted'))).toThrow('approved')
  const narrow = { ...spec, budget: 0 }
  const z = e.experiments.create(c, 'zero', narrow)
  expect(() => e.experiments.submit(c, z.id, decision('supplement', 'none', [first.id]))).toThrow(
    'Project budget',
  )
  expect(e.list(c)).toHaveLength(1)
})

it('experiment budget and per-action limits hold even with spare project budget', async () => {
  const { e, c } = await world()
  const spec = { ...samplingRequest('instrument'), budget: 4 }
  const x = e.experiments.create(c, 'small', spec)
  const op = await e.experiments.submit(c, x.id, decision('measure'))
  await e.experiments.wait(c, x.id, { after: 0, until: 'decision', timeoutMs: 1000 })
  expect(() => e.experiments.submit(c, x.id, decision('supplement', 'over', [op.id]))).toThrow(
    'Experiment budget',
  )
  expect(() => e.experiments.submit(c, x.id, decision('measure', 'again'))).toThrow('limit')
  expect(e.projects()[0]?.budgetUsed).toBe(4)
})

it('escalation stops new actions, only the live controller can resolve, and resolution never changes the approved inputs', async () => {
  const { e, c } = await world()
  const x = e.experiments.create(c, 'review', samplingRequest('instrument'))
  const worker = e.issueContext('p', 'worker', ['instrument'])
  expect(e.experiments.escalate(worker, x.id, 'Need an out-of-plan condition', { value: 2 }).state).toBe(
    'needs_review',
  )
  expect(() => e.experiments.submit(worker, x.id, decision('measure'))).toThrow('review')
  expect(() => e.experiments.resolve(worker, x.id, 'self approval')).toThrow('controller')
  e.experiments.resolve(c, x.id, 'Use the original conditions; proposal rejected')
  const op = await e.experiments.submit(worker, x.id, decision('measure'))
  expect(op.input).toEqual({
    conditions: [
      { value: -1, samples: 2 },
      { value: 1, samples: 2 },
    ],
  })
  expect(op.actorId).toBe('worker')
  await e.experiments.cancel(c, x.id)
  await e.experiments.wait(c, x.id, { after: 0, until: 'decision', timeoutMs: 1000 })
})

function controlled(id = 'job') {
  const states = new Map<string, ProviderObservation>()
  let starts = 0,
    queries = 0
  const p: ExecutionProvider = {
    describe: () => ({
      apiVersion: 1,
      id,
      version: '1',
      configuration: {},
      inputSchema: {},
      outputSchema: {},
      units: { budget: 'unit' },
      constraints: [],
      completion: 'explicit test backend terminal observation',
      cancellation: 'can refuse',
    }),
    prepare: (input) => ({ input, resources: [id + '-resource'], budget: 1 }),
    async submit(op: ProviderOperation) {
      starts++
      states.set(op.operationId, { state: 'running', progress: { count: 0 } })
      return states.get(op.operationId)!
    },
    async query(op) {
      queries++
      return states.get(op.operationId) ?? { state: 'not_found' }
    },
    async cancel() {
      return { disposition: 'unsupported' }
    },
  }
  return {
    p,
    states,
    get starts() {
      return starts
    },
    get queries() {
      return queries
    },
  }
}
const jobSpec: ExperimentRequest = {
  goal: 'Bounded job control',
  method: { id: 'control-test', version: '1' },
  context: {},
  inputArtifactIds: [],
  outputRequirements: 'Observed result',
  budget: 10,
  maxOperations: 3,
  actions: [{ id: 'run', providerId: 'job', input: {}, minUses: 0, maxUses: 3, requiresEvidence: false }],
}

it('program feedback distinguishes progress, unchanged polling and timeout; none implies cancellation', async () => {
  const backend = controlled()
  const { e, c } = await world({ provider: backend.p })
  const x = e.experiments.create(c, 'feedback', jobSpec)
  const op = await e.experiments.submit(c, x.id, decision('run'))
  const cursor = e.experiments.get(c, x.id).cursor
  const timeout = await e.experiments.wait(c, x.id, { after: cursor, until: 'change', timeoutMs: 20 })
  expect(timeout.reason).toBe('timeout')
  expect(timeout.experiment.operations[0]?.cancelRequested).toBe(false)
  backend.states.set(op.id, { state: 'running', progress: { count: 1 } })
  const changed = await e.experiments.wait(c, x.id, {
    after: timeout.experiment.cursor,
    until: 'change',
    timeoutMs: 100,
  })
  expect(changed.reason).toBe('change')
  expect(changed.experiment.operations[0]?.progress).toEqual({ count: 1 })
  backend.states.set(op.id, { state: 'succeeded', progress: { count: 2 } })
  expect(
    (
      await e.experiments.wait(c, x.id, {
        after: changed.experiment.cursor,
        until: 'decision',
        timeoutMs: 100,
      })
    ).experiment.state,
  ).toBe('awaiting_decision')
  expect(backend.starts).toBe(1)
})

it('unsupported cancellation and unknown work cannot become a cancelled experiment or admit another action', async () => {
  const backend = controlled()
  const { e, c } = await world({ provider: backend.p })
  const x = e.experiments.create(c, 'cancel', jobSpec),
    op = await e.experiments.submit(c, x.id, decision('run'))
  expect((await e.experiments.cancel(c, x.id)).state).toBe('cancelling')
  expect(() => e.experiments.submit(c, x.id, decision('run', 'new'))).toThrow('cancelling')
  backend.states.set(op.id, { state: 'unknown', detail: 'lost backend' })
  expect(
    (await e.experiments.wait(c, x.id, { after: 0, until: 'decision', timeoutMs: 100 })).experiment.state,
  ).toBe('blocked')
  expect(e.experiments.get(c, x.id).budgetUsed).toBe(1)
  expect(e.get(c, op.id).cancelRequested).toBe(true)
  backend.states.set(op.id, { state: 'cancelled', progress: { count: 1 } })
  await e.query(c, op.id)
  expect(e.experiments.get(c, x.id).state).toBe('cancelled')
  expect(e.get(c, op.id).state).toBe('cancelled')
})

it('wait abort and engine close stop observation without stopping the accepted backend job', async () => {
  const backend = controlled()
  const { e, c } = await world({ provider: backend.p })
  const x = e.experiments.create(c, 'close', jobSpec),
    op = await e.experiments.submit(c, x.id, decision('run'))
  const abort = new AbortController()
  const waiting = e.experiments.wait(c, x.id, {
    after: e.experiments.get(c, x.id).cursor,
    until: 'change',
    timeoutMs: 1000,
    signal: abort.signal,
  })
  abort.abort()
  await expect(waiting).rejects.toThrow()
  const another = e.experiments.wait(c, x.id, { after: 0, until: 'decision', timeoutMs: 1000 })
  const rejected = expect(another).rejects.toThrow()
  await e.close()
  await rejected
  expect(backend.states.get(op.id)?.state).toBe('running')
})

it('upgrades a v1 transaction store without changing existing project or operation facts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'experiment-schema1-'))
  roots.push(root)
  const directory = join(root, 'execution')
  mkdirSync(directory)
  const db = new DatabaseSync(join(directory, 'execution.sqlite'))
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,budget_limit REAL NOT NULL,budget_used REAL NOT NULL DEFAULT 0);INSERT INTO projects VALUES('p',100,7);
 CREATE TABLE operations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,actor_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_version TEXT NOT NULL,provider_fingerprint TEXT NOT NULL,request_key TEXT NOT NULL,request_json TEXT NOT NULL,input_json TEXT NOT NULL,resources_json TEXT NOT NULL,budget REAL NOT NULL,state TEXT NOT NULL,cancel_requested INTEGER NOT NULL DEFAULT 0,progress_json TEXT,detail TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,request_key));
 CREATE TABLE artifacts(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,media_type TEXT NOT NULL);PRAGMA user_version=1`)
  const legacyInput = { conditions: [{ value: 0, samples: 7 }] }
  db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'legacy',
    'p',
    'old-actor',
    'instrument',
    '0.1.0',
    '{}',
    'old',
    canonicalJson({ input: legacyInput, providerId: 'instrument' }),
    JSON.stringify(legacyInput),
    '["shared-instrument"]',
    7,
    'succeeded',
    0,
    null,
    null,
    'old',
    'old',
  )
  const bytes = Buffer.from('legacy raw data')
  mkdirSync(join(directory, 'artifacts/legacy'), { recursive: true })
  writeFileSync(join(directory, 'artifacts/legacy/raw.txt'), bytes)
  db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,?)').run(
    'legacy-artifact',
    'legacy',
    'artifacts/legacy/raw.txt',
    createHash('sha256').update(bytes).digest('hex'),
    bytes.length,
    'text/plain',
  )
  db.close()
  const { e, c } = await world({ directory: root })
  expect(e.projects()[0]?.budgetUsed).toBe(7)
  expect(e.experiments.list(c)).toEqual([])
  expect(e.get(c, 'legacy').actorId).toBe('old-actor')
  expect((await e.submit(c, { providerId: 'instrument', requestKey: 'old', input: legacyInput })).id).toBe(
    'legacy',
  )
  expect(new Artifacts(e).read(c, 'legacy-artifact').content).toBe('legacy raw data')
  expect(existsSync(join(root, 'device/instrument.sqlite'))).toBe(false)
  expect(readFileSync(join(directory, 'artifacts/legacy/raw.txt'))).toEqual(bytes)
  const x = e.experiments.create(c, 'new', samplingRequest('instrument'))
  expect(x.createdBy).toBe('controller')
  await e.close()
  const inspect = new DatabaseSync(join(directory, 'execution.sqlite'))
  expect(inspect.prepare('PRAGMA user_version').get()?.user_version).toBe(2)
  expect(inspect.prepare('SELECT budget_used FROM projects').get()?.budget_used).toBe(7)
  inspect.close()
})

it('rejects unrelated experiment evidence and corrupted artifacts without spending another reservation', async () => {
  const { e, c } = await world()
  const a = e.experiments.create(c, 'a', samplingRequest('instrument')),
    b = e.experiments.create(c, 'b', samplingRequest('instrument'))
  const op = await e.experiments.submit(c, a.id, decision('measure'))
  await e.experiments.wait(c, a.id, { after: 0, until: 'decision', timeoutMs: 1000 })
  const artifact = e.get(c, op.id).artifacts[0]!
  expect(() =>
    e.experiments.submit(c, b.id, decision('supplement', 'foreign', [op.id], [artifact.id])),
  ).toThrow('this experiment')
  expect(e.experiments.get(c, b.id).operations).toEqual([])
  writeFileSync(join(e.directory, artifact.path), 'corrupt')
  expect(() => e.experiments.submit(c, a.id, decision('supplement', 'corrupt', [], [artifact.id]))).toThrow(
    'integrity',
  )
  expect(e.projects()[0]?.budgetUsed).toBe(4)
})

it('aggregate cancellation waits for every accepted operation and preserves one job succeeding during cancellation', async () => {
  const a = controlled('a'),
    b = controlled('b')
  a.p.cancel = async (op) => {
    a.states.set(op.operationId, { state: 'cancelled', progress: { partial: 1 } })
    return { disposition: 'requested', observation: a.states.get(op.operationId)! }
  }
  const root = mkdtempSync(join(tmpdir(), 'experiment-cancel-all-'))
  roots.push(root)
  const e = new ExecutionEngine({
    directory: root,
    providers: [a.p, b.p],
    pollIntervalMs: 5,
    providerCallTimeoutMs: 1000,
  })
  engines.push(e)
  await e.open()
  e.createProject('p', 10)
  const c = e.issueContext('p', 'controller', ['a', 'b'])
  const spec = {
    ...jobSpec,
    actions: [
      { id: 'a', providerId: 'a', input: {}, minUses: 0, maxUses: 1, requiresEvidence: false },
      { id: 'b', providerId: 'b', input: {}, minUses: 0, maxUses: 1, requiresEvidence: false },
    ],
  }
  const x = e.experiments.create(c, 'both', spec)
  const [one, two] = await Promise.all([
    e.experiments.submit(c, x.id, decision('a')),
    e.experiments.submit(c, x.id, decision('b')),
  ])
  const cancelling = await e.experiments.cancel(c, x.id)
  expect(cancelling.state).toBe('cancelling')
  expect(e.get(c, one.id).state).toBe('cancelled')
  expect(e.get(c, two.id).state).toBe('running')
  b.states.set(two.id, { state: 'succeeded' })
  await e.query(c, two.id)
  const done = e.experiments.get(c, x.id)
  expect(done.state).toBe('cancelled')
  expect(done.operations.map((o) => o.state)).toEqual(['cancelled', 'succeeded'])
  expect(done.budgetUsed).toBe(2)
})

it('unknown execution blocks new actions before any cancellation request and never frees its budget', async () => {
  const backend = controlled()
  const { e, c } = await world({ provider: backend.p })
  const x = e.experiments.create(c, 'unknown', jobSpec),
    op = await e.experiments.submit(c, x.id, decision('run'))
  backend.states.set(op.id, { state: 'unknown' })
  await e.query(c, op.id)
  expect(e.experiments.get(c, x.id).state).toBe('blocked')
  expect(() => e.experiments.submit(c, x.id, decision('run', 'another'))).toThrow('Unknown')
  expect(e.experiments.get(c, x.id).budgetUsed).toBe(1)
  expect(backend.starts).toBe(1)
})

it('pins Provider version and configuration across restart, retaining completed work while refusing changed additional work', async () => {
  const backend = controlled()
  const { root, e, c } = await world({ provider: backend.p })
  const x = e.experiments.create(c, 'binding', jobSpec)
  const op = await e.experiments.submit(c, x.id, decision('run'))
  backend.states.set(op.id, { state: 'succeeded' })
  await e.query(c, op.id)
  await e.close()
  const changed = {
    ...backend.p,
    describe: () => ({ ...backend.p.describe(), version: '2', configuration: { device: 'replacement' } }),
  }
  const next = await world({ directory: root, provider: changed })
  const view = next.e.experiments.get(next.c, x.id)
  expect(view.state).toBe('blocked')
  expect(view.providerBindings.job?.version).toBe('1')
  expect(view.operations[0]).toMatchObject({ id: op.id, state: 'succeeded' })
  next.e.experiments.claim(next.c, x.id, 'New authorized instance cannot silently change a binding')
  expect(() => next.e.experiments.submit(next.c, x.id, decision('run', 'additional'))).toThrow(
    'configuration changed',
  )
  expect(backend.starts).toBe(1)
  expect(next.e.projects()[0]?.budgetUsed).toBe(1)
  await next.e.close()
  const restored = await world({ directory: root, provider: backend.p })
  restored.e.experiments.claim(restored.c, x.id, 'Original Provider configuration explicitly restored')
  const extra = await restored.e.experiments.submit(restored.c, x.id, decision('run', 'additional'))
  expect(extra.id).not.toBe(op.id)
  expect(backend.starts).toBe(2)
})
