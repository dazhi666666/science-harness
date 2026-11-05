/** Public-reply scripted native loop exercises a whole coupled scenario without privileged device access. */
import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { boot, type Probe } from '../../platform/organization-fixture.ts'
import { laboratoryPolicy } from './scripted-policy.ts'
import { mountLaboratoryAgents } from './agents.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
const probes: Probe[] = []
afterEach(async () => { for (const probe of probes.splice(0)) await probe.close() })
it.runIf(process.env.LABORATORY_FULL_NATIVE_TEST === '1')('completes all 52 phase deliveries with native Single tools, actual faults, replenishment and revised methods', async () => {
  const probe = await boot('laboratory-whole-single-script', true, async () => ({ withoutScience: true })); probes.push(probe)
  const policy = laboratoryPolicy('lead', 'single-agent')
  const scripted = (options: GenerateOptions): StreamChunk[] => {
    probe.model.queue('lead', scripted)
    return policy(options)
  }
  probe.model.queue('lead', scripted)
  const team = await mountLaboratoryAgents(probe.ctx, { directory: join(probe.root, 'run'), seed: 1,
    project: 'cross-branch-project', mode: 'single-agent', source: 'scripted', providerPool: ['teams-probe'],
    model: { provider: 'teams-probe', model: 'fixture' }, port: 0, refreshMs: 100, providerCallTimeoutMs: 1000 })
  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (team.metrics.modelErrors || team.metrics.toolErrors || team.runtime.clock.status().failure) {
        clearInterval(timer); reject(new Error('Native scripted run reported a model, tool or clock failure; inspect its retained evidence')); return
      }
      if (team.runtime.world.observe().deliveries.filter(delivery => delivery.valid).length === 52 && team.team.snapshot().tasks.every(task => task.status === 'done')) {
        clearInterval(timer); resolve()
      }
    }, 100)
    probe.ctx.effect(() => () => clearInterval(timer), 'laboratory.scripted-verification')
  })
  const state = team.runtime.world.observe()
  expect(state.appliedFaults).toHaveLength(3)
  expect(state.appliedRevisions).toHaveLength(4)
  expect(state.shipments.some(shipment => shipment.delivered)).toBe(true)
  expect(state.operations.some(operation => operation.command.action === 'refill')).toBe(true)
  expect(team.metrics.modelErrors).toBe(0)
  expect(team.metrics.inputTokens).toBe(0)
  probe.note('whole-native-single-success', { tick: state.tick, validDeliveries: 52, operations: state.operations.length, modelRequests: team.metrics.requests })
  await team.close()
}, 600000)
