/** Independent Python verification rejects corrupted artifacts, native read order and physical lineage. */
import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { boot, Gate, type Probe } from '../../platform/organization-fixture.ts'
import { laboratoryFixture } from './fixture.ts'
import { laboratoryPolicy } from './scripted-policy.ts'
import { mountLaboratoryAgents } from './agents.ts'
const probes: Probe[] = []
afterEach(async () => { for (const probe of probes.splice(0)) await probe.close() })
it('verifies a real native phase and independently rejects altered evidence in private copies', async () => {
  const probe = await boot('laboratory-evaluator-native-phase', true, async () => ({ withoutScience: true })); probes.push(probe)
  const scenario = laboratoryFixture(); scenario.samples[0]!.location = 'heater'
  scenario.tasks.push({ id: 'prepare-water', title: 'Prepare water', projectId: 'P1', methodId: 'prepare', methodVersion: 1,
    rootSampleIds: ['water'], requiredResults: 1, prerequisites: [], releaseTick: 0 })
  const file = join(probe.root, 'scenario.json'); writeFileSync(file, JSON.stringify(scenario))
  const policy = laboratoryPolicy('lead', 'single-agent')
  const script = (options: GenerateOptions): StreamChunk[] => { probe.model.queue('lead', script); return policy(options) }
  probe.model.queue('lead', script)
  const directory = join(probe.root, 'run')
  const team = await mountLaboratoryAgents(probe.ctx, { directory, scenarioFile: file, seed: 1, project: 'cross-branch-project',
    mode: 'single-agent', source: 'scripted', providerPool: ['teams-probe'], model: { provider: 'teams-probe', model: 'fixture' }, port: 0, refreshMs: 100, providerCallTimeoutMs: 1000 })
  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (team.metrics.modelErrors || team.metrics.toolErrors) { clearInterval(timer); reject(new Error('Scripted phase failed')); return }
      if (team.team.snapshot().tasks[0]?.status === 'done') { clearInterval(timer); resolve() }
    }, 20)
    probe.ctx.effect(() => () => clearInterval(timer), 'laboratory.evaluator-test')
  })
  const originalSamples = team.runtime.world.observe().samples
  await team.close()
  await probe.ctx.sessionPersistence.flush()
  const evaluate = (path: string, sessions = join(probe.root, 'sessions'), offline = false) => {
    const process = spawnSync('python3', ['integrations/ai4science/greenhouse/laboratory/evaluate.py', path, '--sessions', sessions, ...(offline ? ['--offline'] : [])], { encoding: 'utf8' })
    return { status: process.status, report: JSON.parse(process.stdout) }
  }
  expect(evaluate(directory)).toMatchObject({ status: 0, report: { success: true, validDeliveries: 1, source: 'scripted' } })
  // Copy closed, checkpointed state and sessions; corruption never touches original run evidence.
  await team.runtime.close()
  const copy = join(probe.root, 'corrupt-copy'); cpSync(directory, copy, { recursive: true })
  const db = new DatabaseSync(join(copy, 'execution', 'execution.sqlite'))
  const artifact = db.prepare('SELECT path FROM artifacts LIMIT 1').get() as { path: string }
  db.close()
  writeFileSync(join(copy, 'execution', artifact.path), 'tampered')
  const hashFailure = evaluate(copy, join(probe.root, 'sessions'), true)
  expect(hashFailure.status).toBe(1)
  expect(hashFailure.report.checks.find((check: { name: string }) => check.name === 'immutable_artifact_hashes_and_measurements').passed).toBe(false)
  cpSync(directory, copy, { recursive: true, force: true })
  const devices = new DatabaseSync(join(copy, 'device', 'laboratory.sqlite'))
  const state = JSON.parse((devices.prepare('SELECT state FROM world WHERE id=1').get() as { state: string }).state)
  state.results[0].rootSampleId = 'invented-root'
  devices.prepare('UPDATE world SET state=? WHERE id=1').run(JSON.stringify(state)); devices.close()
  expect(evaluate(copy, join(probe.root, 'sessions'), true).status).toBe(1)
  const sessionsCopy = join(probe.root, 'sessions-copy'); cpSync(join(probe.root, 'sessions'), sessionsCopy, { recursive: true })
  const sessionPath = join(sessionsCopy, '_no-cwd', team.root.id, 'session.v4.jsonl')
  const rows = readFileSync(sessionPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const readCalls = new Set(rows.filter(row => row.type === 'tool/call' && row.data.name === 'laboratory_result').map(row => row.data.callId))
  writeFileSync(sessionPath, rows.filter(row => !(row.type === 'tool/result' && readCalls.has(row.data.message.toolCallId))).map(row => JSON.stringify(row)).join('\n') + '\n')
  expect(evaluate(directory, sessionsCopy, true).report.checks.find((check: { name: string }) => check.name === 'verified_reads_precede_actual_native_deliveries').passed).toBe(false)
  expect(originalSamples.reduce((sum, sample) => sum + sample.volumeUl, 0)).toBe(100)
})

