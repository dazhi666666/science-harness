/** Independent provider journals verify actual actions, cancellation and restart behavior. */
import { it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createProvider as instrument } from './providers/instrument.ts'
import { createProvider as compute } from './providers/compute.ts'
import { ExecutionEngine } from './execution.ts'
import { verifyStableSubmission } from './testing.ts'
import { readPlatformConfig } from './config.ts'
import { validateProvider, type ExecutionProvider } from './sdk.ts'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ai4s-provider-'))
  const instrumentConfig = {
    id: 'instrument',
    directory: join(dir, 'instrument'),
    resource: 'device',
    tickMs: 1,
    reference: 10,
    slope: 0.27,
    drift: 0.012,
    noise: 0.18,
    seed: 123,
  }
  const computeConfig = {
    id: 'compute',
    directory: join(dir, 'compute'),
    resource: 'cpu',
    tickMs: 1,
    chunkSize: 2,
  }
  const providers = () => [instrument(instrumentConfig), compute(computeConfig)]
  const engine = () =>
    new ExecutionEngine({
      directory: join(dir, 'platform'),
      pollIntervalMs: 2,
      providerCallTimeoutMs: 1000,
      providers: providers(),
    })
  return { dir, instrumentConfig, computeConfig, providers, engine }
}
function count(path: string, table: string) {
  const db = new DatabaseSync(path)
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  } finally {
    db.close()
  }
}

