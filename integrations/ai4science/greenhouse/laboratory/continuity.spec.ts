/** Synthetic event-order regressions validate summary-crossing measurements without claiming model retention. */
import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
function fixture() {
  const delivery = { taskId: 'phase', resultIds: ['result-1'], referenceResultIds: [], tick: 10, valid: true }
  const result = (seq: number, id: string, value: unknown) => ({ type: 'tool/result', seq, time: 100 + seq,
    data: { message: { toolCallId: id, content: [{ type: 'text', text: JSON.stringify(value) }] } } })
  return { native: { lead: [
    { type: 'tool/call', seq: 1, time: 101, data: { callId: 'assign', name: 'lab_assign', arguments: JSON.stringify({ assignee: 'lead', experiment_task: 'phase' }) } },
    result(2, 'assign', { task: { id: 'T1' } }),
    { type: 'compaction/start', seq: 3, time: 103, data: { compactionId: 'C1' } },
    { type: 'compaction/summary', seq: 4, time: 104, data: { compactionId: 'C1' } },
    { type: 'compaction/end', seq: 5, time: 105, data: { compactionId: 'C1' } },
    { type: 'tool/call', seq: 6, time: 106, data: { callId: 'close', name: 'lab_complete', arguments: JSON.stringify({ task_id: 'T1' }) } },
    result(7, 'close', { task: { id: 'T1' }, delivery }),
  ] }, board: { tasks: [{ id: 'T1', title: 'phase', assignee: 'lead', created_by: 'lead' }] },
  state: { deliveries: [delivery] }, verified: { 'result-1': {} } as Record<string, unknown>, mail: [] }
}
function observe(input: unknown) {
  const script = `import sys,json
sys.path.insert(0, 'integrations/ai4science/greenhouse/laboratory')
from continuity import observe_continuity
value=json.load(sys.stdin)
print(json.dumps(observe_continuity(value['native'],value['board'],value['state'],value['verified'],value['mail'])))`
  const result = spawnSync('python3', ['-c', script], { input: JSON.stringify(input), encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout)
}
it('counts actual assigned pending work and uses native sequence rather than host timestamps', () => {
  const input = fixture(), report = observe(input)
  expect(report).toMatchObject({ pendingTaskOpportunities: 1, verifiedPendingTaskClosures: 1, informationLoss: 'not-assessed' })
  for (const row of input.native.lead) row.time = 10000 - row.time
  expect(observe(input)).toEqual(report)
})
it('rejects missing artifacts and failed summaries while keeping the pending opportunity visible', () => {
  const input = fixture()
  input.verified = {}
  expect(observe(input)).toMatchObject({ pendingTaskOpportunities: 1, verifiedPendingTaskClosures: 0 })
  const failed = fixture()
  Object.assign(failed.native.lead.find(row => row.type === 'compaction/end')!.data, { error: 'summary failed' })
  expect(observe(failed)).toMatchObject({ pendingTaskOpportunities: 1, verifiedPendingTaskClosures: 0 })
})
it('excludes assignments that were not received before compaction and closures before its end', () => {
  const unassigned = fixture(); unassigned.native.lead = unassigned.native.lead.filter(row => row.type !== 'tool/result' || row.seq !== 2)
  expect(observe(unassigned).pendingTaskOpportunities).toBe(0)
  const early = fixture(); early.native.lead.find(row => row.type === 'tool/call' && row.seq === 6)!.seq = 4
  expect(observe(early)).toMatchObject({ pendingTaskOpportunities: 1, verifiedPendingTaskClosures: 0 })
})
