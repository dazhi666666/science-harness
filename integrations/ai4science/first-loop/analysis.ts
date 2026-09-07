/** Bounded, reproducible numerical analysis and evidence-linked model report publication. */
import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/** A published observation; simulator parameters never enter analysis. */
export interface Reading {
  runId: string
  operationId: string
  requestedCondition: number
  appliedCondition: number
  order: number
  timestamp: string
  value: number
  unit: string
}

/** The two numerical procedures exposed to the model in this demonstration. */
export type AnalysisMethod = 'condition-summary' | 'condition-order-regression'

const algorithmVersion = 'ai4science-numerics-v1'
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
const centeredSum = (a: number[], b: number[]) => {
  const am = mean(a), bm = mean(b)
  return a.reduce((sum, value, i) => sum + (value - am) * (b[i]! - bm), 0)
}

/** Compute descriptive statistics, or OLS with applied condition and global order.
 * @param readings Complete published observations; no rows are silently excluded.
 * @param method Model-selected procedure, retained in the returned record.
 * @returns Numerical estimates and assumptions, without a scientific conclusion.
 */
export function analyzeReadings(readings: Reading[], method: AnalysisMethod) {
  if (!readings.length) throw new Error('Analysis requires observations')
  const orders = new Set<number>()
  for (const row of readings) {
    if (![row.requestedCondition, row.appliedCondition, row.order, row.value].every(Number.isFinite)
      || row.appliedCondition < -1 || row.appliedCondition > 1 || row.requestedCondition < -1 || row.requestedCondition > 1
      || !Number.isInteger(row.order) || row.order < 1 || !row.runId || !row.operationId || !row.unit || !Number.isFinite(Date.parse(row.timestamp))) {
      throw new Error('Invalid published observation')
    }
    if (orders.has(row.order)) throw new Error('Duplicate global acquisition order: repeated observations cannot count as new evidence')
    orders.add(row.order)
  }
  if (new Set(readings.map(row => row.unit)).size !== 1) throw new Error('Mixed observation units')
  const groups = [...new Set(readings.map(row => row.appliedCondition))].sort((a, b) => a - b).map(condition => {
    const rows = readings.filter(row => row.appliedCondition === condition)
    const values = rows.map(row => row.value)
    const sampleVariance = values.length > 1 ? centeredSum(values, values) / (values.length - 1) : null
    return { condition, n: rows.length, mean: mean(values), standardDeviation: sampleVariance === null ? null : Math.sqrt(sampleVariance),
      standardError: sampleVariance === null ? null : Math.sqrt(sampleVariance / rows.length),
      orderMin: Math.min(...rows.map(row => row.order)), orderMax: Math.max(...rows.map(row => row.order)) }
  })
  const plus = groups.find(group => group.condition === 1), minus = groups.find(group => group.condition === -1)
  const unadjustedEffect = plus && minus ? {
    comparison: '+1 versus -1', estimate: plus.mean - minus.mean,
    standardError: plus.standardError === null || minus.standardError === null ? null : Math.hypot(plus.standardError, minus.standardError),
  } : null
  const caveats = [
    'Synthetic instrument observations, not evidence about a physical device.',
    'Standard errors assume independent errors; serial dependence or unmodeled drift can invalidate them.',
    'An insignificant estimate does not establish equivalence; the prespecified minimum effect of interest is 0.2 simulated output units.',
    'Group differences are unadjusted for acquisition order and can confound condition with drift.',
  ]
  const common = { algorithmVersion, method, n: readings.length, unit: readings[0]!.unit, groups, unadjustedEffect, minimumEffectOfInterest: 0.2, caveats }
  if (method === 'condition-summary') return { ...common, regression: null }
  if (method !== 'condition-order-regression') throw new Error('Unknown analysis method')
  const x = readings.map(row => row.appliedCondition), t = readings.map(row => row.order), y = readings.map(row => row.value)
  const xx = centeredSum(x, x), tt = centeredSum(t, t), xt = centeredSum(x, t)
  const xy = centeredSum(x, y), ty = centeredSum(t, y)
  const determinant = xx * tt - xt * xt
  const conditionOrderCorrelation = xx > 0 && tt > 0 ? xt / Math.sqrt(xx * tt) : null
  const specification = { formula: 'value = intercept + conditionCoefficient * appliedCondition + orderCoefficient * order + error', conditionOrderCorrelation }
  if (xx === 0 || tt === 0 || determinant <= 1e-12 * xx * tt) {
    caveats.push('Rank-deficient design: the condition effect cannot be separated from intercept or acquisition order; no regression estimates are reported.')
    return { ...common, regression: { ...specification, status: 'unidentifiable' as const, residualDegreesOfFreedom: null, intercept: null, conditionCoefficient: null, orderCoefficient: null, residualStandardDeviation: null, adjustedEffect: null } }
  }
  if (conditionOrderCorrelation !== null && Math.abs(conditionOrderCorrelation) >= 0.8) caveats.push('Condition and acquisition order are strongly correlated (absolute correlation >= 0.8); separating effects depends heavily on the linear-order assumption.')
  caveats.push('OLS assumes a linear condition response and linear drift with global acquisition order, with independent constant-variance errors. Standard errors are not confidence intervals.')
  const conditionCoefficient = (xy * tt - ty * xt) / determinant
  const orderCoefficient = (ty * xx - xy * xt) / determinant
  const intercept = mean(y) - conditionCoefficient * mean(x) - orderCoefficient * mean(t)
  const residualSumSquares = readings.reduce((sum, row) => sum + (row.value - intercept - conditionCoefficient * row.appliedCondition - orderCoefficient * row.order) ** 2, 0)
  const residualDegreesOfFreedom = readings.length - 3
  const residualVariance = residualDegreesOfFreedom > 0 ? residualSumSquares / residualDegreesOfFreedom : null
  if (residualVariance === null) caveats.push('No residual degrees of freedom: uncertainty is not estimable from these observations.')
  if (!plus || !minus) caveats.push('The +1 versus -1 regression contrast extrapolates beyond one or both observed endpoints.')
  return { ...common, regression: { ...specification, status: 'estimated' as const, residualDegreesOfFreedom, intercept, conditionCoefficient, orderCoefficient,
    residualStandardDeviation: residualVariance === null ? null : Math.sqrt(residualVariance),
    adjustedEffect: { comparison: '+1 versus -1 at the same acquisition order', estimate: 2 * conditionCoefficient,
      standardError: residualVariance === null ? null : 2 * Math.sqrt(residualVariance * tt / determinant) } } }
}

