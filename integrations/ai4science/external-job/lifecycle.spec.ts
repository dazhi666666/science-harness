/** Real process failures and independent device journals, using the installed package rather than source adapters. */
import { it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, cpSync, unlinkSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { ExecutionEngine, type ExecutionProvider, type ProviderOperation } from '../platform/index.ts'
const installed = process.env.AI4S_EXTERNAL_MODULE
if (!installed)
  throw new Error(
    'Build/install the packages and set AI4S_EXTERNAL_MODULE; source fallback is deliberately disabled',
  )
const { createProvider } = (await import(pathToFileURL(installed).href)) as {
  createProvider: (config: unknown) => ExecutionProvider
}
const roots: string[] = []
const engines: ExecutionEngine[] = []
function world() {
  const evidence = join(process.cwd(), 'integrations/ai4science/evidence/external-job')
  mkdirSync(evidence, { recursive: true })
  const root = mkdtempSync(join(evidence, 'lifecycle-'))
  roots.push(root)
  const config = {
    id: 'job',
    directory: join(root, 'device'),
    resource: 'cpu',
    chunkSize: 1000,
    pollMs: 20,
    startupTimeoutMs: 1000,
  }
  const make = () => {
    const e = new ExecutionEngine({
      directory: join(root, 'execution'),
      providers: [createProvider(config)],
      pollIntervalMs: 10,
      providerCallTimeoutMs: 3000,
    })
    engines.push(e)
    return e
  }
  return { root, config, make }
}
function journal(root: string) {
  const db = new DatabaseSync(join(root, 'device/jobs.sqlite'))
  db.exec('PRAGMA busy_timeout=3000')
  try {
    return {
      rows: db.prepare('SELECT * FROM jobs ORDER BY rowid').all() as Record<string, unknown>[],
      starts: (db.prepare("SELECT COUNT(*) n FROM events WHERE kind='worker-started'").get() as { n: number })
        .n,
    }
  } finally {
    db.close()
  }
}
async function until<T>(body: () => T | undefined | false, ms = 15000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = body()
    if (value) return value
    await delay(10)
  }
  throw new Error('Independent observation timed out')
}
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close()
})

// Windows termination reports no POSIX signal name, so the SIGKILL assertion is POSIX-only.
it.skipIf(process.platform === 'win32')('SIGKILL after external submission loses the host reply, then fresh authorization finds one actual job', async () => {
  const w = world()
  const code = `import {ExecutionEngine} from ${JSON.stringify(new URL('../platform/index.ts', import.meta.url).href)};import {createProvider} from ${JSON.stringify(pathToFileURL(installed).href)};
 const real=createProvider(${JSON.stringify(w.config)});const wrapper={...real,async submit(op){await real.submit(op);process.kill(process.pid,'SIGKILL')}};
 const e=new ExecutionEngine({directory:${JSON.stringify(join(w.root, 'execution'))},providers:[wrapper],pollIntervalMs:10,providerCallTimeoutMs:3000});await e.open();e.createProject('p',1000000);await e.submit(e.issueContext('p','old-actor',['job']),{providerId:'job',requestKey:'stable',input:{text:'seed',iterations:200000}});`
  const killed = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', code], {
    encoding: 'utf8',
    timeout: 15000,
  })
  expect(killed.signal, killed.stderr).toBe('SIGKILL')
  await until(() => journal(w.root).starts === 1)
  const e = w.make()
  await e.open()
  const c = e.issueContext('p', 'new-authorized-actor', ['job'])
  const op = e.list(c)[0]!
  expect(op.actorId).toBe('old-actor')
  expect(
    (
      await e.submit(c, {
        providerId: 'job',
        requestKey: 'stable',
        input: { text: 'seed', iterations: 200000 },
      })
    ).id,
  ).toBe(op.id)
  const result = await e.wait(c, op.id, { timeoutMs: 15000 })
  expect(result.state).toBe('succeeded')
  expect(journal(w.root).starts).toBe(1)
  const digest = result.artifacts.find((a) => a.path.endsWith('digest.json'))!
  expect(JSON.parse(readFileSync(join(e.directory, digest.path), 'utf8')).iterations).toBe(200000)
  await e.close()
  const replacement = w.make()
  await replacement.open()
  expect(() => replacement.list(c)).toThrow('context')
  replacement.createProject('other', 1000000)
  const foreign = replacement.issueContext('other', 'foreign', ['job'])
  expect(() => replacement.get(foreign, op.id)).toThrow('another project')
  const denied = replacement.issueContext('p', 'no-capability', [])
  expect(() => replacement.get(denied, op.id)).toThrow('authorized')
})

