/** Reference instrument adapter. Its independent journal owns actual sample order and start counts. */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, renameSync, realpathSync } from 'node:fs'
import { resolve, join } from 'node:path'
import {
  canonicalJson,
  type ExecutionProvider,
  type Json,
  type ProviderOperation,
  type ProviderObservation,
} from '../sdk.ts'

interface Settings {
  id: string
  directory: string
  resource: string
  tickMs: number
  reference: number
  slope: number
  drift: number
  noise: number
  seed: number
}
interface Block {
  value: number
  samples: number
}
interface Reading {
  operationId: string
  requestedCondition: number
  appliedCondition: number
  order: number
  timestamp: string
  value: number
  unit: string
}
interface Row {
  id: string
  identity: string
  state: string
  input: string
  directory: string
  readings: string
  next_at: number
  cancel: number
}

/** Construct using only the public provider API; configuration is trusted deployment data, validated here. */
export function createProvider(input: Json): ExecutionProvider {
  const c = input as unknown as Settings
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).sort().join() !== 'directory,drift,id,noise,reference,resource,seed,slope,tickMs' ||
    typeof c.id !== 'string' ||
    !/^[\w.-]+$/.test(c.id) ||
    typeof c.directory !== 'string' ||
    !c.directory ||
    typeof c.resource !== 'string' ||
    !c.resource ||
    !Number.isFinite(c.tickMs) ||
    c.tickMs < 1 ||
    ![c.reference, c.slope, c.drift, c.noise, c.seed].every(Number.isFinite) ||
    c.noise < 0
  )
    throw new Error('Invalid instrument configuration')
  const directory = resolve(c.directory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  // Open a short-lived device connection per call: the manager does not own the device journal.
  const open = (operation: ProviderOperation) => {
    const db = new DatabaseSync(join(directory, 'instrument.sqlite'))
    try {
      const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      if (version !== 0 && version !== 1) throw new Error('Unsupported instrument journal version')
      db.exec(
        'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS config(value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS samples(id INTEGER PRIMARY KEY, operation_id TEXT NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, identity TEXT NOT NULL, state TEXT NOT NULL, input TEXT NOT NULL, directory TEXT NOT NULL, readings TEXT NOT NULL, next_at REAL NOT NULL, cancel INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS starts(operation_id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS control_domain(id INTEGER PRIMARY KEY CHECK(id=1), root TEXT NOT NULL);',
      )
      mkdirSync(operation.artifactDirectory, { recursive: true, mode: 0o700 })
      const root = realpathSync(resolve(operation.artifactDirectory, '..'))
      db.exec('BEGIN IMMEDIATE')
      const current = db.prepare('SELECT value FROM config').get() as { value: string } | undefined
      const fingerprint = canonicalJson(input)
      if (current && current.value !== fingerprint)
        throw new Error('Instrument configuration changed; use a different device journal')
      if (!current) db.prepare('INSERT INTO config VALUES (?)').run(fingerprint)
      const owner = db.prepare('SELECT root FROM control_domain WHERE id=1').get() as
        | { root: string }
        | undefined
      if (owner && owner.root !== root) throw new Error('Device journal belongs to another management domain')
      db.exec('PRAGMA user_version=1; COMMIT')
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      db.close()
      throw error
    }
    return db
  }
  const claim = (db: DatabaseSync, operation: ProviderOperation) => {
    const root = realpathSync(resolve(operation.artifactDirectory, '..'))
    const owner = db.prepare('SELECT root FROM control_domain WHERE id=1').get() as
      | { root: string }
      | undefined
    if (owner && owner.root !== root) throw new Error('Device journal belongs to another management domain')
    if (!owner) {
      const historic = db.prepare('SELECT DISTINCT directory FROM operations').all() as {
        directory: string
      }[]
      if (historic.some((row) => realpathSync(resolve(row.directory, '..')) !== root))
        throw new Error('Existing device actions belong to another management domain')
      db.prepare('INSERT INTO control_domain VALUES (1,?)').run(root)
    }
  }
  const blocks = (value: Json): Block[] => {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).join() !== 'conditions' ||
      !Array.isArray(value.conditions) ||
      value.conditions.length < 1 ||
      value.conditions.length > 64
    )
      throw new Error('Expected conditions array (1..64 blocks)')
    const parsed = value.conditions.map((v) => {
      if (
        !v ||
        typeof v !== 'object' ||
        Array.isArray(v) ||
        Object.keys(v).sort().join() !== 'samples,value' ||
        typeof v.value !== 'number' ||
        !Number.isFinite(v.value) ||
        Math.abs(v.value) > 1 ||
        typeof v.samples !== 'number' ||
        !Number.isSafeInteger(v.samples) ||
        v.samples < 1 ||
        v.samples > 256
      )
        throw new Error('Condition [-1,1] and samples integer 1..256 required')
      return { value: v.value, samples: v.samples }
    })
    if (parsed.reduce((sum, b) => sum + b.samples, 0) > 4096)
      throw new Error('At most 4096 samples per operation')
    return parsed
  }
  const check = (r: Row, op: ProviderOperation) => {
    if (
      r.identity !==
      canonicalJson({
        projectId: op.projectId,
        input: op.input,
        artifactDirectory: realpathSync(op.artifactDirectory),
      })
    )
      throw new Error('Stable operation ID reused with different input or output destination')
  }
  const observe = (r: Row): ProviderObservation => {
    const readings: Reading[] = JSON.parse(r.readings)
    const terminal = r.state === 'succeeded' || r.state === 'cancelled'
    if (terminal) {
      mkdirSync(r.directory, { recursive: true, mode: 0o700 })
      for (const [filename, content] of [
        ['raw.json', JSON.stringify(readings, null, 2) + '\n'],
        [
          'raw.csv',
          'operationId,requestedCondition,appliedCondition,order,timestamp,value,unit\n' +
            readings
              .map((v) =>
                [
                  v.operationId,
                  v.requestedCondition,
                  v.appliedCondition,
                  v.order,
                  v.timestamp,
                  v.value,
                  v.unit,
                ].join(','),
              )
              .join('\n') +
            '\n',
        ],
      ]) {
        const path = join(r.directory, filename!)
        writeFileSync(path + '.tmp', content!, { mode: 0o600 })
        renameSync(path + '.tmp', path)
      }
    }
    return {
      state: r.state as 'running' | 'succeeded' | 'cancelled',
      progress: {
        samples: readings.length,
        total: blocks(JSON.parse(r.input)).reduce((n, b) => n + b.samples, 0),
      },
      ...(terminal
        ? {
            artifacts: [
              { path: 'raw.json', mediaType: 'application/json' },
              { path: 'raw.csv', mediaType: 'text/csv' },
            ],
          }
        : {}),
    }
  }
  return {
    describe: () => ({
      apiVersion: 1,
      id: c.id,
      version: '0.1.0',
      configuration: input,
      inputSchema: {
        type: 'object',
        required: ['conditions'],
        additionalProperties: false,
        properties: {
          conditions: {
            type: 'array',
            minItems: 1,
            maxItems: 64,
            items: {
              type: 'object',
              required: ['value', 'samples'],
              additionalProperties: false,
              properties: {
                value: { type: 'number', minimum: -1, maximum: 1 },
                samples: { type: 'integer', minimum: 1, maximum: 256 },
              },
            },
          },
        },
      },
      outputSchema: { type: 'array', items: { type: 'object' } },
      units: { value: 'signal-unit', condition: 'dimensionless', budget: 'sample' },
      constraints: [
        `Exclusive resource ${c.resource}`,
        'Device journal is permanently bound to the real parent of the first submitted operation artifact directory; another management domain is refused even while idle',
        'At most 4096 samples per operation',
        'Cooperative local execution: submit and query perform sampling; while no controller queries, sampling pauses; no unattended autonomous execution',
        'Each query acquires at most one sample after tickMs, never fabricates elapsed samples',
      ],
      completion:
        'All requested samples committed to device SQLite journal; immutable raw JSON/CSV published. Global order persists across projects and restarts.',
      cancellation:
        'Request acknowledged immediately; next query stops before any further sample and publishes partial data; closing manager is not cancellation.',
    }),
    prepare(value) {
      const b = blocks(value)
      return {
        input: { conditions: b.map((v) => ({ ...v })) },
        resources: [c.resource],
        budget: b.reduce((n, v) => n + v.samples, 0),
      }
    },
    async submit(op) {
      blocks(op.input)
      const db = open(op)
      try {
        db.exec('BEGIN IMMEDIATE')
        claim(db, op)
        let r = db.prepare('SELECT * FROM operations WHERE id=?').get(op.operationId) as unknown as
          | Row
          | undefined
        if (r) check(r, op)
        else {
          const busy = db.prepare("SELECT id FROM operations WHERE state='running'").get()
          if (busy) throw new Error('Device independently rejects conflicting operation')
          db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?,0)').run(
            op.operationId,
            canonicalJson({
              projectId: op.projectId,
              input: op.input,
              artifactDirectory: realpathSync(op.artifactDirectory),
            }),
            'running',
            canonicalJson(op.input),
            realpathSync(op.artifactDirectory),
            '[]',
            Date.now() + c.tickMs,
          )
          db.prepare('INSERT INTO starts VALUES (?)').run(op.operationId)
          r = db.prepare('SELECT * FROM operations WHERE id=?').get(op.operationId) as unknown as Row
        }
        db.exec('COMMIT')
        return observe(r)
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK')
        throw error
      } finally {
        db.close()
      }
    },
    async query(op) {
      const db = open(op)
      try {
        db.exec('BEGIN IMMEDIATE')
        let r = db.prepare('SELECT * FROM operations WHERE id=?').get(op.operationId) as unknown as
          | Row
          | undefined
        if (!r) {
          db.exec('COMMIT')
          return { state: 'not_found', detail: 'No operation in the independent device journal' }
        }
        check(r, op)
        if (r.state === 'running') {
          const readings: Reading[] = JSON.parse(r.readings)
          const values = blocks(JSON.parse(r.input)).flatMap((b) => Array<number>(b.samples).fill(b.value))
          if (r.cancel) r.state = 'cancelled'
          else if (Date.now() >= r.next_at) {
            const count = db.prepare('SELECT COUNT(*) AS n FROM samples').get() as { n: number }
            const order = count.n + 1
            const value = values[readings.length]!
            const noise =
              ((createHash('sha256').update(`${c.seed}:${order}`).digest().readUInt32LE(0) / 0xffffffff) * 2 -
                1) *
              c.noise
            const sample: Reading = {
              operationId: op.operationId,
              requestedCondition: value,
              appliedCondition: value,
              order,
              timestamp: new Date().toISOString(),
              value: c.reference + c.slope * value + c.drift * order + noise,
              unit: 'signal-unit',
            }
            db.prepare('INSERT INTO samples VALUES (?,?,?)').run(
              order,
              op.operationId,
              JSON.stringify(sample),
            )
            readings.push(sample)
            r.readings = JSON.stringify(readings)
            r.next_at = Date.now() + c.tickMs
            if (readings.length === values.length) r.state = 'succeeded'
          }
          db.prepare('UPDATE operations SET state=?,readings=?,next_at=? WHERE id=?').run(
            r.state,
            r.readings,
            r.next_at,
            op.operationId,
          )
        }
        db.exec('COMMIT')
        return observe(r)
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK')
        throw error
      } finally {
        db.close()
      }
    },
    async cancel(op) {
      const db = open(op)
      try {
        const r = db.prepare('SELECT * FROM operations WHERE id=?').get(op.operationId) as unknown as
          | Row
          | undefined
        if (!r) return { disposition: 'rejected', detail: 'Unknown device operation' }
        check(r, op)
        if (r.state !== 'running')
          return { disposition: 'rejected', observation: observe(r), detail: 'Already terminal' }
        db.prepare('UPDATE operations SET cancel=1 WHERE id=?').run(op.operationId)
        return {
          disposition: 'requested',
          detail: 'Next device query performs cancellation and publishes partial samples',
        }
      } finally {
        db.close()
      }
    },
  }
}
