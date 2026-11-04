/** Display a saved evaluator report in Mission Control without opening a lab or an Agent. */
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync, realpathSync } from 'node:fs'
import { z } from 'zod'
import { startMissionControl } from '../../mission-control/server.ts'
import { readComparison } from './comparison.ts'

const evidenceSchema = z.object({
  referenceEvidence: z.array(z.object({ taskId: z.string(), referenceTaskId: z.string(),
    analysisCompleted: z.boolean(), referenceInputObserved: z.boolean(), peerMessageBeforeAnalysis: z.boolean(),
    routerMessageBeforeAnalysis: z.boolean(), sharedResultReadBeforeAnalysis: z.boolean() })).optional(),
  directPeerReferenceBeforeEveryAnalysis: z.boolean().nullable().optional(),
})
const runDiagnostics = z.object({ verification: evidenceSchema, installation: z.object({
  modelPolicy: z.array(z.object({ thresholdRatio: z.number().positive().max(1).optional() })),
}).nullable().optional() })
const diagnosticsSchema = z.object({ single: runDiagnostics, multi: runDiagnostics })
const configSchema = z.object({ reportFile: z.string().min(1), port: z.number().int().min(0).max(65535) }).strict()

/** Read an immutable saved report and its optional reference-channel observations.
 * @param file Saved output from the comparison evaluator.
 * @returns Validated display fields, excluding installation details and unrelated report fields.
 */
export function readResults(file: string) {
  const path = realpathSync(file)
  const base = readComparison(path)
  if (!base) throw new Error('Saved comparison report is required')
  const diagnostics = diagnosticsSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  const threshold = (run: z.infer<typeof runDiagnostics>) => run.installation?.modelPolicy.find(policy => policy.thresholdRatio !== undefined)?.thresholdRatio
  return { ...base,
    single: { ...base.single, compactionThresholdRatio: threshold(diagnostics.single), verification: { ...base.single.verification, ...diagnostics.single.verification } },
    multi: { ...base.multi, compactionThresholdRatio: threshold(diagnostics.multi), verification: { ...base.multi.verification, ...diagnostics.multi.verification } },
  }
}

/** Mount only the existing authenticated report UI; no clock, execution store or model provider is created.
 * @param ctx Profile lifecycle owner.
 * @param input Explicit immutable report path and loopback port.
 * @returns Resolves once the report listener is ready and owned by the profile.
 */
export async function apply(ctx: Context, input: z.infer<typeof configSchema>): Promise<void> {
  const config = configSchema.parse(input)
  const comparison = readResults(config.reportFile)
  const mission = await startMissionControl({ greenhouse: { snapshot: () => ({ mode: 'saved-report',
    experiment: null, comparison, events: [] }) } }, { port: config.port })
  let closing: Promise<void> | undefined
  const close = () => (closing ??= mission.close())
  try {
    ctx.effect(() => close, 'greenhouse.results')
    console.log(`Mission Control: ${mission.launchUrl}`)
  } catch (error) { await close(); throw error }
}
