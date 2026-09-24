/** Domain-owned observation-count policy. It evaluates data completeness, not hypotheses or model quality. */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { OperationContext } from '../sdk.ts'
import type { ExecutionEngine } from '../execution.ts'
import { Artifacts } from '../artifacts.ts'
import { mountPlatform, type Config } from '../plugin.ts'
import type { ExperimentRequest } from '../experiments.ts'

const contextSchema = z
  .object({ providerId: z.string().min(1), minimumReadings: z.number().int().min(1).max(96) })
  .strict()
const readingSchema = z
  .object({
    order: z.number().int().positive(),
    value: z.number().finite(),
    unit: z.string(),
    requestedCondition: z.number(),
    appliedCondition: z.number(),
  })
  .passthrough()
/** A concrete recipe offers an initial acquisition and at most one evidence-backed supplement. */
export function samplingRequest(providerId: string): ExperimentRequest {
  return {
    goal: 'Obtain at least six valid observations across two instrument conditions.',
    method: { id: 'bounded-sampling', version: '1' },
    context: { providerId, minimumReadings: 6 },
    inputArtifactIds: [],
    outputRequirements:
      'Raw observations, data-completeness assessments and an execution report; scientific interpretation is separate.',
    budget: 6,
    maxOperations: 2,
    actions: [
      {
        id: 'measure',
        providerId,
        input: {
          conditions: [
            { value: -1, samples: 2 },
            { value: 1, samples: 2 },
          ],
        },
        minUses: 1,
        maxUses: 1,
        requiresEvidence: false,
      },
      {
        id: 'supplement',
        providerId,
        input: {
          conditions: [
            { value: -1, samples: 1 },
            { value: 1, samples: 1 },
          ],
        },
        minUses: 0,
        maxUses: 1,
        requiresEvidence: true,
      },
    ],
  }
}
/** Read actual Provider output and persist the deterministic domain assessment with its raw sources. */
export function assessSampling(engine: ExecutionEngine, c: OperationContext, id: string) {
  const view = engine.experiments.get(c, id)
  if (!view.controllerActive || view.cancelRequested || view.state === 'completed')
    throw new Error('An open experiment with a live controller is required for assessment')
  if (view.request.method.id !== 'bounded-sampling' || view.request.method.version !== '1')
    throw new Error('Unsupported sampling method')
  if (
    !view.operations.length ||
    view.operations.some((o) => !['succeeded', 'failed', 'cancelled'].includes(o.state))
  )
    throw new Error('Wait for confirmed operation outcomes before assessing data')
  const domain = contextSchema.parse(view.request.context),
    artifacts = new Artifacts(engine),
    sources: string[] = [],
    orders = new Set<number>()
  for (const op of view.operations) {
    if (op.providerId !== domain.providerId) throw new Error('Sampling recipe contains an unrelated Provider')
    if (op.state !== 'succeeded') continue
    const raw = op.artifacts.find((a) => a.path.endsWith('raw.json'))
    if (!raw) throw new Error('Expected instrument raw observations')
    const rows = z.array(readingSchema).parse(JSON.parse(artifacts.read(c, raw.id).content))
    for (const row of rows) {
      if (orders.has(row.order)) throw new Error('Repeated observations cannot count as new evidence')
      orders.add(row.order)
    }
    sources.push(raw.id)
  }
  const result = {
    status: orders.size >= domain.minimumReadings ? 'sufficient' : 'insufficient',
    observed: orders.size,
    required: domain.minimumReadings,
    scientificConclusion: 'not-assessed',
  }
  const artifact = artifacts.publish(c, {
    mediaType: 'application/json',
    sources,
    content: JSON.stringify({ method: 'observation-count', version: '1', ...result }, null, 2),
  })
  const assessment = engine.experiments.assess(c, id, {
    method: 'observation-count',
    version: '1',
    result,
    rationale: 'Count unique observations in actual completed instrument outputs.',
    operationIds: view.operations.map((o) => o.id),
    artifactIds: [artifact.id],
  })
  return {
    ...result,
    assessmentId: assessment.id,
    artifactId: artifact.id,
    suggestedAction: result.status === 'insufficient' ? 'supplement' : 'finish',
  }
}
/** Produce an execution report only when this recipe's declared completeness requirement is met. */
export function finishSampling(engine: ExecutionEngine, c: OperationContext, id: string) {
  engine.experiments.requireController(c, id)
  const quality = assessSampling(engine, c, id)
  if (quality.status !== 'sufficient') throw new Error('Sampling output requirement has not been met')
  const view = engine.experiments.get(c, id),
    artifacts = new Artifacts(engine)
  const report = artifacts.publish(c, {
    mediaType: 'text/markdown',
    sources: [quality.artifactId],
    content: `# Experiment execution report\n\n${view.request.goal}\n\nObserved ${quality.observed} readings; required ${quality.required}.\n\nOperations: ${view.operations.map((o) => o.id).join(', ')}.\n\n[Data completeness assessment](${quality.artifactId})\n\nScientific conclusions are not evaluated by this report.\n`,
  })
  return engine.experiments.finish(
    c,
    id,
    'The declared observation count was obtained; execution and provenance verified.',
    [report.id],
    [quality.assessmentId],
  )
}
export const name = 'ai4science-sampling-experiment'
export const inject = ['agents', 'subagents', 'tools', 'systemPrompt']
/** Compose the generic platform, then add only the domain policy tools. */
export async function apply(ctx: Context, config: Config) {
  const platform = await mountPlatform(ctx, config)
  for (const [tool, body] of [
    ['sampling_assess', assessSampling],
    ['sampling_finish', finishSampling],
  ] as const) {
    ctx.tools.register(
      defineTool({
        name: tool,
        description:
          tool === 'sampling_assess'
            ? 'Check actual observation count and save a sourced completeness assessment.'
            : 'As experiment controller, publish the sampling execution report after completeness passes.',
        parameters: { experiment_id: { type: 'string', required: true } },
        output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        async execute(a, e) {
          if (!e.agent) throw new Error('Live participant required')
          const c = platform.access(e.agent, tool)
          return JSON.parse(JSON.stringify(body(platform.engine, c, a.experiment_id))) as JsonValue
        },
      }),
    )
  }
}

/** Public CLI domain-method export; module selection is an explicit trusted operator action. */
export const assessExperiment = assessSampling
