/** Runs with node --test after installing this copied package and the public SDK. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { validateProvider } from '@ai4science/provider-sdk'
import { verifyStableSubmission } from '@ai4science/provider-sdk/testing'
import { createProvider } from '../src/index.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'provider-example-'))
  const config = { id: 'example', directory: join(root, 'device'), resource: 'example-data' }
  const operation = {
    operationId: 'one',
    projectId: 'project',
    input: { values: [1, 2, 3], scale: 2, offset: 1 },
    artifactDirectory: join(root, 'domain', 'artifacts', 'one'),
  }
  const count = () => {
    const db = new DatabaseSync(join(config.directory, 'example.sqlite'))
    try {
      return db.prepare("SELECT COUNT(*) n FROM events WHERE kind='workload-completed'").get().n
    } finally {
      db.close()
    }
  }
  return {
    root,
    config,
    operation,
    count,
    create: () => validateProvider(createProvider(config)),
    close: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('transforms data, publishes both artifact formats and deduplicates across adapter recreation', async () => {
  const f = fixture()
  try {
    const result = await verifyStableSubmission(f.create, f.operation, f.count)
    assert.equal(result.state, 'succeeded')
    assert.equal(f.count(), 1)
    assert.deepEqual(JSON.parse(readFileSync(join(f.operation.artifactDirectory, 'result.json'), 'utf8')), {
      values: [3, 5, 7],
      summary: { count: 3, min: 3, max: 7, mean: 5 },
    })
    assert.equal(
      readFileSync(join(f.operation.artifactDirectory, 'result.csv'), 'utf8'),
      'index,input,output\n0,1,3\n1,2,5\n2,3,7\n',
    )
    const fresh = f.create()
    const cancelled = await fresh.cancel(f.operation)
    assert.equal(cancelled.disposition, 'rejected')
    assert.equal(cancelled.observation.state, 'succeeded')
    assert.equal((await fresh.query(f.operation)).state, 'succeeded')
    assert.equal(f.count(), 1)
  } finally {
    f.close()
  }
})

test('validates input and stable identity and never grants another domain access', async () => {
  const f = fixture()
  try {
    const p = f.create()
    assert.throws(() => p.prepare({ values: [Infinity], scale: 1, offset: 0 }))
    assert.throws(() => p.prepare({ values: Array(2), scale: 1, offset: 0 }))
    assert.throws(() => p.prepare({ values: [], scale: 1, offset: 0 }))
    assert.throws(() => p.prepare({ ...f.operation.input, extra: true }))
    assert.equal((await p.query(f.operation)).state, 'not_found')
    await p.submit(f.operation)
    await assert.rejects(p.submit({ ...f.operation, input: { ...f.operation.input, offset: 2 } }), /identity/)
    await assert.rejects(p.query({ ...f.operation, projectId: 'other' }), /identity/)
    await assert.rejects(
      p.query({ ...f.operation, artifactDirectory: join(f.root, 'other-domain', 'artifacts', 'one') }),
      /another management domain/,
    )
    assert.equal(f.count(), 1)
  } finally {
    f.close()
  }
})

test('publication failure stays unknown, is not replayed and does not pretend cancellation succeeded', async () => {
  const f = fixture()
  try {
    mkdirSync(join(f.operation.artifactDirectory, 'result.json'), { recursive: true })
    const p = f.create()
    assert.equal((await p.submit(f.operation)).state, 'unknown')
    assert.equal(f.count(), 1)
    const fresh = f.create()
    assert.equal((await fresh.submit(f.operation)).state, 'unknown')
    assert.equal(f.count(), 1)
    const cancelled = await fresh.cancel(f.operation)
    assert.equal(cancelled.disposition, 'unsupported')
    assert.equal(cancelled.observation.state, 'unknown')
    await assert.rejects(
      fresh.submit({
        ...f.operation,
        operationId: 'two',
        artifactDirectory: join(f.root, 'domain', 'artifacts', 'two'),
      }),
      /occupies/,
    )
  } finally {
    f.close()
  }
})

test('changed result bytes fail integrity checks without redoing the workload', async () => {
  const f = fixture()
  try {
    const p = f.create()
    await p.submit(f.operation)
    writeFileSync(join(f.operation.artifactDirectory, 'result.json'), 'changed')
    assert.equal((await p.query(f.operation)).state, 'unknown')
    assert.equal((await p.submit(f.operation)).state, 'unknown')
    assert.equal(f.count(), 1)
  } finally {
    f.close()
  }
})
