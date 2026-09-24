import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ExecutionEngine } from './execution.ts'
import type { ExecutionProvider, Json, ProviderOperation, ProviderObservation } from './sdk.ts'

const dirs: string[] = [],
  engines: ExecutionEngine[] = []
function directory() {
  const d = mkdtempSync(join(tmpdir(), 'ai4s-execution-test-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.close()))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** This independent fixture journal counts real starts, not platform dedup decisions. */
class JournalProvider implements ExecutionProvider {
  mode: 'complete' | 'running' | 'lost-reply' | 'not-found' | 'unsupported' | 'rejected' | 'cancel-unknown' =
    'complete'
  settings = 'original'
  constructor(readonly journal: string) {}
  describe() {
    return {
      apiVersion: 1 as const,
      id: 'journal',
      version: '1',
      configuration: { journal: this.journal, settings: this.settings },
      inputSchema: {},
      outputSchema: {},
      units: { budget: 'sample' },
      constraints: ['exclusive test device'],
      completion: 'Result bytes saved',
      cancellation: 'Deferred cancellation may save partial data',
    }
  }
  prepare(input: Json) {
    return { input, resources: ['device/test'], budget: 2 }
  }
  load(): Record<
    string,
    { starts: number; state: ProviderObservation['state']; input: Json; cancellation?: boolean }
  > {
    return existsSync(this.journal) ? JSON.parse(readFileSync(this.journal, 'utf8')) : {}
  }
  async submit(op: ProviderOperation): Promise<ProviderObservation> {
    const data = this.load()
    if (!data[op.operationId]) {
      data[op.operationId] = {
        starts: 1,
        state: this.mode === 'complete' ? 'succeeded' : 'running',
        input: op.input,
      }
      writeFileSync(this.journal, JSON.stringify(data))
    }
    if (this.mode === 'lost-reply') throw new Error('connection lost after independent durable start')
    return this.query(op)
  }
  async query(op: ProviderOperation): Promise<ProviderObservation> {
    if (this.mode === 'not-found') return { state: 'not_found' }
    const data = this.load(),
      entry = data[op.operationId]
    if (!entry) return { state: 'not_found' }
    if (entry.cancellation) {
      entry.state = 'cancelled'
      writeFileSync(this.journal, JSON.stringify(data))
    }
    if (entry.state === 'succeeded' || entry.state === 'cancelled') {
      writeFileSync(
        join(op.artifactDirectory, 'result.json'),
        JSON.stringify({ input: entry.input, partial: entry.state === 'cancelled' }),
      )
      return { state: entry.state, artifacts: [{ path: 'result.json', mediaType: 'application/json' }] }
    }
    return { state: entry.state }
  }
  async cancel(op: ProviderOperation) {
    if (this.mode === 'unsupported' || this.mode === 'rejected')
      return { disposition: this.mode, detail: 'Device keeps running' } as const
    if (this.mode === 'cancel-unknown') throw new Error('lost cancellation response')
    const data = this.load()
    data[op.operationId]!.cancellation = true
    writeFileSync(this.journal, JSON.stringify(data))
    return { disposition: 'requested' as const }
  }
}
async function setup(mode: JournalProvider['mode'] = 'complete', root = directory()) {
  const provider = new JournalProvider(join(root, 'provider-journal.json'))
  provider.mode = mode
  const engine = new ExecutionEngine({
    directory: join(root, 'domain'),
    providers: [provider],
    pollIntervalMs: 2,
    providerCallTimeoutMs: 2000,
  })
  engines.push(engine)
  await engine.open()
  engine.createProject('p', 10)
  return { root, provider, engine, ctx: engine.issueContext('p', 'actor', ['journal']) }
}
const request = (requestKey = 'one', input: Json = { value: 7 }) => ({
  providerId: 'journal',
  requestKey,
  input,
})

describe('durable execution domain', () => {
  it('deduplicates across restart using independent provider starts and verifies saved result bytes', async () => {
    const a = await setup(),
      result = await a.engine.submit(a.ctx, request())
    expect(result.state).toBe('succeeded')
    expect(result.artifacts).toHaveLength(1)
    a.engine.recordFact(a.ctx, 'task', { instruction: 'continue from facts' })
    await a.engine.close()
    const b = await setup('complete', a.root)
    const duplicate = await b.engine.submit(b.ctx, request('one', { value: 7 }))
    expect(duplicate.id).toBe(result.id)
    expect(Object.values(b.provider.load()).map((x) => x.starts)).toEqual([1])
    expect(b.engine.projects()[0]!.budgetUsed).toBe(2)
    expect(b.engine.readFacts(b.ctx)[0]!.kind).toBe('task')
    const destination = join(a.root, 'export.json')
    b.engine.exportArtifact(b.ctx, result.artifacts[0]!.id, destination)
    expect(JSON.parse(readFileSync(destination, 'utf8')).input).toEqual({ value: 7 })
    expect(() => b.engine.get(a.ctx, result.id)).toThrow('expired')
    writeFileSync(join(b.engine.directory, result.artifacts[0]!.path), 'changed')
    expect(() => b.engine.exportArtifact(b.ctx, result.artifacts[0]!.id, join(a.root, 'bad.json'))).toThrow(
      'integrity',
    )
  })
  it('registers resource and budget atomically before concurrent conflicting requests', async () => {
    const a = await setup('running')
    const first = a.engine.submit(a.ctx, request())
    expect(() => a.engine.submit(a.ctx, request('two'))).toThrow('Resource busy')
    await first
    expect(a.engine.list(a.ctx)).toHaveLength(1)
    expect(a.engine.projects()[0]!.budgetUsed).toBe(2)
    expect(Object.values(a.provider.load()).map((x) => x.starts)).toEqual([1])
    expect(() => a.engine.submit(a.ctx, request('one', { value: 8 }))).toThrow('different input')
  })
  it('blocks conflicts across projects and rejects unscoped capabilities and forged context', async () => {
    const a = await setup('running'),
      first = await a.engine.submit(a.ctx, request())
    a.engine.createProject('other', 100)
    const other = a.engine.issueContext('other', 'other', ['journal']),
      empty = a.engine.issueContext('p', 'limited', [])
    expect(() => a.engine.get(other, first.id)).toThrow('another project')
    expect(() => a.engine.submit(other, request())).toThrow('Resource busy')
    expect(() => a.engine.submit(empty, request())).toThrow('not authorized')
    expect(() => a.engine.get({ ...a.ctx }, first.id)).toThrow('expired')
    a.engine.revokeContext(a.ctx)
    expect(() => a.engine.get(a.ctx, first.id)).toThrow('expired')
  })
  it('reconciles a lost submit reply without a second actual start', async () => {
    const a = await setup('lost-reply'),
      result = await a.engine.submit(a.ctx, request())
    expect(result.state).toBe('unknown')
    await a.engine.close()
    const b = await setup('running', a.root)
    expect(b.engine.get(b.ctx, result.id).state).toBe('running')
    expect((await b.engine.submit(b.ctx, request())).id).toBe(result.id)
    expect(Object.values(b.provider.load()).map((x) => x.starts)).toEqual([1])
    expect(() => b.engine.submit(b.ctx, request('conflict'))).toThrow('Resource busy')
  })
  it('keeps unknown and not_found resources and budget reserved after restart', async () => {
    const a = await setup('running'),
      result = await a.engine.submit(a.ctx, request())
    await a.engine.close()
    const b = await setup('not-found', a.root)
    expect(b.engine.get(b.ctx, result.id).state).toBe('unknown')
    expect(b.engine.projects()[0]!.budgetUsed).toBe(2)
    expect(() => b.engine.submit(b.ctx, request('two'))).toThrow('Resource busy')
    expect(Object.values(b.provider.load()).map((x) => x.starts)).toEqual([1])
  })
  it('separates cancellation requested from terminal cancellation and retains partial artifacts', async () => {
    const a = await setup('running'),
      result = await a.engine.submit(a.ctx, request())
    const requested = await a.engine.cancel(a.ctx, result.id)
    expect(requested.cancelRequested).toBe(true)
    expect(requested.state).toBe('running')
    expect(() => a.engine.submit(a.ctx, request('two'))).toThrow('Resource busy')
    await a.engine.close()
    const b = await setup('running', a.root)
    const cancelled = b.engine.get(b.ctx, result.id)
    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.artifacts).toHaveLength(1)
    expect(b.engine.projects()[0]!.budgetUsed).toBe(2)
    expect((await b.engine.submit(b.ctx, request('two'))).state).toBe('running')
  })
  it.each(['unsupported', 'rejected', 'cancel-unknown'] as const)(
    'records %s cancellation without freeing device',
    async (mode) => {
      const a = await setup(mode),
        result = await a.engine.submit(a.ctx, request())
      const cancelled = await a.engine.cancel(a.ctx, result.id)
      expect(cancelled.cancelRequested).toBe(true)
      expect(cancelled.state).toBe(mode === 'cancel-unknown' ? 'unknown' : 'running')
      expect(() => a.engine.submit(a.ctx, request('two'))).toThrow('Resource busy')
      expect(a.engine.events(a.ctx).length).toBeGreaterThan(3)
    },
  )
  it('wait timeout and controller close do not claim equipment stopped', async () => {
    const a = await setup('running'),
      result = await a.engine.submit(a.ctx, request())
    await expect(a.engine.wait(a.ctx, result.id, { timeoutMs: 5 })).rejects.toThrow('timed out')
    expect(a.engine.get(a.ctx, result.id).cancelRequested).toBe(false)
    await a.engine.close()
    expect(a.provider.load()[result.id]!.state).toBe('running')
  })
  it('closing wakes program waiters without issuing device cancellation', async () => {
    const a = await setup('running'),
      result = await a.engine.submit(a.ctx, request())
    const waiting = a.engine.wait(a.ctx, result.id, { timeoutMs: 10000 }).catch((error) => String(error))
    await new Promise((resolve) => setTimeout(resolve, 3))
    await a.engine.close()
    expect(await waiting).toContain('AbortError')
    expect(a.provider.load()[result.id]!.cancellation).toBeUndefined()
  })
  it('rejects a second controller in the same or another process', async () => {
    const a = await setup()
    const second = new ExecutionEngine({
      directory: a.engine.directory,
      providers: [a.provider],
      pollIntervalMs: 2,
      providerCallTimeoutMs: 2000,
    })
    await expect(second.open()).rejects.toThrow('Another controller')
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {DatabaseSync} from 'node:sqlite'; const d=new DatabaseSync(${JSON.stringify(join(a.engine.directory, 'controller.sqlite'))}); try {d.exec('BEGIN EXCLUSIVE'); process.exit(99)} catch {process.exit(0)}`,
      ],
      { encoding: 'utf8' },
    )
    expect(child.status).toBe(0)
  })
  it('refuses changed provider configuration during recovery and preserves conflicts', async () => {
    const a = await setup('running'),
      result = await a.engine.submit(a.ctx, request())
    await a.engine.close()
    const provider = new JournalProvider(a.provider.journal)
    provider.settings = 'changed'
    const engine = new ExecutionEngine({
      directory: a.engine.directory,
      providers: [provider],
      pollIntervalMs: 2,
      providerCallTimeoutMs: 2000,
    })
    engines.push(engine)
    await engine.open()
    const ctx = engine.issueContext('p', 'new', ['journal'])
    expect(engine.get(ctx, result.id).state).toBe('unknown')
    expect(() => engine.submit(ctx, request('two'))).toThrow('configuration differs')
    expect(Object.values(provider.load()).map((x) => x.starts)).toEqual([1])
  })
  // Windows termination reports no POSIX signal name, so the SIGKILL assertion is POSIX-only.
  it.skipIf(process.platform === 'win32')('recovers after process death between actual provider start and submit reply', async () => {
    const root = directory(),
      domain = join(root, 'domain'),
      journal = join(root, 'provider-journal.json')
    const source = `import {writeFileSync} from 'node:fs';
      import {ExecutionEngine} from ${JSON.stringify(new URL('./execution.ts', import.meta.url).href)};
      const provider={describe(){return {apiVersion:1,id:'journal',version:'1',configuration:{journal:${JSON.stringify(journal)},settings:'original'},inputSchema:{},outputSchema:{},units:{budget:'sample'},constraints:['exclusive test device'],completion:'Result bytes saved',cancellation:'Deferred cancellation may save partial data'}},prepare(input){return {input,resources:['device/test'],budget:2}},async submit(op){writeFileSync(${JSON.stringify(journal)},JSON.stringify({[op.operationId]:{starts:1,state:'running',input:op.input}}));process.kill(process.pid,'SIGKILL');return {state:'running'}},async query(){return {state:'not_found'}},async cancel(){return {disposition:'unsupported'}}};
      const engine=new ExecutionEngine({directory:${JSON.stringify(domain)},providers:[provider],pollIntervalMs:2,providerCallTimeoutMs:2000});await engine.open();engine.createProject('p',10);await engine.submit(engine.issueContext('p','actor',['journal']),{providerId:'journal',requestKey:'one',input:{value:7}});`
    const child = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', source], {
      encoding: 'utf8',
      timeout: 10000,
    })
    expect(child.signal, child.stderr).toBe('SIGKILL')
    const resumed = await setup('running', root),
      operations = resumed.engine.list(resumed.ctx)
    expect(operations).toHaveLength(1)
    expect(operations[0]!.state).toBe('running')
    expect((await resumed.engine.submit(resumed.ctx, request())).id).toBe(operations[0]!.id)
    expect(Object.values(resumed.provider.load()).map((x) => x.starts)).toEqual([1])
  })
  it('records provider timeout but retains control until the real call settles', async () => {
    const root = directory(),
      provider = new JournalProvider(join(root, 'journal.json'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    provider.submit = async () => {
      await gate
      return { state: 'running' }
    }
    const engine = new ExecutionEngine({
      directory: join(root, 'domain'),
      providers: [provider],
      pollIntervalMs: 2,
      providerCallTimeoutMs: 10,
    })
    engines.push(engine)
    await engine.open()
    engine.createProject('p', 10)
    const ctx = engine.issueContext('p', 'actor', ['journal']),
      operation = await engine.submit(ctx, request())
    expect(operation.state).toBe('unknown')
    expect(operation.detail).toContain('timed out')
    expect((await engine.query(ctx, operation.id)).detail).toContain('still unresolved')
    let closed = false
    const closing = engine.close().then(() => {
      closed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(closed).toBe(false)
    const competitor = new ExecutionEngine({
      directory: engine.directory,
      providers: [provider],
      pollIntervalMs: 2,
      providerCallTimeoutMs: 10,
    })
    await expect(competitor.open()).rejects.toThrow('Another controller')
    release()
    await closing
    expect(closed).toBe(true)
  })
  it('does not exceed a project budget even after terminal resources are released', async () => {
    const a = await setup()
    a.engine.createProject('small', 2)
    const ctx = a.engine.issueContext('small', 'actor', ['journal'])
    await a.engine.submit(ctx, request())
    expect(() => a.engine.submit(ctx, request('two'))).toThrow('budget exceeded')
    expect(a.engine.list(ctx)).toHaveLength(1)
  })
})
