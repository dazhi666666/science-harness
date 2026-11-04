/** Saved evaluation reports remain separate from live Agent inputs and fail visibly when malformed. */
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readComparison } from './comparison.ts'

let directory: string | undefined
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }) })

it('waits for an absent report, preserves an incomplete comparison and refuses malformed usage records', () => {
  directory = mkdtempSync(join(tmpdir(), 'greenhouse-comparison-'))
  const path = join(directory, 'pair.json')
  expect(readComparison()).toBeNull()
  expect(readComparison(path)).toBeNull()
  const single = { directory: '/fixture/single', mode: 'single-agent', source: 'scripted',
    verification: { success: false, tasks: 3, completedTasks: 1, tick: 20,
      operatingMetrics: { temperatureViolationTicks: 0, moistureViolationTicks: 4, powerOverloadTicks: 0 } },
    perRoute: { fixture: { requests: 8, inputTokens: 0, outputTokens: 0 } }, actualRequestRetries: 0,
    operatorSubmittedOperations: 0, allTaskCompletionTick: null, compactionEvents: {}, failedCompactions: 0 }
  const report = { scope: 'descriptive-pair', comparisonReady: false, matchingChecks: { both_real_model: false },
    single, multi: { ...single, mode: 'multi-agent' }, scientificQuality: 'not-assessed', architectureAdvantage: 'not-assessed',
    installation: { sourceHashes: {}, privateFilesystemPath: 'omitted-from-display' } }
  writeFileSync(path, JSON.stringify(report))
  expect(readComparison(path)).toMatchObject({ comparisonReady: false, single: { source: 'scripted', allTaskCompletionTick: null } })
  expect(JSON.stringify(readComparison(path))).not.toContain('omitted-from-display')
  single.perRoute.fixture.inputTokens = -1
  writeFileSync(path, JSON.stringify(report))
  expect(() => readComparison(path)).toThrow()
  writeFileSync(path, '{')
  expect(() => readComparison(path)).toThrow()
})