function identifier(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new Error('Invalid artifact identifier')
  return value
}

async function evidencePath(root: string, path: string) {
  if (!path || isAbsolute(path)) throw new Error('Evidence paths must be project-relative')
  const actualRoot = await realpath(root), actual = await realpath(resolve(root, path))
  const within = relative(actualRoot, actual)
  if (within === '..' || within.startsWith('../') || isAbsolute(within)) throw new Error('Evidence path escapes project')
  await readFile(actual)
}

async function publish(root: string, path: string, contents: string) {
  const destination = resolve(root, path)
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.${randomUUID()}.tmp`
  await writeFile(temporary, contents, { flag: 'wx' })
  try { await link(temporary, destination) } finally { await unlink(temporary) }
}

/** Save the exact inputs, selected procedure, rationale and reproducible numerical output.
 * @param input Project root and complete analysis evidence selected by the caller.
 * @returns The same immutable structured record that was saved in the artifact file.
 */
export async function saveAnalysis(input: {
  root: string; analysisId: string; ownerId: string; runIds: string[]; method: AnalysisMethod; rationale: string; readings: Reading[]; rawPaths?: string[]
}) {
  if (!input.rationale.trim() || !input.ownerId || !input.runIds.length) throw new Error('Analysis requires owner, rationale and run references')
  const runIds = [...new Set(input.runIds)]
  if (input.readings.some(row => !runIds.includes(row.runId)) || runIds.some(id => !input.readings.some(row => row.runId === id))) throw new Error('Analysis run references do not match observations')
  const rawPaths = [...new Set(input.rawPaths ?? [])]
  for (const path of rawPaths) await evidencePath(input.root, path)
  const artifactPath = `analyses/${identifier(input.analysisId)}.json`
  const record = { id: input.analysisId, artifactPath, ownerId: input.ownerId, createdAt: new Date().toISOString(), runIds, rawPaths,
    method: input.method, rationale: input.rationale, algorithm: { version: algorithmVersion, source: 'integrations/ai4science/first-loop/analysis.ts', runtime: process.version, reproducibilityAbsoluteTolerance: 1e-10 },
    inputs: input.readings, output: analyzeReadings(input.readings, input.method) }
  await publish(input.root, artifactPath, JSON.stringify(record, null, 2) + '\n')
  return record
}

/** Publish model-authored Markdown verbatim after checking working inline Markdown evidence links.
 * @param input Markdown received from the live model and actual evidence refs supplied by the integration.
 * @returns Published report metadata. Reference validation does not verify scientific prose or authorship.
 */
export async function saveReport(input: {
  root: string; reportId: string; ownerId: string; markdown: string; analysisPaths: string[]; rawPaths: string[]; runIds: string[]; decisionPaths: string[]
}) {
  if (!input.ownerId || !input.markdown.trim()) throw new Error('Report requires an author and Markdown')
  if (![input.analysisPaths, input.rawPaths, input.runIds, input.decisionPaths].every(values => values.length > 0)) throw new Error('Report requires analysis, raw, run and follow-up decision references')
  const artifactPath = `reports/${identifier(input.reportId)}.md`
  const metadataPath = `reports/${input.reportId}.json`
  const paths = [...new Set([...input.analysisPaths, ...input.rawPaths, ...input.decisionPaths])]
  const linkedPaths = new Set<string>()
  const inlineLinks = /(?<!!)\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g
  for (const match of input.markdown.matchAll(inlineLinks)) {
    const target = match[1] ?? match[2]!
    if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(target) || target.startsWith('//') || target.startsWith('#')) continue
    const decoded = decodeURIComponent(target.split('#')[0]!.split('?')[0]!)
    const path = relative(resolve(input.root), resolve(input.root, 'reports', decoded))
    await evidencePath(input.root, path)
    linkedPaths.add(path)
  }
  for (const path of paths) {
    await evidencePath(input.root, path)
    if (!linkedPaths.has(path)) throw new Error(`Report requires a working inline Markdown link to ${path}; use [evidence](../${path}) from reports/. Plain path text is insufficient.`)
  }
  for (const id of input.runIds) if (!input.markdown.includes(id)) throw new Error(`Report omits run reference: ${id}`)
  const record = { id: input.reportId, artifactPath, metadataPath, ownerId: input.ownerId, createdAt: new Date().toISOString(),
    analysisPaths: input.analysisPaths, rawPaths: input.rawPaths, runIds: input.runIds, decisionPaths: input.decisionPaths,
    validation: 'All declared evidence has working inline Markdown links to files within project; run ids occur in Markdown. Scientific reasoning requires review.',
    proseSource: 'caller-supplied model tool input; no deterministic scientific prose generated' }
  await publish(input.root, artifactPath, input.markdown)
  await publish(input.root, metadataPath, JSON.stringify(record, null, 2) + '\n')
  return record
}
