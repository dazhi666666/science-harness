/** Offline numerical replay only; this utility does not launch Agents or call a model. */
import { readFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { analyzeReadings, type AnalysisMethod, type Reading } from './analysis.ts'

const tolerance = 1e-10
let largestDifference = 0
function compare(actual: unknown, expected: unknown, path: string): void {
  if (typeof actual === 'number' && typeof expected === 'number') {
    const difference = Math.abs(actual - expected)
    if (!Number.isFinite(actual) || !Number.isFinite(expected) || difference > tolerance) throw new Error(`${path}: numerical mismatch exceeds ${tolerance}`)
    largestDifference = Math.max(largestDifference, difference)
    return
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) throw new Error(`${path}: array length mismatch`)
    actual.forEach((value, i) => compare(value, expected[i], `${path}[${i}]`))
    return
  }
  if (actual !== null && expected !== null && typeof actual === 'object' && typeof expected === 'object') {
    const a = actual as Record<string, unknown>, b = expected as Record<string, unknown>
    if (JSON.stringify(Object.keys(a).sort()) !== JSON.stringify(Object.keys(b).sort())) throw new Error(`${path}: object keys mismatch`)
    for (const key of Object.keys(a)) compare(a[key], b[key], `${path}.${key}`)
    return
  }
  if (actual !== expected) throw new Error(`${path}: nonnumeric value mismatch`)
}

try {
  if (process.argv.length !== 3) throw new Error('Usage: node --import tsx/esm integrations/ai4science/first-loop/recompute.ts <run-root>')
  const root = resolve(process.argv[2]!)
  const files = (await readdir(join(root, 'analyses'))).filter(file => file.endsWith('.json')).sort()
  if (!files.length) throw new Error('No saved analyses; nothing has been verified')
  for (const file of files) {
    const analysis = JSON.parse(await readFile(join(root, 'analyses', file), 'utf8')) as { inputs: Reading[]; method: AnalysisMethod; output: unknown }
    compare(analyzeReadings(analysis.inputs, analysis.method), analysis.output, file)
  }
  process.stdout.write(JSON.stringify({ status: 'passed', kind: 'offline-numerical-replay', root, analyses: files.length, tolerance, largestAbsoluteDifference: largestDifference, files }, null, 2) + '\n')
} catch (error) {
  process.stderr.write(JSON.stringify({ status: 'failed', kind: 'offline-numerical-replay', error: error instanceof Error ? error.message : String(error) }) + '\n')
  process.exitCode = 1
}
