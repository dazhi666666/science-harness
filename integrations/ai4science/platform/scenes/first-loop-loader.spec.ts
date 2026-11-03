/** Exercise the actual scene entry and model-facing schemas through the Harness Loader. */
import { afterEach, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Scene from './first-loop.ts'
import { HARNESS_BASELINE } from '../version.ts'
import { boot, lead, execute, Gate, type Probe } from '../organization-fixture.ts'

let probe: Probe | undefined
afterEach(async () => { await probe?.close(); probe = undefined })

it('loads the scene directly and executes structured tools on actual provider output', async () => {
  probe = await boot('scene-structured-tools', true, async root => {
    const organizationFile = join(root, 'organization.json')
    const deploymentFile = join(root, 'deployment.json')
    const tools = ['org_create', 'org_discover', 'org_message', 'org_finish', 'scenario_submit', 'execution_wait',
      'scenario_analyze', 'scenario_choose_followup', 'scenario_report']
    const role = (creates: Record<string, number>) => ({ instructions: 'Use the scripted tools.',
      model: { provider: 'teams-probe', model: 'script' }, tools, creates, maxInstances: 1 })
    await writeFile(organizationFile, JSON.stringify({ project: 'cross-branch-project', rootRole: 'lead',
      maxParticipants: 2, maxDepth: 1, roles: { lead: role({ 'midbrain-a': 1 }), 'midbrain-a': role({}) }, relations: [] }))
    await writeFile(deploymentFile, JSON.stringify({ apiVersion: 1, enabled: true, baseline: HARNESS_BASELINE,
      directory: join(root, 'execution'), pollIntervalMs: 2, providerCallTimeoutMs: 1000,
      management: { actorId: 'admin', projects: ['cross-branch-project'], allowedProviders: ['instrument'] },
      providers: [{ module: fileURLToPath(new URL('../providers/instrument.ts', import.meta.url)),
        config: { id: 'instrument', directory: join(root, 'device'), resource: 'instrument', tickMs: 1,
          reference: 10, slope: 0.27, drift: 0.012, noise: 0.18, seed: 3 } }] }))
    return { withoutScience: true, modules: { scene: Scene }, configs: { scene: {
      deploymentFile, organizationFile, task: 'Check structured tools.', budget: 40,
      instrumentProvider: 'instrument', roleProviders: { lead: ['instrument'], 'midbrain-a': ['instrument'] },
    } } }
  })
  const p = probe
  const root = await lead(p, 'scene-root')
  p.model.queue('scene-worker', new Gate().step())
  const child = await execute(p, 'org_create', { role: 'midbrain-a', task: 'ACTOR scene-worker' }, root.agent)
  if (child.isError) throw new Error(child.error.message)
  const participant = (child.value as { participant: { id: string } }).participant
  const worker = p.ctx.agents.get(participant.id as typeof root.agent.id)!
  const message = await execute(p, 'org_message', { target_role: 'midbrain-a', text: 'Read the assigned conditions.' }, root.agent)
  if (message.isError) throw new Error(message.error.message)
  const invalid = await execute(p, 'scenario_submit', { requestKey: 'invalid', phase: 'initial',
    conditions: [{ value: 2, samples: 1 }] }, worker)
  expect(invalid.isError).toBe(true)
  const submitted = await execute(p, 'scenario_submit', { requestKey: 'initial-a', phase: 'initial',
    conditions: [{ value: -1, samples: 2 }, { value: 1, samples: 2 }] }, worker)
  if (submitted.isError) throw new Error(submitted.error.message)
  const operationId = (submitted.value as { id: string }).id
  const waited = await execute(p, 'execution_wait', { operation_id: operationId, timeout_ms: 5000 }, worker)
  expect(waited.isError).toBe(false)
  const analyzed = await execute(p, 'scenario_analyze', { operationIds: [operationId],
    method: 'condition-summary', rationale: 'Inspect completed provider output.' }, root.agent)
  if (analyzed.isError) throw new Error(analyzed.error.message)
  const analysisId = (analyzed.value as { id: string }).id
  const chosen = await execute(p, 'scenario_choose_followup', { branch: 'A', analysisIds: [analysisId],
    conditions: [{ value: 0, samples: 2 }], rationale: 'Follow up on observed data.' }, root.agent)
  expect(chosen.isError && chosen.error.message).toContain('both initial branches analyzed')
  const prematureReport = await execute(p, 'scenario_report', { markdown: '# Pending report' }, root.agent)
  expect(prematureReport.isError && prematureReport.error.message).toContain('both initial runs')
  const finished = await execute(p, 'org_finish', {}, root.agent)
  expect(finished.isError).toBe(false)
})
