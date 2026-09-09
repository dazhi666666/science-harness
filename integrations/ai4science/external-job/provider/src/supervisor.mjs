/** Independent, one-job supervisor: owns the live ChildProcess and confirms exit before publishing a terminal result. */
import { DatabaseSync } from 'node:sqlite'
import { fork } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openJournal, transaction, lockPath, terminal, event } from './journal.mjs'

const [directory, jobId, nonce] = process.argv.slice(2)
const settingsDb = new DatabaseSync(join(directory, 'jobs.sqlite'))
// WAL recovery or a concurrent connection can briefly hold the settings read lock.
settingsDb.exec('PRAGMA busy_timeout=1000')
const config = JSON.parse(settingsDb.prepare('SELECT value FROM settings WHERE id=1').get().value)
settingsDb.close()
const db = openJournal(config)
let row = db.prepare('SELECT * FROM jobs WHERE job_id=?').get(jobId)
if (!row || row.nonce !== nonce || terminal(row.state)) {
  db.close()
  process.exit(1)
}
mkdirSync(join(directory, 'locks'), { recursive: true, mode: 0o700 })
const owner = new DatabaseSync(lockPath(config, jobId))
try {
  owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
} catch {
  owner.close()
  db.close()
  process.exit(1)
}
// Exact durable launch ticket may start only once even if someone repeats the supervisor invocation.
row = db.prepare('SELECT * FROM jobs WHERE job_id=?').get(jobId)
if (row.state !== 'starting' || row.nonce !== nonce) {
  owner.close()
  db.close()
  process.exit(1)
}
const input = JSON.parse(row.input)
const logPath = join(row.artifact_directory, 'execution.log')
writeFileSync(logPath, `job ${jobId}: supervisor started\n`, { mode: 0o600, flag: 'wx' })
transaction(db, () => {
  db.prepare("UPDATE jobs SET state='running',supervisor_pid=?,updated_at=? WHERE job_id=?").run(
    process.pid,
    new Date().toISOString(),
    jobId,
  )
  event(db, jobId, 'supervisor-started', { pid: process.pid })
})
const child = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [], {
  execArgv: [],
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  env: process.env,
})
let cancelSent = false,
  failure
child.on('error', (error) => {
  failure = String(error)
})
child.on('message', (message) => {
  try {
    if (message.kind === 'started') {
      db.prepare('UPDATE jobs SET worker_pid=? WHERE job_id=?').run(child.pid, jobId)
      event(db, jobId, 'worker-started', { pid: child.pid })
    } else if (message.kind === 'checkpoint') {
      transaction(db, () => {
        db.prepare('UPDATE jobs SET done=?,digest=?,updated_at=? WHERE job_id=?').run(
          message.done,
          message.digest,
          new Date().toISOString(),
          jobId,
        )
        event(db, jobId, 'checkpoint', { iterations: message.done })
      })
    }
  } catch (error) {
    failure = String(error)
    child.kill('SIGTERM')
  }
})
const timer = setInterval(() => {
  try {
    if (
      !cancelSent &&
      db.prepare('SELECT cancel_requested FROM jobs WHERE job_id=?').get(jobId).cancel_requested
    ) {
      cancelSent = true
      event(db, jobId, 'cancel-signal-sent')
      child.kill('SIGTERM') // The live child handle, never a PID loaded after a restart.
    }
  } catch (error) {
    failure = String(error)
    child.kill('SIGTERM')
  }
}, config.pollMs)
child.on('close', (code, signal) => {
  clearInterval(timer)
  try {
    row = db.prepare('SELECT * FROM jobs WHERE job_id=?').get(jobId)
    const state =
      !failure && code === 0 && row.done === input.iterations
        ? 'succeeded'
        : cancelSent && signal === 'SIGTERM' && !failure
          ? 'cancelled'
          : 'failed'
    const result = {
      algorithm: 'sha256-chain',
      jobId,
      operationId: row.operation_id,
      iterations: row.done,
      requestedIterations: input.iterations,
      digest: row.digest,
      complete: state === 'succeeded',
    }
    const exit = {
      jobId,
      state,
      exitCode: code,
      exitSignal: signal,
      cancelRequested: !!row.cancel_requested,
      iterations: row.done,
      detail: failure ?? 'Worker process exit observed',
      finishedAt: new Date().toISOString(),
    }
    for (const [name, value] of [
      ['digest.json', result],
      ['execution.json', exit],
    ]) {
      const path = join(row.artifact_directory, name)
      writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      renameSync(path + '.tmp', path)
    }
    appendFileSync(logPath, `worker exited: ${JSON.stringify(exit)}\n`)
    transaction(db, () => {
      db.prepare(
        'UPDATE jobs SET state=?,exit_code=?,exit_signal=?,detail=?,updated_at=? WHERE job_id=?',
      ).run(state, code, signal, exit.detail, new Date().toISOString(), jobId)
      event(db, jobId, 'worker-exited', exit)
    })
  } catch (error) {
    // Output publication failure leaves the nonterminal record unresolved; reconnection reports unknown.
    try {
      event(db, jobId, 'publication-failed', { detail: String(error) })
    } catch {
      /* Journal itself unavailable; no terminal claim. */
    }
    process.exitCode = 1
  } finally {
    owner.close()
    db.close()
  }
})
child.send({ ...input, chunkSize: config.chunkSize })
