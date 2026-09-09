/** Small copyable Provider. The public SDK is its only non-Node dependency. */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, realpathSync, writeFileSync, linkSync, unlinkSync, readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { canonicalJson } from '@ai4science/provider-sdk'
import { inputSchema, validateInput, transform } from './workload.mjs'

// When changing behavior, bump this value and package.json together.
const PROVIDER_VERSION = '0.1.0'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** CUSTOMIZE HERE: keep deployment settings separate from operation inputs. */
export function createProvider(config) {
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).sort().join() !== 'directory,id,resource' ||
    typeof config.id !== 'string' ||
    !/^[\w.-]+$/.test(config.id) ||
    typeof config.directory !== 'string' ||
    !config.directory ||
    typeof config.resource !== 'string' ||
    !config.resource
  )
    throw new Error('Expected provider id, directory and exclusive resource')
  mkdirSync(resolve(config.directory), { recursive: true, mode: 0o700 })
  const settings = { ...config, directory: realpathSync(resolve(config.directory)), version: PROVIDER_VERSION }

  function open() {
    const db = new DatabaseSync(join(settings.directory, 'example.sqlite'))
    try {
      db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      const version = db.prepare('PRAGMA user_version').get().user_version
      if (version !== 0 && version !== 1) throw new Error('Unsupported example journal version')
      db.exec(`CREATE TABLE IF NOT EXISTS configuration(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS domain(id INTEGER PRIMARY KEY CHECK(id=1),root TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,identity TEXT NOT NULL,directory TEXT NOT NULL,state TEXT NOT NULL,detail TEXT,artifacts TEXT);
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL,kind TEXT NOT NULL,at TEXT NOT NULL);
        PRAGMA user_version=1;`)
      transaction(db, () => {
        const prior = db.prepare('SELECT value FROM configuration WHERE id=1').get()
        if (prior && prior.value !== canonicalJson(settings))
          throw new Error('Example journal configuration changed')
        if (!prior) db.prepare('INSERT INTO configuration VALUES (1,?)').run(canonicalJson(settings))
      })
      return db
    } catch (error) {
      db.close()
      throw error
    }
  }
  function transaction(db, body) {
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
  function operation(value) {
    if (
      !value ||
      typeof value.operationId !== 'string' ||
      !value.operationId ||
      value.operationId.length > 128 ||
      typeof value.projectId !== 'string' ||
      !value.projectId ||
      typeof value.artifactDirectory !== 'string' ||
      !value.artifactDirectory
    )
      throw new Error('Invalid operation identity')
    const input = validateInput(value.input)
    mkdirSync(resolve(value.artifactDirectory), { recursive: true, mode: 0o700 })
    const directory = realpathSync(resolve(value.artifactDirectory))
    return {
      ...value,
      input,
      artifactDirectory: directory,
      identity: canonicalJson({ projectId: value.projectId, input, artifactDirectory: directory }),
    }
  }
  function lookup(db, op) {
    const owner = db.prepare('SELECT root FROM domain WHERE id=1').get()
    if (owner && owner.root !== dirname(op.artifactDirectory))
      throw new Error('Journal belongs to another management domain')
    const row = db.prepare('SELECT * FROM operations WHERE id=?').get(op.operationId)
    if (row && row.identity !== op.identity)
      throw new Error('Stable operation ID reused with different identity')
    return row
  }
  function observe(row) {
    if (!row) return { state: 'not_found', detail: 'No operation in the Provider journal' }
    if (row.state !== 'succeeded')
      return {
        state: 'unknown',
        detail: row.detail || 'Registered operation has no confirmed completion; do not replay',
      }
    const artifacts = JSON.parse(row.artifacts)
    try {
      for (const artifact of artifacts) {
        const data = readFileSync(join(row.directory, artifact.path))
        if (hash(data) !== artifact.sha256) throw new Error('Published artifact changed')
      }
    } catch (error) {
      return { state: 'unknown', detail: 'Artifact integrity could not be confirmed: ' + String(error) }
    }
    return {
      state: 'succeeded',
      progress: { processed: true },
      artifacts: artifacts.map(({ path, mediaType }) => ({ path, mediaType })),
    }
  }
  function record(db, id, kind) {
    db.prepare('INSERT INTO events(operation_id,kind,at) VALUES (?,?,?)').run(
      id,
      kind,
      new Date().toISOString(),
    )
  }
  const initialized = open()
  initialized.close()
  return {
    /** CUSTOMIZE HERE: describe real supported behavior, including unsupported cancellation. */
    describe: () => ({
      apiVersion: 1,
      id: settings.id,
      version: PROVIDER_VERSION,
      configuration: settings,
      inputSchema,
      outputSchema: {
        type: 'object',
        properties: { values: { type: 'array', items: { type: 'number' } }, summary: { type: 'object' } },
      },
      units: { values: 'arbitrary unit', budget: 'input item' },
      constraints: [
        `Exclusive resource ${settings.resource}`,
        'At most 10000 input items per synchronous operation',
        'One management-domain binding per journal',
        'No external processes, arbitrary code, network calls or physical devices',
      ],
      completion:
        'All bounded transformation work finished; JSON/CSV bytes and hashes committed to the Provider journal.',
      cancellation:
        'This short synchronous operation cannot be interrupted. Completed operations reject cancellation; an unconfirmed operation reports unsupported and remains unknown.',
    }),
    prepare(value) {
      const input = validateInput(value)
      return { input, resources: [settings.resource], budget: input.values.length }
    },
    async submit(value) {
      const op = operation(value),
        db = open()
      try {
        let prior
        transaction(db, () => {
          prior = lookup(db, op)
          if (prior) return
          if (db.prepare("SELECT id FROM operations WHERE state!='succeeded'").get())
            throw new Error('Unconfirmed work still occupies the example resource')
          db.prepare('INSERT OR IGNORE INTO domain VALUES (1,?)').run(dirname(op.artifactDirectory))
          // Register before business work. A crash cannot turn a retry into a second invocation.
          db.prepare('INSERT INTO operations(id,identity,directory,state) VALUES (?,?,?,?)').run(
            op.operationId,
            op.identity,
            op.artifactDirectory,
            'unknown',
          )
          record(db, op.operationId, 'registered')
        })
        if (prior) return observe(prior)
        try {
          const result = transform(op.input)
          record(db, op.operationId, 'workload-completed')
          // CUSTOMIZE HERE: publish new immutable artifacts; never overwrite existing output.
          const outputs = [
            ['result.json', JSON.stringify(result, null, 2) + '\n', 'application/json'],
            [
              'result.csv',
              'index,input,output\n' +
                result.values.map((v, i) => `${i},${op.input.values[i]},${v}`).join('\n') +
                '\n',
              'text/csv',
            ],
          ]
          const artifacts = []
          for (const [name, content, mediaType] of outputs) {
            const path = join(op.artifactDirectory, name),
              temporary = path + '.' + randomUUID() + '.tmp'
            // Exclusive final publication uses a hard link; an existing result is never replaced.
            writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' })
            linkSync(temporary, path)
            unlinkSync(temporary)
            artifacts.push({ path: name, mediaType, sha256: hash(Buffer.from(content)) })
          }
          transaction(db, () => {
            db.prepare("UPDATE operations SET state='succeeded',artifacts=? WHERE id=?").run(
              JSON.stringify(artifacts),
              op.operationId,
            )
            record(db, op.operationId, 'published')
          })
        } catch (error) {
          db.prepare('UPDATE operations SET detail=? WHERE id=?').run(String(error), op.operationId)
          record(db, op.operationId, 'unconfirmed')
        }
        return observe(lookup(db, op))
      } finally {
        db.close()
      }
    },
    async query(value) {
      const op = operation(value),
        db = open()
      try {
        return observe(lookup(db, op))
      } finally {
        db.close()
      }
    },
    async cancel(value) {
      const op = operation(value),
        db = open()
      try {
        const row = lookup(db, op)
        return row
          ? {
              disposition: row.state === 'succeeded' ? 'rejected' : 'unsupported',
              observation: observe(row),
              detail: 'No interruptible worker exists; cancellation does not change recorded state',
            }
          : { disposition: 'rejected', detail: 'Unknown operation' }
      } finally {
        db.close()
      }
    },
  }
}