it('concurrent stable submissions use one durable launch ticket, and a changed identity is rejected', async () => {
  const w = world()
  const a = createProvider(w.config),
    b = createProvider(w.config)
  const op: ProviderOperation = {
    operationId: 'stable-id',
    projectId: 'p',
    input: { text: 'x', iterations: 10000 },
    artifactDirectory: join(w.root, 'domain', 'artifacts', 'stable'),
  }
  await Promise.all([a.submit(op), b.submit(op)])
  await until(() => journal(w.root).rows[0]?.state === 'succeeded')
  expect(journal(w.root).starts).toBe(1)
  await expect(b.submit({ ...op, projectId: 'unrelated' })).rejects.toThrow('identity')
  const terminal = await b.cancel(op)
  expect(terminal.disposition).toBe('rejected')
  expect(terminal.observation?.state).toBe('succeeded')
})

it('supervisor death becomes unknown, retains occupancy and budget, and never launches the same job again', async () => {
  const w = world()
  const e = w.make()
  await e.open()
  e.createProject('p', 10000000)
  const c = e.issueContext('p', 'actor', ['job'])
  const op = await e.submit(c, {
    providerId: 'job',
    requestKey: 'lost-owner',
    input: { text: 'lost', iterations: 5000000 },
  })
  const running = await until(() => {
    const r = journal(w.root).rows[0]
    return r && Number(r.done) > 0 && r.state === 'running' ? r : undefined
  })
  // Fault injection targets the supervisor just created by this test; production cancellation never signals recorded PIDs.
  process.kill(Number(running.supervisor_pid), 'SIGKILL')
  await delay(100)
  expect((await e.query(c, op.id)).state).toBe('unknown')
  expect(() =>
    e.submit(c, { providerId: 'job', requestKey: 'conflict', input: { text: 'other', iterations: 1 } }),
  ).toThrow('busy')
  const repeated = await e.submit(c, {
    providerId: 'job',
    requestKey: 'lost-owner',
    input: { text: 'lost', iterations: 5000000 },
  })
  expect(repeated.id).toBe(op.id)
  expect(journal(w.root).starts).toBe(1)
  expect(e.projects()[0]?.budgetUsed).toBe(5000000)
  await e.close()
  const restored = w.make()
  await restored.open()
  const fresh = restored.issueContext('p', 'replacement', ['job'])
  expect(restored.get(fresh, op.id).state).toBe('unknown')
  expect((await restored.cancel(fresh, op.id)).state).toBe('unknown')
})

it('missing external executable keeps a bounded startup receipt then unknown, without retrying its durable ticket', async () => {
  const w = world()
  const copied = join(dirname(dirname(installed!)), 'missing-executable-' + basename(w.root))
  cpSync(dirname(installed!), copied, { recursive: true })
  unlinkSync(join(copied, 'supervisor.mjs'))
  const { createProvider: brokenFactory } = await import(pathToFileURL(join(copied, 'index.mjs')).href)
  const broken = brokenFactory({ ...w.config, startupTimeoutMs: 100 }) as ExecutionProvider
  const e = new ExecutionEngine({
    directory: join(w.root, 'execution'),
    providers: [broken],
    pollIntervalMs: 10,
    providerCallTimeoutMs: 1000,
  })
  engines.push(e)
  await e.open()
  e.createProject('p', 1000)
  const c = e.issueContext('p', 'actor', ['job'])
  const op = await e.submit(c, {
    providerId: 'job',
    requestKey: 'missing',
    input: { text: 'seed', iterations: 10 },
  })
  expect(op.state).toBe('accepted')
  await delay(150)
  expect((await e.query(c, op.id)).state).toBe('unknown')
  expect(
    (await e.submit(c, { providerId: 'job', requestKey: 'missing', input: { text: 'seed', iterations: 10 } }))
      .id,
  ).toBe(op.id)
  expect(journal(w.root).starts).toBe(0)
  expect(() =>
    e.submit(c, { providerId: 'job', requestKey: 'another', input: { text: 'seed', iterations: 10 } }),
  ).toThrow('busy')
  const row = journal(w.root).rows[0]!
  expect(readFileSync(join(w.config.directory, 'launch', String(row.job_id) + '.log'), 'utf8')).toContain(
    'MODULE_NOT_FOUND',
  )
})