it('distinguishes an irrecoverable physical loss from corrupted evidence in an actual native run', async () => {
  const probe = await boot('laboratory-terminal-material-loss', true, async () => ({ withoutScience: true })); probes.push(probe)
  const scenario = laboratoryFixture(); scenario.samples[0]!.location = 'heater'
  scenario.faults.push({ id: 'processing-fault', tick: 2, deviceId: 'heater' })
  scenario.tasks.push({ id: 'prepare-water', title: 'Prepare water', projectId: 'P1', methodId: 'prepare', methodVersion: 1,
    rootSampleIds: ['water'], requiredResults: 1, prerequisites: [], releaseTick: 0 })
  const file = join(probe.root, 'terminal-scenario.json'); writeFileSync(file, JSON.stringify(scenario))
  const policy = laboratoryPolicy('lead', 'single-agent')
  const script = (options: GenerateOptions): StreamChunk[] => { probe.model.queue('lead', script); return policy(options) }
  probe.model.queue('lead', script)
  const directory = join(probe.root, 'run')
  const team = await mountLaboratoryAgents(probe.ctx, { directory, scenarioFile: file, seed: 1, project: 'cross-branch-project',
    mode: 'single-agent', source: 'scripted', providerPool: ['teams-probe'], model: { provider: 'teams-probe', model: 'fixture' }, port: 0, refreshMs: 100, providerCallTimeoutMs: 1000 })
  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      const state = team.runtime.world.observe()
      if (state.operations.some(operation => operation.state === 'failed') && state.samples[0]!.volumeUl === 0) { clearInterval(timer); resolve() }
      else if (team.runtime.clock.status().failure) { clearInterval(timer); reject(new Error('Physical clock failed before the material-loss event')) }
    }, 20)
    probe.ctx.effect(() => () => clearInterval(timer), 'laboratory.terminal-outcome-test')
  })
  const failed = team.runtime.world.observe().operations.find(operation => operation.state === 'failed')!
  await team.runtime.engine.query(team.runtime.engine.issueContext('P1', 'terminal-observer', ['laboratory']), failed.id)
  await vi.waitFor(async () => {
    await probe.ctx.sessionPersistence.flush()
    const observed = spawnSync('python3', ['integrations/ai4science/greenhouse/laboratory/evaluate.py', directory, '--sessions', join(probe.root, 'sessions')], { encoding: 'utf8' })
    expect(JSON.parse(observed.stdout).evidenceValid).toBe(true)
  }, { timeout: 5000, interval: 50 })
  await team.close(); await probe.ctx.sessionPersistence.flush()
  const result = spawnSync('python3', ['integrations/ai4science/greenhouse/laboratory/evaluate.py', directory, '--sessions', join(probe.root, 'sessions')], { encoding: 'utf8' })
  expect(result.status, result.stdout + result.stderr).toBe(1)
  expect(JSON.parse(result.stdout)).toMatchObject({ success: false, evidenceValid: true, validDeliveries: 0,
    outcome: { terminal: true, status: 'irrecoverable-material-loss', potentiallyRecoverableTasks: [] } })
})


