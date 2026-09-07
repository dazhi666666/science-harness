/** Numerical and artifact publication checks; these do not claim real-model acceptance. */
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { analyzeReadings, saveAnalysis, saveReport, type Reading } from './analysis.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function root() {
  const value = await mkdtemp(join(tmpdir(), 'science-analysis-'))
  roots.push(value)
  return value
}
function readings(conditions: number[], values: number[]): Reading[] {
  return conditions.map((condition, i) => ({ runId: 'run-A', operationId: `op-${i + 1}`, requestedCondition: condition, appliedCondition: condition,
    order: i + 1, timestamp: '2026-09-06T00:00:00.000Z', value: values[i]!, unit: 'simulated output units' }))
}

it('reports sample uncertainty and endpoint differences without a canned conclusion', () => {
  const result = analyzeReadings(readings([-1, -1, 1, 1, 0], [1, 3, 3, 5, 4]), 'condition-summary')
  expect(result.groups[0]).toMatchObject({ condition: -1, n: 2, mean: 2, standardError: 1 })
  expect(result.groups[0]!.standardDeviation).toBeCloseTo(Math.sqrt(2))
  expect(result.groups[1]).toMatchObject({ n: 1, standardDeviation: null, standardError: null })
  expect(result.unadjustedEffect?.estimate).toBe(2)
  expect(result.unadjustedEffect?.standardError).toBeCloseTo(Math.sqrt(2))
  expect(result.regression).toBeNull()
  expect(result).not.toHaveProperty('conclusion')
})

it('separates a condition effect and linear drift and computes residual-based uncertainty', () => {
  const x = [-1, 1, -1, 1, -1, 1], residual = [1, 1, -2, -2, 1, 1]
  const result = analyzeReadings(readings(x, x.map((condition, i) => 10 + 0.4 * condition + 0.2 * (i + 1) + residual[i]!)), 'condition-order-regression')
  expect(result.regression?.status).toBe('estimated')
  expect(result.regression?.intercept).toBeCloseTo(10, 10)
  expect(result.regression?.conditionCoefficient).toBeCloseTo(0.4, 10)
  expect(result.regression?.orderCoefficient).toBeCloseTo(0.2, 10)
  expect(result.regression?.adjustedEffect?.estimate).toBeCloseTo(0.8, 10)
  expect(result.regression?.residualDegreesOfFreedom).toBe(3)
  expect(result.regression?.residualStandardDeviation).toBeCloseTo(2, 10)
  expect(result.regression?.adjustedEffect?.standardError).toBeCloseTo(Math.sqrt(35 / 12), 10)
})

it('does not turn pure drift into a condition effect despite an unadjusted difference', () => {
  const x = [-1, -1, -1, 1, 1, 1]
  const result = analyzeReadings(readings(x, x.map((_, i) => 10 + 0.3 * (i + 1))), 'condition-order-regression')
  expect(result.unadjustedEffect?.estimate).toBeCloseTo(0.9, 10)
  expect(result.regression?.adjustedEffect?.estimate).toBeCloseTo(0, 10)
  expect(result.regression?.orderCoefficient).toBeCloseTo(0.3, 10)
  expect(result.caveats.some(value => value.includes('strongly correlated'))).toBe(true)
})

it('withholds estimates for rank-deficient designs and uncertainty with no residual degrees of freedom', () => {
  const deficient = analyzeReadings(readings([-1, 0, 1], [1, 2, 3]), 'condition-order-regression')
  expect(deficient.regression?.status).toBe('unidentifiable')
  expect(deficient.regression?.adjustedEffect).toBeNull()
  expect(deficient.caveats.some(value => value.includes('Rank-deficient'))).toBe(true)
  const saturated = analyzeReadings(readings([-1, 1, -1], [1, 2, 3]), 'condition-order-regression')
  expect(saturated.regression?.status).toBe('estimated')
  expect(saturated.regression?.adjustedEffect?.standardError).toBeNull()
  expect(saturated.regression?.residualDegreesOfFreedom).toBe(0)
})

it('rejects duplicate observations, invalid readings and mixed units rather than silently filtering', () => {
  const rows = readings([-1, 1], [1, 2])
  expect(() => analyzeReadings([...rows, rows[0]!], 'condition-summary')).toThrow('Duplicate global acquisition order')
  expect(() => analyzeReadings([{ ...rows[0]!, value: NaN }], 'condition-summary')).toThrow('Invalid published')
  expect(() => analyzeReadings([rows[0]!, { ...rows[1]!, unit: 'volts' }], 'condition-summary')).toThrow('Mixed')
  expect(() => analyzeReadings([], 'condition-summary')).toThrow('requires observations')
})

