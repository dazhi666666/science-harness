/** Device journals independently bind to one management domain, including while the device is idle. */
import { it, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { ExecutionEngine } from './execution.ts'
import { createProvider as instrument } from './providers/instrument.ts'
import { createProvider as compute } from './providers/compute.ts'
import type { ExecutionProvider, Json, ProviderOperation } from './sdk.ts'

function count(path: string, table: string) {
  const db = new DatabaseSync(path)
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  } finally {
    db.close()
  }
}
for (const kind of ['instrument', 'compute'] as const) {
  it(`${kind} validates deployment field types before opening device resources`, () => {
    const create = kind === 'instrument' ? instrument : compute
    expect(() => create({ id: kind, directory: 1, resource: { bad: true }, tickMs: 1 })).toThrow(
      'configuration',
    )
    expect(() =>
      create({ id: kind, directory: 'unused', resource: 'resource', tickMs: 1, extra: true }),
    ).toThrow('configuration')
  })
  it(`${kind} atomically chooses one configuration when two processes initialize the device`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai4s-device-config-race-'))
    try {
      const config =
        kind === 'instrument'
          ? {
              id: kind,
              directory: join(directory, 'device'),
              resource: 'device',
              tickMs: 1,
              reference: 10,
              slope: 0.1,
              drift: 0,
              noise: 0,
              seed: 1,
            }
          : { id: kind, directory: join(directory, 'device'), resource: 'device', tickMs: 1, chunkSize: 2 }
      const input: Json =
        kind === 'instrument' ? { conditions: [{ value: 0, samples: 1 }] } : { text: 'a', iterations: 1 }
      const module = new URL(`./providers/${kind}.ts`, import.meta.url).href
      const launch = (index: number) =>
        new Promise<{ code: number | null; stderr: string }>((resolve) => {
          const source = `import {createProvider} from ${JSON.stringify(module)};const provider=createProvider(${JSON.stringify({ ...config, tickMs: index + 1 })});try{await provider.submit(${JSON.stringify({ operationId: `op-${index}`, projectId: 'p', input, artifactDirectory: join(directory, 'domain', 'artifacts', `op-${index}`) })});process.exit(0)}catch(error){process.stderr.write(String(error));process.exit(2)}`
          const child = spawn(
            process.execPath,
            ['--import', 'tsx/esm', '--input-type=module', '-e', source],
            { stdio: ['ignore', 'ignore', 'pipe'] },
          )
          let stderr = ''
          child.stderr.on('data', (data) => {
            stderr += String(data)
          })
          child.on('exit', (code) => resolve({ code, stderr }))
        })
      const outcomes = await Promise.all([launch(0), launch(1)])
      expect(
        outcomes.every((x) => x.code === 0 || x.code === 2),
        JSON.stringify(outcomes),
      ).toBe(true)
      expect(outcomes.filter((x) => x.code === 0).length).toBeLessThanOrEqual(1)
      const database = join(config.directory, `${kind === 'instrument' ? 'instrument' : 'compute'}.sqlite`)
      // SQLite may reject both first-open contenders. A deliberate same-ID retry uses the persisted configuration.
      if (outcomes.every((x) => x.code === 2)) {
        const db = new DatabaseSync(database)
        const hasConfig = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='config'")
          .get()
        const row = hasConfig
          ? (db.prepare('SELECT value FROM config').get() as { value: string } | undefined)
          : undefined
        db.close()
        const selected = row ? (JSON.parse(row.value) as typeof config) : config
        const create = kind === 'instrument' ? instrument : compute
        await create(selected as Json).submit({
          operationId: `op-${selected.tickMs - 1}`,
          projectId: 'p',
          input,
          artifactDirectory: join(directory, 'domain', 'artifacts', `op-${selected.tickMs - 1}`),
        })
      }
      expect(count(database, 'config')).toBe(1)
      expect(count(database, 'control_domain')).toBe(1)
      expect(count(database, 'starts')).toBe(1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it(`${kind} binds on accepted submission, refuses another domain while idle, and recognizes real-path aliases`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai4s-device-domain-'))
    const config =
      kind === 'instrument'
        ? {
            id: kind,
            directory: join(directory, 'device'),
            resource: 'device',
            tickMs: 1,
            reference: 10,
            slope: 0.1,
            drift: 0,
            noise: 0,
            seed: 1,
          }
        : { id: kind, directory: join(directory, 'device'), resource: 'device', tickMs: 1, chunkSize: 2 }
    const factory = (): ExecutionProvider =>
      kind === 'instrument' ? instrument(config as Json) : compute(config as Json)
    const input: Json =
      kind === 'instrument' ? { conditions: [{ value: 0, samples: 1 }] } : { text: 'a', iterations: 1 }
    const database = join(config.directory, `${kind === 'instrument' ? 'instrument' : 'compute'}.sqlite`)
    const make = (domain: string) =>
      new ExecutionEngine({
        directory: domain,
        providers: [factory()],
        pollIntervalMs: 2,
        providerCallTimeoutMs: 1000,
      })
    const owner = make(join(directory, 'owner')),
      other = make(join(directory, 'other'))
    let alias: ExecutionEngine | undefined
    try {
      const provider = factory(),
        unknown: ProviderOperation = {
          operationId: 'unknown',
          projectId: 'p',
          input,
          artifactDirectory: join(directory, 'unclaimed', 'artifacts', 'unknown'),
        }
      expect((await provider.query(unknown)).state).toBe('not_found')
      expect(count(database, 'control_domain')).toBe(0)
      await owner.open()
      owner.createProject('p', 10)
      const ctx = owner.issueContext('p', 'actor', [kind]),
        first = await owner.submit(ctx, { providerId: kind, requestKey: 'one', input })
      expect((await owner.wait(ctx, first.id, { timeoutMs: 1000 })).state).toBe('succeeded')
      expect(count(database, 'starts')).toBe(1)
      expect(count(database, 'control_domain')).toBe(1)
      await other.open()
      other.createProject('p', 10)
      const second = await other.submit(other.issueContext('p', 'actor', [kind]), {
        providerId: kind,
        requestKey: 'two',
        input,
      })
      expect(second.state).toBe('unknown')
      expect(second.detail).toContain('another management domain')
      expect(count(database, 'starts')).toBe(1)
      const spoof = {
        operationId: first.id,
        projectId: 'p',
        input,
        artifactDirectory: join(other.directory, 'artifacts', first.id),
      }
      await expect(provider.query(spoof)).rejects.toThrow('another management domain')
      await expect(provider.cancel(spoof)).rejects.toThrow('another management domain')
      const inProgress = await owner.submit(ctx, { providerId: kind, requestKey: 'in-progress', input })
      await owner.close()
      mkdirSync(join(directory, 'alias-parent'))
      symlinkSync(join(directory, 'owner'), join(directory, 'alias-parent', 'same-domain'))
      alias = make(join(directory, 'alias-parent', 'same-domain'))
      await alias.open()
      expect(alias.get(alias.issueContext('p', 'reader', [kind]), inProgress.id).state).not.toBe('unknown')
      await alias.wait(alias.issueContext('p', 'waiter', [kind]), inProgress.id, { timeoutMs: 1000 })
      const aliased = await alias.submit(alias.issueContext('p', 'fresh', [kind]), {
        providerId: kind,
        requestKey: 'three',
        input,
      })
      expect(aliased.state).toBe('running')
      expect(count(database, 'starts')).toBe(3)
    } finally {
      await owner.close()
      await other.close()
      await alias?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
}
