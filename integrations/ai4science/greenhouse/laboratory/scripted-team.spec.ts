/** A complete native team chain uses public replies, real Router messages and cross-project references. */
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { writeFileSync, cpSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { boot, type Probe } from '../../platform/organization-fixture.ts'
import { laboratoryFixture } from './fixture.ts'
import { laboratoryPolicy } from './scripted-policy.ts'
import { mountLaboratoryAgents } from './agents.ts'
const probes: Probe[] = []
afterEach(async () => { for (const probe of probes.splice(0)) await probe.close() })
it('completes preparation, peer confirmation and dependent-project work with actual reference reads', async () => {
  const probe = await boot('laboratory-scripted-team-chain', true, async () => ({ withoutScience: true })); probes.push(probe)
  const scenario = laboratoryFixture(); scenario.externalReferences = true
  scenario.devices.find(device => device.id === 'heater')!.capacity = 8
  scenario.devices.find(device => device.id === 'cold')!.capacity = 8
  scenario.samples[0]!.volumeUl = 500
  scenario.samples.push({ ...scenario.samples[0]!, id: 'dependent-water', projectId: 'P2' })
  scenario.projects.push({ id: 'P2', title: 'Dependent project' })
  scenario.tasks = [
    { id: 'prepare-water', title: 'Prepare water', projectId: 'P1', methodId: 'prepare', methodVersion: 1, rootSampleIds: ['water'], requiredResults: 1, prerequisites: [], releaseTick: 0 },
    { id: 'confirm-water', title: 'Confirm water', projectId: 'P1', methodId: 'confirm', methodVersion: 1, rootSampleIds: ['water'], requiredResults: 1, prerequisites: ['prepare-water'], releaseTick: 0 },
    { id: 'dependent-prepare', title: 'Dependent preparation', projectId: 'P2', methodId: 'prepare', methodVersion: 1, rootSampleIds: ['dependent-water'], requiredResults: 1, prerequisites: ['confirm-water'], releaseTick: 0 },
  ]
  const file = join(probe.root, 'scenario.json'); writeFileSync(file, JSON.stringify(scenario))
  for (const role of ['lead', 'facilities', 'experiments', 'quality']) {
    const policy = laboratoryPolicy(role, 'multi-agent')
    const script = (options: GenerateOptions): StreamChunk[] => { probe.model.queue(role, script); return policy(options) }
    probe.model.queue(role, script)
  }
  const directory = join(probe.root, 'run')
  const team = await mountLaboratoryAgents(probe.ctx, { directory, scenarioFile: file, seed: 1, project: 'cross-branch-project',
    mode: 'multi-agent', source: 'scripted', providerPool: ['teams-probe'], model: { provider: 'teams-probe', model: 'fixture' }, port: 0, refreshMs: 100, providerCallTimeoutMs: 1000 })
  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (team.metrics.modelErrors || team.metrics.toolErrors || team.runtime.clock.status().failure) {
        clearInterval(timer); reject(new Error('Scripted native team failed; inspect retained evidence')); return
      }
      if (team.runtime.world.observe().deliveries.filter(delivery => delivery.valid).length === 3 && team.team.snapshot().tasks.every(task => task.status === 'done')) {
        clearInterval(timer); resolve()
      }
    }, 20)
    probe.ctx.effect(() => () => clearInterval(timer), 'laboratory.team-check')
  })
  const state = team.runtime.world.observe()
  const confirmation = state.deliveries.find(delivery => delivery.taskId === 'confirm-water' && delivery.valid)!
  expect(state.deliveries.find(delivery => delivery.taskId === 'dependent-prepare')!.referenceResultIds).toEqual(confirmation.resultIds)
  expect(team.team.snapshot().tasks.some(task => task.assignee === 'quality')).toBe(true)
  await vi.waitFor(async () => {
    await probe.ctx.sessionPersistence.flush()
    const observed = spawnSync('python3', ['integrations/ai4science/greenhouse/laboratory/evaluate.py', directory, '--sessions', join(probe.root, 'sessions')], { encoding: 'utf8' })
    const report = JSON.parse(observed.stdout)
    expect(report.checks.find((check: { name: string }) => check.name === 'latest_completion_notices_reached_owner_response').passed).toBe(true)
  }, { timeout: 5000, interval: 100 })
  await team.close(); await probe.ctx.sessionPersistence.flush()
  const evaluated = spawnSync('python3', ['integrations/ai4science/greenhouse/laboratory/evaluate.py', directory, '--sessions', join(probe.root, 'sessions')], { encoding: 'utf8' })
  expect(evaluated.status, evaluated.stdout + evaluated.stderr).toBe(0)
  expect(JSON.parse(evaluated.stdout)).toMatchObject({ success: true, source: 'scripted', mode: 'multi-agent', validDeliveries: 3 })
  const copiedSessions = join(probe.root, 'missing-cross-reference-read')
  cpSync(join(probe.root, 'sessions'), copiedSessions, { recursive: true })
  const experimentMember = team.team.snapshot().members.find(member => member.name === 'experiments')!
  const sessionPath = join(copiedSessions, '_no-cwd', experimentMember.id, 'session.v4.jsonl')
  const rows = readFileSync(sessionPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const confirmationOperation = state.results.find(result => confirmation.resultIds.includes(result.id))!.operationId
  const readCalls = new Set(rows.filter(row => row.type === 'tool/call' && row.data.name === 'laboratory_result' &&
    JSON.parse(row.data.arguments).operation_id === confirmationOperation).map(row => row.data.callId))
  expect(readCalls.size).toBeGreaterThan(0)
  writeFileSync(sessionPath, rows.filter(row => !(row.type === 'tool/result' && readCalls.has(row.data.message.toolCallId)))
    .map(row => JSON.stringify(row)).join('\n') + '\n')
  const missingRead = spawnSync('python3', ['integrations/ai4science/greenhouse/laboratory/evaluate.py', directory, '--sessions', copiedSessions], { encoding: 'utf8' })
  expect(missingRead.status).toBe(1)
  expect(JSON.parse(missingRead.stdout).checks.find((check: { name: string }) => check.name === 'verified_reads_precede_actual_native_deliveries').passed).toBe(false)

})