it('records autonomous completion before operator preparation separately from assisted native completion', async () => {
  const probe = await boot('laboratory-operator-assisted-phase', true, async () => ({ withoutScience: true })); probes.push(probe)
  const scenario = laboratoryFixture(); scenario.samples[0]!.location = 'heater'
  scenario.tasks.push({ id: 'prepare-water', title: 'Prepare water', projectId: 'P1', methodId: 'prepare', methodVersion: 1,
    rootSampleIds: ['water'], requiredResults: 1, prerequisites: [], releaseTick: 0 })
  const file = join(probe.root, 'assisted-scenario.json'); writeFileSync(file, JSON.stringify(scenario))
  const gate = new Gate(), policy = laboratoryPolicy('lead', 'single-agent')
  const script = (options: GenerateOptions): StreamChunk[] => { probe.model.queue('lead', script); return policy(options) }
  probe.model.queue('lead', gate.step(), script)
  const directory = join(probe.root, 'run')
  const team = await mountLaboratoryAgents(probe.ctx, { directory, scenarioFile: file, seed: 1, project: 'cross-branch-project',
    mode: 'single-agent', source: 'scripted', providerPool: ['teams-probe'], model: { provider: 'teams-probe', model: 'fixture' }, port: 0, refreshMs: 100, providerCallTimeoutMs: 1000 })
  const operator = team.runtime.engine.issueContext('P1', 'laboratory-operator', ['laboratory'])
  const accepted = await team.runtime.engine.submit(operator, { providerId: 'laboratory', requestKey: 'operator-prepare',
    input: { action: 'process', deviceId: 'heater', sampleId: 'water', volumeUl: 20, methodId: 'prepare', methodVersion: 1 } })
  // The gate freezes model generation; explicit device events isolate external assistance accounting.
  while (team.runtime.world.operation(accepted.id)!.state === 'running') team.runtime.world.advance()
  expect((await team.runtime.engine.query(operator, accepted.id)).state).toBe('succeeded')
  gate.release()
  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (team.metrics.modelErrors || team.metrics.toolErrors) { clearInterval(timer); reject(new Error('Native assisted phase failed')); return }
      if (team.team.snapshot().tasks[0]?.status === 'done') { clearInterval(timer); resolve() }
    }, 20)
    probe.ctx.effect(() => () => clearInterval(timer), 'laboratory.assistance-test')
  })
  await team.close(); await probe.ctx.sessionPersistence.flush()
  const result = spawnSync('python3', ['integrations/ai4science/greenhouse/laboratory/evaluate.py', directory, '--sessions', join(probe.root, 'sessions')], { encoding: 'utf8' })
  expect(result.status, result.stdout + result.stderr).toBe(1)
  expect(JSON.parse(result.stdout)).toMatchObject({ success: false, evidenceValid: true, workflowCompleted: true, completionRate: 1,
    operatorSubmittedOperations: 1, assistance: { used: true, interventionCount: 1, autonomousPhaseClosed: true, autonomousValidDeliveries: 0,
      autonomousCompletionRate: 0, completionRateAfterAssistance: 1, operatorOperationIds: [accepted.id] } })
  await team.runtime.close()
  const copy = join(probe.root, 'missing-intervention-event'); cpSync(directory, copy, { recursive: true })
  const devices = new DatabaseSync(join(copy, 'device', 'laboratory.sqlite'))
  devices.prepare("DELETE FROM events WHERE kind IN ('operation-accepted','operation-refused') AND json_extract(payload,'$.id')=?").run(accepted.id)
  devices.close()
  const missing = spawnSync('python3', ['integrations/ai4science/greenhouse/laboratory/evaluate.py', copy, '--sessions', join(probe.root, 'sessions'), '--offline'], { encoding: 'utf8' })
  const corrupted = JSON.parse(missing.stdout)
  expect(corrupted.evidenceValid).toBe(false)
  expect(corrupted.checks.find((check: { name: string }) => check.name === 'operator_interventions_have_device_event_boundaries').passed).toBe(false)
})
