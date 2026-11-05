/** Read the evaluator's saved pair for Mission Control; it is never supplied to an Agent. */
import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'

const count = z.number().int().nonnegative()
const runSchema = z.object({
  directory: z.string().min(1),
  mode: z.enum(['single-agent', 'multi-agent']), source: z.enum(['scripted', 'real-model']),
  verification: z.object({ success: z.boolean(), tasks: count, completedTasks: count, tick: count,
    operatingMetrics: z.object({ temperatureViolationTicks: count, moistureViolationTicks: count, powerOverloadTicks: count }) }),
  perRoute: z.record(z.string(), z.object({ requests: count, inputTokens: count, outputTokens: count })),
  actualRequestRetries: count, operatorSubmittedOperations: count, allTaskCompletionTick: count.nullable(),
  compactionEvents: z.record(z.string(), count), failedCompactions: count,
  clockPolicy: z.object({ mode: z.enum(['timer', 'event-driven']), idleReviewTicks: count }).optional(),
  taskLatencyTicks: z.record(z.string(), count).optional(),
  observations: z.object({
    resources: z.object({ throughTick: count, anyOperationBusyTicks: count,
      twoOrMoreOperationsBusyTicks: count, peakConcurrentOperations: count,
      byResource: z.record(z.string(), z.object({ busyTicks: count, overlappingExclusiveOperationTicks: count })) }),
    repeats: z.object({ additionalSameSampleAssays: count, additionalSameTaskAnalyses: count,
      identicalActionToolCallRepeats: count, requestKeysUsedWithDifferentArguments: count, invalidJsonToolArguments: count }),
    compactionContinuity: z.object({ pendingTaskOpportunities: count, verifiedPendingTaskClosures: count }),
  }).optional(),
})
const reportSchema = z.object({ scope: z.literal('descriptive-pair'), comparisonReady: z.boolean(),
  matchingChecks: z.record(z.string(), z.boolean()), single: runSchema, multi: runSchema,
  scientificQuality: z.literal('not-assessed'), architectureAdvantage: z.literal('not-assessed') })

/** Load only the report fields displayed to the operator; missing output means the pair is pending.
 * @param file Optional local evaluator output path selected by the profile owner.
 * @returns Validated display data, or null before the evaluator has written its output.
 */
export function readComparison(file?: string) {
  if (!file || !existsSync(file)) return null
  return reportSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
}
