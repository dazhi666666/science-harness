/** Report viewing preserves observed channels without starting a new experiment. */
import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { boot, type Probe } from '../platform/organization-fixture.ts'
import * as Results from './results.ts'

const probes: Probe[] = []
afterEach(async () => { for (const probe of probes.splice(0)) await probe.close() })

it('serves only a saved comparison and separates shared reads from direct peer input', async () => {
  const p = await boot('greenhouse-saved-results', true, async () => ({ withoutScience: true }))
  probes.push(p)
  const run = { directory: '/fixture/single', mode: 'single-agent', source: 'scripted',
    verification: { success: true, tasks: 3, completedTasks: 3, tick: 40,
      operatingMetrics: { temperatureViolationTicks: 0, moistureViolationTicks: 0, powerOverloadTicks: 0 },
      referenceEvidence: [{ taskId: 'C', referenceTaskId: 'B', analysisCompleted: true, referenceInputObserved: true,
        peerMessageBeforeAnalysis: false, routerMessageBeforeAnalysis: false, sharedResultReadBeforeAnalysis: true }] },
    perRoute: { fixture: { requests: 10, inputTokens: 0, outputTokens: 0 } }, actualRequestRetries: 0,
    operatorSubmittedOperations: 0, allTaskCompletionTick: 40, compactionEvents: {}, failedCompactions: 0,
    installation: { privateDetail: 'not-for-display', modelPolicy: [{}, { thresholdRatio: 0.04 }] } }
  const report = { scope: 'descriptive-pair', comparisonReady: false, matchingChecks: { both_real_model: false },
    single: run, multi: { ...run, mode: 'multi-agent' }, scientificQuality: 'not-assessed', architectureAdvantage: 'not-assessed' }
  const file = join(p.root, 'pair.json')
  writeFileSync(file, JSON.stringify(report))
  const createAgent = vi.spyOn(p.ctx.agents, 'create')
  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation(value => lines.push(String(value)))
  try {
    await p.ctx.plugin(Results, { reportFile: file, port: 0 })
    expect(createAgent).not.toHaveBeenCalled()
  } finally { log.mockRestore(); createAgent.mockRestore() }
  expect(existsSync(join(p.root, 'device'))).toBe(false)
  const launch = new URL(lines.find(line => line.startsWith('Mission Control: '))!.slice('Mission Control: '.length))
  const headers = { Authorization: `Bearer ${launch.hash.slice(1)}` }
  const snapshot = await (await fetch(`${launch.origin}/mc/greenhouse`, { headers })).json()
  expect(snapshot).toMatchObject({ mode: 'saved-report', experiment: null, events: [], comparison: {
    comparisonReady: false, multi: { compactionThresholdRatio: 0.04,
      verification: { referenceEvidence: [{ peerMessageBeforeAnalysis: false, sharedResultReadBeforeAnalysis: true }] } } } })
  expect(JSON.stringify(snapshot)).not.toContain('not-for-display')
  expect((await fetch(`${launch.origin}/mc/greenhouse`, { method: 'POST', headers })).status).toBe(405)
  run.verification.referenceEvidence[0]!.referenceInputObserved = false
  writeFileSync(file, JSON.stringify(report))
  expect((await (await fetch(`${launch.origin}/mc/greenhouse`, { headers })).json()).comparison.single.verification.referenceEvidence[0].referenceInputObserved).toBe(true)
  run.installation.modelPolicy[1]!.thresholdRatio = -1
  writeFileSync(file, JSON.stringify(report))
  expect(() => Results.readResults(file)).toThrow()
})
