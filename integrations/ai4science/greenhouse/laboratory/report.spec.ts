/** Saved laboratory reports preserve the recorded result without running devices or Agents. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as Report from './report.ts'
const contexts: Context[] = [], roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it('serves an immutable read-only pair and rejects invalid display counters', async () => {
  const root = mkdtempSync(join(tmpdir(), 'laboratory-report-')); roots.push(root)
  const file = join(root, 'report.json')
  const run = { directory: '/fixture/single', source: 'scripted', mode: 'single-agent', success: true, tick: 10, tasks: 3, validDeliveries: 3,
    operations: 8, measurements: 3, messages: 0, allTaskCompletionTick: 10, meanTaskLatencyTicks: 5, operatorSubmittedOperations: 0,
    perRoute: { scripted: { requests: 30, inputTokens: 0, outputTokens: 0 } }, operatingMetrics: { powerOverloadTicks: 0, waterUnavailableTicks: 0, unsafeSampleTicks: 0 },
    compactionEventsByRole: { lead: { start: 0, summary: 0, end: 0 } }, checks: [{ name: 'fixture', passed: true }] }
  const report = { scope: 'descriptive-laboratory-pair', comparisonReady: false, matchingChecks: { both_real_model: false },
    single: run, multi: { ...run, mode: 'multi-agent' }, scientificQuality: 'not-assessed', architectureAdvantage: 'not-assessed' }
  writeFileSync(file, JSON.stringify(report))
  const ctx = new Context(); contexts.push(ctx)
  const lines: string[] = [], log = vi.spyOn(console, 'log').mockImplementation(value => lines.push(String(value)))
  try { await ctx.plugin(Report, { reportFile: file, port: 0 }) } finally { log.mockRestore() }
  const launch = new URL(lines.find(line => line.startsWith('Mission Control: '))!.slice('Mission Control: '.length))
  const headers = { Authorization: `Bearer ${launch.hash.slice(1)}` }
  expect((await fetch(`${launch.origin}/mc/laboratory`)).status).toBe(401)
  expect((await fetch(`${launch.origin}/mc/laboratory`, { method: 'POST', headers })).status).toBe(405)
  const read = () => fetch(`${launch.origin}/mc/laboratory`, { headers }).then(response => response.json())
  expect(await read()).toMatchObject({ mode: 'saved-report', comparison: { comparisonReady: false, single: { validDeliveries: 3 } } })
  expect(existsSync(join(root, 'device'))).toBe(false)
  run.validDeliveries = 0; writeFileSync(file, JSON.stringify(report))
  expect((await read()).comparison.single.validDeliveries).toBe(3)
  run.operations = -1; writeFileSync(file, JSON.stringify(report))
  const invalid = new Context(); contexts.push(invalid)
  await expect(Report.apply(invalid, { reportFile: file, port: 0 })).rejects.toThrow()
})
