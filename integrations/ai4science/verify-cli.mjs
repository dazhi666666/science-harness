/** Launch two real dsh CLI processes and assert durable cross-process result delivery. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const home = mkdtempSync(join(here, 'evidence/cli-verified-'))
const commands = []
function run(task, resultId) {
  const args = ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'headless',
    '--patch', join(here, 'science.patch.yml'), '--patch', join(here, 'mock.patch.yml'), task]
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
  delete env.AI4S_PROBE_RESULT_ID
  if (resultId) env.AI4S_PROBE_RESULT_ID = resultId
  commands.push({ command: process.execPath, args, DSH_HOME: home, resultId: resultId ?? null })
  const result = spawnSync(process.execPath, args, { cwd: repo, env, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(join(home, resultId ? 'read.log' : 'delegate.log'), result.stdout + result.stderr)
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const jsonLine = result.stdout.trim().split('\n').findLast(line => line.startsWith('{'))
  assert.ok(jsonLine, 'CLI must print a JSON result')
  return JSON.parse(jsonLine)
}
function logs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? logs(path) : path.endsWith('.jsonl') ? [path] : []
  })
}
const delegated = run('Summarize observations [1,2,3] and return the saved result')
assert.equal(delegated.stopReason, 'completed')
const measurement = JSON.parse(delegated.output)
assert.equal(measurement.mean, 2)
assert.equal(measurement.callerSessionId, delegated.childId)
assert.deepEqual(measurement.samples, [1, 2, 3])
const read = run('Read the previously saved observation summary', measurement.id)
assert.deepEqual(read, measurement)
const files = logs(join(home, 'sessions'))
assert.equal(files.length, 3, 'one parent, one child and a fresh reader session')
const transcripts = files.map(path => ({ path, text: readFileSync(path, 'utf8') }))
assert.ok(transcripts.every(log => log.text.includes(measurement.id)), 'all three logs must reference the same result')
assert.ok(readFileSync(join(home, 'storages/ai4science_minimal.json'), 'utf8').includes(measurement.id))
const report = { status: 'passed', processes: 2, measurement, sessions: files, commands }
writeFileSync(join(here, 'evidence/cli-verification.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
