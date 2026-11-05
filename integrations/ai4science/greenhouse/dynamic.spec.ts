/** Real native members react to public disturbances; only policy responses are scripted. */
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { toolCallResponse, textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { boot, Gate, toolValue, type Probe } from '../platform/organization-fixture.ts'
import { mountMultiAgent } from './agents.ts'
import { scenarioSchema } from './schema.ts'

const probes: Probe[] = []
afterEach(async () => { for (const p of probes.splice(0)) await p.close() })

it('wakes settled members for power, sensor and new-task events and executes their actual responses', async () => {
  const p = await boot('greenhouse-dynamic-native', true, async () => ({ withoutScience: true })); probes.push(p)
  const scenario = scenarioSchema.parse(JSON.parse(readFileSync(new URL('./scenario.json', import.meta.url), 'utf8')))
  scenario.tickMs = 100000
  scenario.initial.chambers.A.light = 0.7
  const scenarioFile = join(p.root, 'scenario.json'); writeFileSync(scenarioFile, JSON.stringify(scenario))
  let count = 0, consumed = '', last = '', pending: 'power' | undefined, extraId = ''
  const leadPolicy = (options: GenerateOptions): StreamChunk[] => {
    p.model.queue('lead', leadPolicy)
    const message = options.messages.findLast(message => message.role === 'tool')
    const call = (name: string, args: object) => {
      last = name
      return toolCallResponse(`dynamic-lead-${++count}`, name, args)
    }
    if (message?.role === 'tool' && String(message.toolCallId) !== consumed) {
      consumed = String(message.toolCallId)
      if (message.isError) throw new Error('Unexpected lead tool refusal')
      const value = toolValue(options, consumed)
      if (last === 'lab_inbox') {
        const inbox = z.array(z.object({ from: z.string(), content: z.string() }).passthrough()).parse(value)
        for (const mail of inbox.filter(mail => mail.from === 'environment')) {
          const notice = z.object({ events: z.array(z.object({ kind: z.string(), data: z.json() }).passthrough()) }).passthrough().parse(JSON.parse(mail.content))
          for (const event of notice.events) {
            if (event.kind === 'environment-power') { pending = 'power'; return call('greenhouse_observe', {}) }
            if (event.kind === 'environment-task') {
              const task = z.object({ task: z.object({ id: z.string(), chamber: z.string() }).passthrough() }).passthrough().parse(event.data).task
              return call('lab_assign', { assignee: `chamber-${task.chamber}`, experiment_task: task.id })
            }
          }
        }
      }
      if (last === 'greenhouse_observe' && pending === 'power') {
        pending = undefined
        const state = z.object({ powerCapacity: z.number(), requestedPower: z.number(), powerPerLight: z.number(),
          chambers: z.array(z.object({ chamber: z.string(), lightSetting: z.number() }).passthrough()) }).passthrough().parse(value)
        expect(state.requestedPower).toBeGreaterThan(state.powerCapacity)
        const a = state.chambers.find(chamber => chamber.chamber === 'A')!
        const level = Math.max(0, a.lightSetting - (state.requestedPower - state.powerCapacity) / state.powerPerLight - 0.05)
        return call('lab_message', { to: 'chamber-A', content: JSON.stringify({ action: 'light', level }) })
      }
      return textResponse('Lead processed the actual incoming notice.')
    }
    return call('lab_inbox', {})
  }
  p.model.queue('lead', leadPolicy)
  for (const chamber of ['A', 'B', 'C']) p.model.queue(`chamber-${chamber}`, textResponse('Ready for environmental work.'))
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  let run: Awaited<ReturnType<typeof mountMultiAgent>>
  try { run = await mountMultiAgent(p.ctx, { directory: join(p.root, 'run'), scenarioFile, clockMode: 'timer',
    project: 'cross-branch-project', port: 0, refreshMs: 100, providerCallTimeoutMs: 1000,
    source: 'scripted', model: { provider: 'teams-probe', model: 'script' } }) }
  finally { log.mockRestore() }
  await vi.waitFor(() => expect(run!.team.snapshot().members.filter(member => member.name !== 'lead').every(member => member.status === 'inactive')).toBe(true))
  const stepTo = (tick: number) => { while (run!.runtime.world.observe().tick < tick) run!.runtime.world.step() }
  const active = (action: string, chamber?: string) => run!.runtime.world.audit().jobs.find(job => job.state === 'running' &&
    job.command.action === action && (!chamber || ('chamber' in job.command && job.command.chamber === chamber)))
  const aGate = new Gate()
  p.model.queue('chamber-A', toolCallResponse('A-read-power-mail', 'lab_inbox', {}), options => {
    const inbox = z.array(z.object({ from: z.string(), content: z.string() }).passthrough()).parse(toolValue(options, 'A-read-power-mail'))
    const proposal = z.object({ action: z.literal('light'), level: z.number() }).parse(JSON.parse(inbox.find(mail => mail.from === 'lead')!.content))
    return toolCallResponse('A-power-action', 'greenhouse_light', { chamber: 'A', level: proposal.level, requestKey: 'A-power-reduction' })
  }, async options => {
    const operation = z.object({ id: z.string() }).passthrough().parse(toolValue(options, 'A-power-action'))
    await aGate.wait(options.signal)
    return toolCallResponse('A-power-result', 'greenhouse_result', { operation_id: operation.id })
  }, textResponse('A applied the coordinated power change.'))
  stepTo(20)
  await vi.waitFor(() => expect(active('light', 'A')).toBeDefined())
  stepTo(21); aGate.release()
  await vi.waitFor(() => expect(run!.team.snapshot().members.find(member => member.name === 'chamber-A')!.status).toBe('inactive'))
  expect(run!.runtime.world.observe().requestedPower).toBeLessThanOrEqual(run!.runtime.world.observe().powerCapacity)

  const inspectGate = new Gate(), calibrationGate = new Gate()
  p.model.queue('chamber-B', toolCallResponse('B-read-sensor-mail', 'lab_inbox', {}), options => {
    const inbox = z.array(z.object({ from: z.string(), content: z.string() }).passthrough()).parse(toolValue(options, 'B-read-sensor-mail'))
    expect(inbox.some(mail => mail.from === 'environment' && mail.content.includes('environment-sensor'))).toBe(true)
    return toolCallResponse('B-inspect', 'greenhouse_inspect', { chamber: 'B', requestKey: 'B-inspect-sensor' })
  }, async options => {
    const operation = z.object({ id: z.string() }).passthrough().parse(toolValue(options, 'B-inspect'))
    await inspectGate.wait(options.signal)
    return toolCallResponse('B-inspection-result', 'greenhouse_result', { operation_id: operation.id })
  }, options => {
    const result = z.object({ outputs: z.array(z.object({ data: z.object({ result: z.object({ moistureSensor: z.string() }).passthrough() }).passthrough() }).passthrough()) }).passthrough().parse(toolValue(options, 'B-inspection-result'))
    expect(result.outputs[0]!.data.result.moistureSensor).toBe('calibration-required')
    return toolCallResponse('B-calibrate', 'greenhouse_calibrate', { chamber: 'B', requestKey: 'B-calibrate-sensor' })
  }, async options => {
    const operation = z.object({ id: z.string() }).passthrough().parse(toolValue(options, 'B-calibrate'))
    await calibrationGate.wait(options.signal)
    return toolCallResponse('B-calibration-result', 'greenhouse_result', { operation_id: operation.id })
  }, textResponse('B completed its local sensor recovery.'))
  stepTo(30)
  await vi.waitFor(() => expect(active('inspect', 'B')).toBeDefined())
  stepTo(33); inspectGate.release()
  await vi.waitFor(() => expect(active('calibrate', 'B')).toBeDefined())
  stepTo(37); calibrationGate.release()
  await vi.waitFor(() => expect(run!.team.snapshot().members.find(member => member.name === 'chamber-B')!.status).toBe('inactive'))
  expect(run!.runtime.world.audit().chambers.B.sensorBias).toBe(0)

  const sampleGate = new Gate(), assayGate = new Gate(), analysisGate = new Gate()
  p.model.queue('chamber-C', toolCallResponse('C-read-new-work', 'lab_inbox', {}), options => {
    const inbox = z.array(z.object({ from: z.string(), content: z.string(), task_id: z.string().nullable() }).passthrough()).parse(toolValue(options, 'C-read-new-work'))
    const assigned = inbox.find(mail => mail.from === 'lead' && mail.task_id)!
    extraId = assigned.task_id!
    const task = z.object({ id: z.string() }).passthrough().parse(JSON.parse(assigned.content.slice(assigned.content.indexOf('{'))))
    expect(task.id).toBe('extra-C')
    return toolCallResponse('C-new-sample', 'greenhouse_sample', { chamber: 'C', taskId: task.id, requestKey: 'C-new-sample' })
  }, async options => {
    const operation = z.object({ id: z.string() }).passthrough().parse(toolValue(options, 'C-new-sample'))
    await sampleGate.wait(options.signal)
    return toolCallResponse('C-sample-result', 'greenhouse_result', { operation_id: operation.id })
  }, options => {
    const result = z.object({ outputs: z.array(z.object({ data: z.object({ result: z.object({ sampleId: z.string() }) }).passthrough() }).passthrough()) }).passthrough().parse(toolValue(options, 'C-sample-result'))
    return toolCallResponse('C-new-assay', 'greenhouse_assay', { sampleId: result.outputs[0]!.data.result.sampleId, requestKey: 'C-new-assay' })
  }, async options => {
    const operation = z.object({ id: z.string() }).passthrough().parse(toolValue(options, 'C-new-assay'))
    await assayGate.wait(options.signal)
    return toolCallResponse('C-assay-result', 'greenhouse_result', { operation_id: operation.id })
  }, options => {
    const result = z.object({ outputs: z.array(z.object({ data: z.object({ result: z.object({ id: z.string() }).passthrough() }).passthrough() }).passthrough()) }).passthrough().parse(toolValue(options, 'C-assay-result'))
    return toolCallResponse('C-new-analysis', 'greenhouse_analyze', { taskId: 'extra-C', assayIds: [result.outputs[0]!.data.result.id], requestKey: 'C-new-analysis' })
  }, async options => {
    const operation = z.object({ id: z.string() }).passthrough().parse(toolValue(options, 'C-new-analysis'))
    await analysisGate.wait(options.signal)
    return toolCallResponse('C-analysis-result', 'greenhouse_result', { operation_id: operation.id })
  }, options => {
    const result = z.object({ operation: z.object({ id: z.string(), state: z.literal('succeeded') }).passthrough() }).passthrough().parse(toolValue(options, 'C-analysis-result'))
    return toolCallResponse('C-complete-extra', 'lab_complete', { task_id: extraId, operation_id: result.operation.id })
  }, textResponse('C finished the newly requested experiment.'))
  stepTo(40)
  await vi.waitFor(() => expect(active('sample', 'C')).toBeDefined())
  stepTo(44); sampleGate.release()
  await vi.waitFor(() => expect(active('assay')).toBeDefined())
  stepTo(49); assayGate.release()
  await vi.waitFor(() => expect(active('analyze')).toBeDefined())
  stepTo(51); analysisGate.release()
  await vi.waitFor(() => expect(run!.team.snapshot().tasks[0]!.status).toBe('done'))
  const notifications = run!.team.snapshot().messages.filter(message => message.from === 'environment')
  expect(notifications.map(message => message.to)).toEqual(['lead', 'chamber-B', 'lead'])
  expect(notifications.every(message => message.read && message.delivery.status === 'accepted')).toBe(true)
  expect(JSON.stringify(notifications)).not.toContain('"bias"')
  expect(run!.runtime.world.observe().completedTasks).toContain('extra-C')
  expect(run!.dispatcher.status()).toMatchObject({ acceptedNotices: 3, failure: null })
  p.report.status = 'passed'
  p.report.scope = 'dynamic-feedback-only'
  p.report.dynamicGreenhouse = { source: 'scripted', tick: run!.runtime.world.observe().tick, scenarioHash: run!.runtime.world.scenarioHash,
    physicalOutcomes: { requestedPower: run!.runtime.world.observe().requestedPower, powerCapacity: run!.runtime.world.observe().powerCapacity,
      sensorBCalibrated: run!.runtime.world.audit().chambers.B.sensorBias === 0, extraExperimentCompleted: run!.runtime.world.observe().completedTasks.includes('extra-C') }, verified: ['power-coordination', 'sensor-recovery', 'late-task'],
    originalThreeTasksExercised: false, notifications, tasks: run!.team.snapshot().tasks }
})