it('publishes replayable inputs and exact model Markdown with evidence refs, without overwriting records', async () => {
  const project = await root()
  await mkdir(join(project, 'raw'))
  await mkdir(join(project, 'decisions'))
  const rows = readings([-1, 1, -1, 1], [1, 2, 1.1, 2.1])
  await writeFile(join(project, 'raw/run-A.json'), JSON.stringify(rows))
  await writeFile(join(project, 'decisions/followup.json'), JSON.stringify({ rationale: 'Model test prose', runIds: ['run-A'] }))
  const input = { root: project, analysisId: 'initial', ownerId: 'research-A', runIds: ['run-A'], method: 'condition-order-regression' as const,
    rationale: 'Check whether order explains the apparent condition difference.', readings: rows, rawPaths: ['raw/run-A.json'] }
  const analysis = await saveAnalysis(input)
  const disk = JSON.parse(await readFile(join(project, analysis.artifactPath), 'utf8'))
  expect(analyzeReadings(disk.inputs, disk.method)).toEqual(disk.output)
  await expect(saveAnalysis(input)).rejects.toMatchObject({ code: 'EEXIST' })
  const markdown = '# Model-authored test report\n\nEvidence: [analysis](../analyses/initial.json), [raw](../raw/run-A.json). Run run-A. Decision [follow-up](../decisions/followup.json).\n'
  const report = await saveReport({ root: project, reportId: 'report', ownerId: 'lead', markdown,
    analysisPaths: [analysis.artifactPath], rawPaths: ['raw/run-A.json'], runIds: ['run-A'], decisionPaths: ['decisions/followup.json'] })
  expect(await readFile(join(project, report.artifactPath), 'utf8')).toBe(markdown)
  expect(JSON.parse(await readFile(join(project, report.metadataPath), 'utf8')).analysisPaths).toEqual([analysis.artifactPath])
})

it('rejects untraceable reports, mismatched runs and evidence outside the project', async () => {
  const project = await root(), outside = await root()
  await writeFile(join(outside, 'private.json'), '{}')
  await symlink(join(outside, 'private.json'), join(project, 'escape.json'))
  const input = { root: project, analysisId: 'analysis', ownerId: 'research-A', runIds: ['run-A'], method: 'condition-summary' as const,
    rationale: 'Summary', readings: readings([-1, 1], [1, 2]) }
  await expect(saveAnalysis({ ...input, rawPaths: ['escape.json'] })).rejects.toThrow('escapes project')
  await expect(saveAnalysis({ ...input, runIds: ['different-run'] })).rejects.toThrow('do not match')
  await expect(saveAnalysis({ ...input, analysisId: '../escape' })).rejects.toThrow('Invalid artifact identifier')
  const analysis = await saveAnalysis(input)
  await expect(saveReport({ root: project, reportId: 'report', ownerId: 'lead', markdown: 'Unsupported claim',
    analysisPaths: [analysis.artifactPath], rawPaths: [analysis.artifactPath], runIds: ['run-A'], decisionPaths: [analysis.artifactPath] })).rejects.toThrow('working inline Markdown link')
  await expect(readFile(join(project, 'reports/report.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects plain path mentions and broken or escaping Markdown links before publishing any model prose', async () => {
  const project = await root()
  const analysis = await saveAnalysis({ root: project, analysisId: 'proof', ownerId: 'research-A', runIds: ['run-A'], method: 'condition-summary',
    rationale: 'Summarize readings', readings: readings([-1, 1], [1, 2]) })
  const request = { root: project, reportId: 'report', ownerId: 'lead', analysisPaths: [analysis.artifactPath], rawPaths: [analysis.artifactPath], runIds: ['run-A'], decisionPaths: [analysis.artifactPath] }
  await expect(saveReport({ ...request, markdown: `run-A evidence is ../${analysis.artifactPath}` })).rejects.toThrow('Plain path text is insufficient')
  await expect(saveReport({ ...request, markdown: `run-A [evidence](${analysis.artifactPath})` })).rejects.toMatchObject({ code: 'ENOENT' })
  const outside = await root()
  await writeFile(join(outside, 'private.json'), '{}')
  await symlink(join(outside, 'private.json'), join(project, 'escape.json'))
  await expect(saveReport({ ...request, markdown: `run-A [evidence](../${analysis.artifactPath}) [escape](../escape.json)` })).rejects.toThrow('escapes project')
  await expect(readFile(join(project, 'reports/report.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})
