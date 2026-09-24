/** Provider-owned state; no platform internals or Agent identities are imported. */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, realpathSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { canonicalJson } from '@ai4science/provider-sdk'

export function settings(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).sort().join() !== 'chunkSize,directory,id,pollMs,resource,startupTimeoutMs' ||
    typeof input.id !== 'string' ||
    !/^[\w.-]+$/.test(input.id) ||
    typeof input.directory !== 'string' ||
    !input.directory ||
    typeof input.resource !== 'string' ||
    !input.resource ||
    !Number.isSafeInteger(input.chunkSize) ||
    input.chunkSize < 1 ||
    input.chunkSize > 10000 ||
    !Number.isSafeInteger(input.pollMs) ||
    input.pollMs < 10 ||
    input.pollMs > 1000 ||
    !Number.isSafeInteger(input.startupTimeoutMs) ||
    input.startupTimeoutMs < 100 ||
    input.startupTimeoutMs > 60000
  )
    throw new Error('Invalid local-job configuration')
  mkdirSync(resolve(input.directory), { recursive: true, mode: 0o700 })
  return { ...input, directory: realpathSync(resolve(input.directory)) }
}

export function parseInput(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).sort().join() !== 'iterations,text' ||
    typeof input.text !== 'string' ||
    input.text.length > 65536 ||
    !Number.isSafeInteger(input.iterations) ||
    input.iterations < 1 ||
    input.iterations > 100000000
  )
    throw new Error('Expected text <=65536 characters and iterations 1..100000000')
  return { text: input.text, iterations: input.iterations }
}

export function openJournal(config) {
  const db = new DatabaseSync(join(config.directory, 'jobs.sqlite'))
  try {
    db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
    const version = db.prepare('PRAGMA user_version').get().user_version
    if (version !== 0 && version !== 1) throw new Error('Unsupported local-job journal version')
    db.exec(`CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS control_domain(id INTEGER PRIMARY KEY CHECK(id=1),root TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(operation_id TEXT PRIMARY KEY,job_id TEXT UNIQUE NOT NULL,nonce TEXT NOT NULL,
        identity TEXT NOT NULL,input TEXT NOT NULL,artifact_directory TEXT NOT NULL,state TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,digest TEXT NOT NULL,cancel_requested INTEGER NOT NULL DEFAULT 0,
        supervisor_pid INTEGER,worker_pid INTEGER,exit_code INTEGER,exit_signal TEXT,detail TEXT,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,at TEXT NOT NULL);
      PRAGMA user_version=1;`)
    transaction(db, () => {
      const prior = db.prepare('SELECT value FROM settings WHERE id=1').get()
      const fingerprint = canonicalJson(config)
      if (prior && prior.value !== fingerprint)
        throw new Error('Local-job configuration differs from persisted journal')
      if (!prior) db.prepare('INSERT INTO settings VALUES (1,?)').run(fingerprint)
    })
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function transaction(db, body) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = body()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function normalized(operation) {
  if (
    !operation ||
    typeof operation.operationId !== 'string' ||
    !operation.operationId ||
    operation.operationId.length > 128 ||
    typeof operation.projectId !== 'string' ||
    !operation.projectId ||
    typeof operation.artifactDirectory !== 'string'
  )
    throw new Error('Invalid operation identity')
  parseInput(operation.input)
  mkdirSync(resolve(operation.artifactDirectory), { recursive: true, mode: 0o700 })
  return { ...operation, artifactDirectory: realpathSync(resolve(operation.artifactDirectory)) }
}

export const identity = (op) =>
  canonicalJson({ projectId: op.projectId, input: op.input, artifactDirectory: op.artifactDirectory })
export function assertDomain(db, op, claim = false) {
  const root = dirname(op.artifactDirectory)
  const prior = db.prepare('SELECT root FROM control_domain WHERE id=1').get()
  if (prior && prior.root !== root) throw new Error('Device journal belongs to another management domain')
  if (!prior && claim) db.prepare('INSERT INTO control_domain VALUES (1,?)').run(root)
}
export function assertIdentity(row, op) {
  if (row.identity !== identity(op)) throw new Error('Stable operation identity changed')
}
export const terminal = (state) => ['succeeded', 'failed', 'cancelled'].includes(state)
export const lockPath = (config, jobId) => join(config.directory, 'locks', `${jobId}.sqlite`)
export function event(db, jobId, kind, data = {}) {
  db.prepare('INSERT INTO events(job_id,kind,data,at) VALUES (?,?,?,?)').run(
    jobId,
    kind,
    JSON.stringify(data),
    new Date().toISOString(),
  )
}

/** OS-released lock proves an active owner; PID is diagnostic only and is never signalled by a reconnecting client. */
export function ownerPresent(config, jobId) {
  const path = lockPath(config, jobId)
  if (!existsSync(path)) return false
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
    db.exec('ROLLBACK')
    return false
  } catch (error) {
    if (error.errcode === 5 || error.errcode === 6) return true
    throw error
  } finally {
    db.close()
  }
}

export function observation(config, row, db) {
  if (!row) return { state: 'not_found', detail: 'No operation in the external job journal' }
  const progress = {
    jobId: row.job_id,
    iterations: row.done,
    total: JSON.parse(row.input).iterations,
    cancelRequested: !!row.cancel_requested,
    diagnosticLog: `launch/${row.job_id}.log`,
    supervisorPid: row.supervisor_pid,
    workerPid: row.worker_pid,
    exitCode: row.exit_code,
    exitSignal: row.exit_signal,
  }
  if (terminal(row.state))
    return {
      state: row.state,
      progress,
      detail: row.detail ?? 'External worker exit observed',
      artifacts: [
        { path: 'digest.json', mediaType: 'application/json' },
        { path: 'execution.json', mediaType: 'application/json' },
        { path: 'execution.log', mediaType: 'text/plain' },
      ],
    }
  if (row.state === 'starting' && Date.now() - Date.parse(row.updated_at) < config.startupTimeoutMs)
    return {
      state: 'accepted',
      progress,
      detail: 'Durable submission is within the bounded supervisor startup interval',
    }
  if (!ownerPresent(config, row.job_id)) {
    // The supervisor releases its lock only after committing the terminal record,
    // so a row read that raced that commit is stale; re-read before declaring loss.
    const fresh = db.prepare('SELECT * FROM jobs WHERE job_id=?').get(row.job_id)
    if (fresh && terminal(fresh.state)) return observation(config, fresh, db)
    return {
      state: 'unknown',
      progress,
      detail: 'No active supervisor ownership; never relaunch an uncertain job automatically',
    }
  }
  return { state: row.state === 'starting' ? 'accepted' : 'running', progress }
}