it('both SDK-only adapters reject duplicate device actions across new provider instances', async () => {
  const f = fixture()
  try {
    for (const [create, c, input, db] of [
      [instrument, f.instrumentConfig, { conditions: [{ value: 1, samples: 3 }] }, 'instrument.sqlite'],
      [compute, f.computeConfig, { text: 'abc', iterations: 5 }, 'compute.sqlite'],
    ] as const) {
      await verifyStableSubmission(
        () => create(c),
        {
          operationId: 'stable',
          projectId: 'p',
          input: JSON.parse(JSON.stringify(input)),
          artifactDirectory: join(c.directory, 'output'),
        },
        () => count(join(c.directory, db), 'starts'),
      )
    }
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})
it('two provider types finish without core changes, recover project data, verify digest and export bytes', async () => {
  const f = fixture()
  let e = f.engine()
  await e.open()
  try {
    e.createProject('p', 100)
    const c = e.issueContext('p', 'new-live-actor', ['instrument', 'compute'])
    const a = await e.submit(c, {
      providerId: 'instrument',
      requestKey: 'first',
      input: {
        conditions: [
          { value: -1, samples: 2 },
          { value: 1, samples: 2 },
        ],
      },
    })
    const b = await e.submit(c, {
      providerId: 'compute',
      requestKey: 'second',
      input: { text: 'abc', iterations: 8 },
    })
    await e.query(c, a.id)
    await e.close()
    e = f.engine()
    await e.open()
    expect(() => e.get(c, a.id)).toThrow('context')
    const fresh = e.issueContext('p', 'takeover', ['instrument', 'compute'])
    const result = await e.wait(fresh, b.id, { timeoutMs: 1000 })
    const raw = await e.wait(fresh, a.id, { timeoutMs: 1000 })
    expect(result.state).toBe('succeeded')
    expect(raw.state).toBe('succeeded')
    let digest = 'abc'
    for (let i = 0; i < 8; i++) digest = createHash('sha256').update(digest).digest('hex')
    const file = result.artifacts[0]!
    expect(JSON.parse(readFileSync(join(e.directory, file.path), 'utf8')).digest).toBe(digest)
    expect(count(join(f.computeConfig.directory, 'compute.sqlite'), 'starts')).toBe(1)
    expect(count(join(f.instrumentConfig.directory, 'instrument.sqlite'), 'samples')).toBe(4)
    const rows = JSON.parse(
      readFileSync(
        join(e.directory, raw.artifacts.find((a) => a.mediaType === 'application/json')!.path),
        'utf8',
      ),
    )
    expect(rows.map((r: { order: number }) => r.order)).toEqual([1, 2, 3, 4])
    const exported = join(f.dir, 'export.json')
    e.exportArtifact(fresh, file.id, exported)
    expect(readFileSync(exported)).toEqual(readFileSync(join(e.directory, file.path)))
    expect(
      (
        await e.submit(fresh, {
          providerId: 'compute',
          requestKey: 'second',
          input: { text: 'abc', iterations: 8 },
        })
      ).id,
    ).toBe(b.id)
    expect(count(join(f.computeConfig.directory, 'compute.sqlite'), 'starts')).toBe(1)
    writeFileSync(join(e.directory, file.path), 'corrupt')
    expect(() => e.exportArtifact(fresh, file.id, join(f.dir, 'bad.json'))).toThrow('integrity')
  } finally {
    await e.close()
    rmSync(f.dir, { recursive: true, force: true })
  }
})
it('cancel request is durable and partial instrument samples survive subsequent cancellation completion', async () => {
  const f = fixture()
  let e = f.engine()
  await e.open()
  try {
    e.createProject('p', 20)
    const c = e.issueContext('p', 'actor', ['instrument'])
    const r = await e.submit(c, {
      providerId: 'instrument',
      requestKey: 'sample',
      input: { conditions: [{ value: 0, samples: 10 }] },
    })
    await delay(3)
    const partial = await e.query(c, r.id)
    expect(partial.progress).toEqual({ samples: 1, total: 10 })
    const requested = await e.cancel(c, r.id)
    expect(requested.cancelRequested).toBe(true)
    expect(requested.state).toBe('running')
    await e.close()
    e = f.engine()
    await e.open()
    const fresh = e.issueContext('p', 'fresh', ['instrument'])
    const ended = e.get(fresh, r.id)
    expect(ended.state).toBe('cancelled')
    expect(ended.progress).toEqual({ samples: 1, total: 10 })
    expect(ended.artifacts).toHaveLength(2)
    expect(e.projects()[0]?.budgetUsed).toBe(10)
    expect(count(join(f.instrumentConfig.directory, 'instrument.sqlite'), 'samples')).toBe(1)
  } finally {
    await e.close()
    rmSync(f.dir, { recursive: true, force: true })
  }
})
it('configuration rejects disabled plugin, incompatible baseline and unknown fields', () => {
  const f = fixture()
  try {
    for (const v of [
      { apiVersion: 1, enabled: false },
      { apiVersion: 2, enabled: true },
      { apiVersion: 1, enabled: true, baseline: 'other', unexpected: true },
    ]) {
      const path = join(f.dir, 'bad.json')
      writeFileSync(path, JSON.stringify(v))
      expect(() => readPlatformConfig(path)).toThrow()
    }
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})
it('dynamic Provider registration rejects missing methods or incompatible metadata before execution', () => {
  const f = fixture()
  try {
    const good = f.providers()[0]!
    expect(() => validateProvider({ ...good, query: undefined } as unknown as ExecutionProvider)).toThrow(
      'implement',
    )
    expect(() =>
      validateProvider({
        ...good,
        describe: () => ({ ...good.describe(), apiVersion: 2 }),
      } as unknown as ExecutionProvider),
    ).toThrow('Incompatible')
    expect(() =>
      validateProvider({
        ...good,
        describe: () => ({ ...good.describe(), id: 3 }),
      } as unknown as ExecutionProvider),
    ).toThrow('Incompatible')
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})
it('changed published Provider bytes become unknown without rewriting the trusted hash or releasing resources', async () => {
  const f = fixture()
  const underlying = compute(f.computeConfig)
  let queries = 0
  const provider: ExecutionProvider = {
    ...underlying,
    async query(op) {
      await underlying.query(op)
      writeFileSync(join(op.artifactDirectory, 'partial.txt'), String(++queries))
      return { state: 'running', artifacts: [{ path: 'partial.txt', mediaType: 'text/plain' }] }
    },
  }
  const engine = new ExecutionEngine({
    directory: join(f.dir, 'domain'),
    providers: [provider],
    pollIntervalMs: 2,
    providerCallTimeoutMs: 1000,
  })
  await engine.open()
  try {
    engine.createProject('p', 100)
    const c = engine.issueContext('p', 'actor', ['compute'])
    const op = await engine.submit(c, {
      providerId: 'compute',
      requestKey: 'one',
      input: { text: 'abc', iterations: 20 },
    })
    const first = await engine.query(c, op.id)
    const next = await engine.query(c, op.id)
    expect(next.state).toBe('unknown')
    expect(next.detail).toContain('immutable')
    expect(next.artifacts[0]!.sha256).toBe(first.artifacts[0]!.sha256)
    expect(() =>
      engine.submit(c, { providerId: 'compute', requestKey: 'two', input: { text: 'abc', iterations: 20 } }),
    ).toThrow('busy')
    expect(() => engine.exportArtifact(c, next.artifacts[0]!.id, join(f.dir, 'bad.txt'))).toThrow('integrity')
  } finally {
    await engine.close()
    rmSync(f.dir, { recursive: true, force: true })
  }
})
