/** Irrecoverable outcomes require physical impossibility rather than elapsed time or model consumption. */
import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
function fixture() {
  return { scenario: { faults: [] as { id: string }[], revisions: [] }, state: { tick: 5,
    samples: [{ id: 'root', state: 'raw', volumeUl: 100, disposition: 'available', expiresAt: 100 }],
    deliveries: [] as { taskId: string; valid: boolean }[], revocations: [], operations: [] as { id: string; state: string;
      command?: { action: string; sampleId: string; methodId?: string; methodVersion?: number } }[],
    appliedFaults: [], appliedRevisions: [], methods: [{ id: 'screen', version: 1, inputState: 'raw', outputState: 'screened' }],
    tasks: [{ id: 'T1', projectId: 'P1', methodId: 'screen', methodVersion: 1, rootSampleIds: ['root'], requiredResults: 1, prerequisites: [] as string[] }] }, verified: {} as Record<string, unknown> }
}
function classify(value: unknown) {
  const script = `import json,sys
sys.path.insert(0,'integrations/ai4science/greenhouse/laboratory')
from outcomes import classify
v=json.load(sys.stdin)
print(json.dumps(classify(v['scenario'],v['state'],v['verified'])))`
  const result = spawnSync('python3', ['-c', script], { input: JSON.stringify(value), encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout)
}
it('continues while valid material or in-flight physical work could satisfy a phase', () => {
  const input = fixture()
  expect(classify(input)).toMatchObject({ terminal: false, potentiallyRecoverableTasks: ['T1'] })
  input.state.samples[0]!.volumeUl = 0
  input.state.operations.push({ id: 'in-flight', state: 'running', command: { action: 'process', sampleId: 'root', methodId: 'screen', methodVersion: 1 } })
  expect(classify(input)).toMatchObject({ terminal: false, potentiallyRecoverableTasks: ['T1'], unrecoverableTasks: [] })
  input.state.methods.push({ id: 'confirm', version: 1, inputState: 'screened', outputState: 'confirmed' })
  input.state.tasks.push({ ...input.state.tasks[0]!, id: 'T2', methodId: 'confirm', prerequisites: ['T1'] })
  expect(classify(input)).toMatchObject({ terminal: false, potentiallyRecoverableTasks: ['T1', 'T2'], unrecoverableTasks: [] })
  input.state.operations[0]!.state = 'failed'
  expect(classify(input)).toMatchObject({ terminal: true, status: 'irrecoverable-material-loss' })
  const aliquot = fixture(); aliquot.state.samples[0]!.volumeUl = 0
  aliquot.state.operations.push({ id: 'aliquot-in-flight', state: 'running', command: { action: 'aliquot', sampleId: 'root' } })
  expect(classify(aliquot)).toMatchObject({ terminal: false, potentiallyRecoverableTasks: ['T1'], unrecoverableTasks: [] })
})
it('identifies total material loss and dependent phases using current method reachability', () => {
  const input = fixture(); input.state.samples[0]!.volumeUl = 0
  input.state.tasks.push({ ...input.state.tasks[0]!, id: 'T2', prerequisites: ['T1'] })
  expect(classify(input)).toMatchObject({ terminal: true, status: 'irrecoverable-material-loss', potentiallyRecoverableTasks: [] })
  input.state.samples[0]!.volumeUl = 100; input.state.samples[0]!.state = 'screened'
  expect(classify(input).terminal).toBe(true)
})
it('keeps partial failures running while another task remains potentially recoverable', () => {
  const input = fixture()
  input.state.tasks.push({ ...input.state.tasks[0]!, id: 'T2', rootSampleIds: ['lost-root'] })
  expect(classify(input)).toMatchObject({ terminal: false, potentiallyRecoverableTasks: ['T1'] })
})
it('uses already verified measurements even after their material is exhausted', () => {
  const input = fixture(); input.state.samples[0]!.volumeUl = 0
  input.verified = { result: { id: 'result', methodId: 'screen', methodVersion: 1, rootSampleId: 'root' } }
  expect(classify(input)).toMatchObject({ terminal: false, potentiallyRecoverableTasks: ['T1'] })
  input.state.deliveries.push({ taskId: 'T1', valid: true })
  expect(classify(input)).toMatchObject({ terminal: true, status: 'completed' })
})
it('awaits declared scenario changes and depends on logical expiry rather than a host clock', () => {
  const input = fixture(); input.state.tick = 101
  expect(classify(input).terminal).toBe(true)
  input.scenario.faults.push({ id: 'pending-event' })
  expect(classify(input).terminal).toBe(false)
})
it('keeps unreleased work in the experiment instead of ending at an exhausted early phase', () => {
  const input = fixture(); input.state.samples[0]!.volumeUl = 0
  const scenario = { ...input.scenario, tasks: [{ ...input.state.tasks[0]!, releaseTick: 10 }] }
  expect(classify({ ...input, scenario })).toMatchObject({ terminal: false, allScenarioEventsApplied: false })
  input.state.tick = 10
  expect(classify({ ...input, scenario })).toMatchObject({ terminal: true, status: 'irrecoverable-material-loss' })
})
