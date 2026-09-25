/** Installed local-job adapter; all platform integration uses the public Provider SDK. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { canonicalJson } from '@ai4science/provider-sdk'
import {
  settings,
  parseInput,
  openJournal,
  transaction,
  normalized,
  identity,
  assertDomain,
  assertIdentity,
  terminal,
  event,
  observation,
} from './journal.mjs'

/** Only noncredential process settings reach the fixed execution program. */
function workerEnvironment() {
  return Object.fromEntries(
    ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT']
      .filter((k) => process.env[k] !== undefined)
      .map((k) => [k, process.env[k]]),
  )
}

export function createProvider(input) {
  const config = settings(input)
  const initial = openJournal(config)
  initial.close()
  return {
    describe: () => ({
      apiVersion: 1,
      id: config.id,
      version: '0.1.1',
      configuration: config,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'iterations'],
        properties: {
          text: { type: 'string', maxLength: 65536 },
          iterations: { type: 'integer', minimum: 1, maximum: 100000000 },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          digest: { type: 'string' },
          iterations: { type: 'integer' },
          complete: { type: 'boolean' },
        },
      },
      units: { budget: 'iteration' },
      constraints: [
        `Exclusive resource ${config.resource}`,
        'Fixed SHA256 workload; no arbitrary command or code input',
        'One permanent management-domain binding per journal',
        'Query observes external work and does not advance it',
        'Host exit does not cancel the detached supervisor or worker; OS reboot and supervisor-crash continuation are unsupported',
      ],
      completion:
        'Supervisor observes successful worker exit after all hash iterations, then publishes immutable digest, exit record and log.',
      cancellation:
        'Durable request is polled by the independent supervisor. Only observed worker termination confirms cancellation. Prior successful completion wins a cancellation race.',
    }),
    prepare(value) {
      const parsed = parseInput(value)
      return { input: parsed, resources: [config.resource], budget: parsed.iterations }
    },
    async submit(operation) {
      const op = normalized(operation),
        db = openJournal(config)
      let created = false,
        row
      try {
        transaction(db, () => {
          assertDomain(db, op)
          row = db.prepare('SELECT * FROM jobs WHERE operation_id=?').get(op.operationId)
          if (row) {
            assertIdentity(row, op)
            return
          }
          if (
            db.prepare("SELECT job_id FROM jobs WHERE state NOT IN ('succeeded','failed','cancelled')").get()
          )
            throw new Error('External execution resource remains occupied')
          assertDomain(db, op, true)
          db.prepare(
            'INSERT INTO jobs(operation_id,job_id,nonce,identity,input,artifact_directory,state,digest,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
          ).run(
            op.operationId,
            randomUUID(),
            randomUUID(),
            identity(op),
            canonicalJson(op.input),
            op.artifactDirectory,
            'starting',
            op.input.text,
            new Date().toISOString(),
          )
          row = db.prepare('SELECT * FROM jobs WHERE operation_id=?').get(op.operationId)
          event(db, row.job_id, 'registered')
          created = true
        })
        if (created) {
          // Child executable and argv are fixed. Input and identity are loaded from the durable journal.
          mkdirSync(join(config.directory, 'launch'), { recursive: true, mode: 0o700 })
          const fd = openSync(join(config.directory, 'launch', `${row.job_id}.log`), 'wx', 0o600)
          try {
            const child = spawn(
              process.execPath,
              [
                fileURLToPath(new URL('./supervisor.mjs', import.meta.url)),
                config.directory,
                row.job_id,
                row.nonce,
              ],
              { detached: true, stdio: ['ignore', fd, fd], env: workerEnvironment(), windowsHide: true },
            )
            await new Promise((resolve, reject) => {
              child.once('spawn', resolve)
              child.once('error', reject)
            })
            child.unref()
          } catch (error) {
            event(db, row.job_id, 'launch-failed', { detail: String(error) })
            throw error
          } finally {
            closeSync(fd)
          }
          return {
            state: 'accepted',
            progress: { jobId: row.job_id, iterations: 0, total: op.input.iterations },
            detail: 'Durable external submission; worker startup/completion must be observed separately',
          }
        }
        return observation(config, row, db)
      } finally {
        db.close()
      }
    },
    async query(operation) {
      const op = normalized(operation),
        db = openJournal(config)
      try {
        assertDomain(db, op)
        const row = db.prepare('SELECT * FROM jobs WHERE operation_id=?').get(op.operationId)
        if (row) assertIdentity(row, op)
        return observation(config, row, db)
      } finally {
        db.close()
      }
    },
    async cancel(operation) {
      const op = normalized(operation),
        db = openJournal(config)
      try {
        return transaction(db, () => {
          assertDomain(db, op)
          const row = db.prepare('SELECT * FROM jobs WHERE operation_id=?').get(op.operationId)
          if (!row) return { disposition: 'rejected', detail: 'Unknown external operation' }
          assertIdentity(row, op)
          if (terminal(row.state))
            return {
              disposition: 'rejected',
              observation: observation(config, row, db),
              detail: 'Already terminal; history preserved',
            }
          db.prepare('UPDATE jobs SET cancel_requested=1 WHERE job_id=?').run(row.job_id)
          event(db, row.job_id, 'cancel-requested')
          return {
            disposition: 'requested',
            detail: 'Supervisor must observe this request and confirm actual worker exit',
          }
        })
      } finally {
        db.close()
      }
    },
  }
}
