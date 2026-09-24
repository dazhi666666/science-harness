/** First-loop application on v0.1: scientific phases and statistics remain entirely in this example. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { relative, resolve } from 'node:path'
import { mountPlatform, type Config as PlatformConfig } from '../plugin.ts'
import type { OperationContext, Json } from '../sdk.ts'
import type { ExecutionEngine } from '../execution.ts'
import { Artifacts } from '../artifacts.ts'
import { analyzeReadings, type Reading } from '../../first-loop/analysis.ts'

export const name = 'ai4science-first-loop-v01'
export const inject = ['agents', 'subagents', 'tools', 'systemPrompt']
export interface Config extends PlatformConfig {
  instrumentProvider: string
}
const blocks = z
  .array(z.object({ value: z.number().min(-1).max(1), samples: z.number().int().min(1).max(8) }).strict())
  .min(1)
  .max(3)
const submitSchema = z
  .object({
    requestKey: z.string().min(1),
    phase: z.enum(['initial', 'followup']),
    conditions: blocks,
    decisionId: z.string().optional(),
  })
  .strict()

/** Scenario state consists only of sourced facts in the platform store; it owns neither devices nor Agents. */
export class FirstLoopScenario {
  constructor(
    private readonly engine: ExecutionEngine,
    private readonly artifacts: Artifacts,
    private readonly providerId: string,
  ) {}
  async submit(c: OperationContext, role: string, input: z.infer<typeof submitSchema>) {
    const request = submitSchema.parse(input)
    const branch = role === 'midbrain-a' ? 'A' : role === 'midbrain-b' ? 'B' : null
    if (!branch) throw new Error('Only the scenario instrument roles submit')
    const facts = this.engine
      .readFacts(c)
      .filter((f) => f.kind === 'scenario-run')
      .map((f) => f.data as { branch: string; phase: string; requestKey: string; operationId: string })
    if (
      request.phase === 'initial' &&
      facts.some((f) => f.branch === branch && f.phase === 'initial' && f.requestKey !== request.requestKey)
    )
      throw new Error('Scenario permits one initial request per branch')
    if (request.phase === 'followup') {
      if (!request.decisionId) throw new Error('Followup requires a saved scenario decision')
      const selected = this.artifacts.read(c, request.decisionId)
      const decision = JSON.parse(selected.content)
      if (
        decision.kind !== 'first-loop-followup' ||
        decision.branch !== branch ||
        JSON.stringify(decision.conditions) !== JSON.stringify(request.conditions)
      )
        throw new Error('Followup differs from saved decision')
    }
    const operation = await this.engine.submit(c, {
      providerId: this.providerId,
      requestKey: request.requestKey,
      input: { conditions: request.conditions },
    })
    if (!facts.some((f) => f.operationId === operation.id))
      this.engine.recordFact(c, 'scenario-run', {
        branch,
        phase: request.phase,
        requestKey: request.requestKey,
        operationId: operation.id,
        decisionId: request.decisionId ?? null,
      })
    return operation
  }
  analyze(
    c: OperationContext,
    input: {
      operationIds: string[]
      method: 'condition-summary' | 'condition-order-regression'
      rationale: string
    },
  ) {
    if (!input.operationIds.length || !input.rationale.trim())
      throw new Error('Specify observed operations and rationale')
    const sources: string[] = []
    const readings: Reading[] = []
    for (const id of input.operationIds) {
      const operation = this.engine.get(c, id)
      if (operation.state !== 'succeeded' || operation.providerId !== this.providerId)
        throw new Error('Analysis needs completed instrument observations')
      const raw = operation.artifacts.find((a) => a.mediaType === 'application/json')
      if (!raw) throw new Error('Instrument raw data missing')
      sources.push(raw.id)
      const rows = JSON.parse(this.artifacts.read(c, raw.id).content) as Omit<Reading, 'runId'>[]
      readings.push(...rows.map((row) => ({ ...row, runId: id })))
    }
    const analysis = analyzeReadings(readings, input.method)
    return this.artifacts.publish(c, {
      mediaType: 'application/json',
      sources,
      content: JSON.stringify({ kind: 'first-loop-analysis', ...input, analysis }, null, 2),
    })
  }
  choose(
    c: OperationContext,
    input: {
      branch: 'A' | 'B'
      analysisIds: string[]
      conditions: z.infer<typeof blocks>
      rationale: string
    },
  ) {
    blocks.parse(input.conditions)
    if (!input.rationale.trim()) throw new Error('Record the additional experiment rationale')
    const covered = new Set(
      input.analysisIds.flatMap((id) => {
        const a = JSON.parse(this.artifacts.read(c, id).content)
        if (a.kind !== 'first-loop-analysis') throw new Error('Decision must cite analysis artifacts')
        return a.operationIds as string[]
      }),
    )
    const runs = this.engine
      .readFacts(c)
      .filter((f) => f.kind === 'scenario-run')
      .map((f) => f.data as { branch: string; phase: string; operationId: string })
    if (
      !['A', 'B'].every((branch) =>
        runs.some((r) => r.branch === branch && r.phase === 'initial' && covered.has(r.operationId)),
      )
    )
      throw new Error('Decision needs both initial branches analyzed')
    return this.artifacts.publish(c, {
      mediaType: 'application/json',
      sources: input.analysisIds,
      content: JSON.stringify({ kind: 'first-loop-followup', ...input }, null, 2),
    })
  }
  report(c: OperationContext, input: { markdown: string; sources: string[] }) {
    const runs = this.engine
      .readFacts(c)
      .filter((f) => f.kind === 'scenario-run')
      .map((f) => f.data as { branch: string; phase: string; operationId: string })
    if (
      !['A', 'B'].every((branch) =>
        runs.some(
          (r) =>
            r.branch === branch &&
            r.phase === 'initial' &&
            this.engine.get(c, r.operationId).state === 'succeeded',
        ),
      ) ||
      !runs.some((r) => r.phase === 'followup' && this.engine.get(c, r.operationId).state === 'succeeded')
    )
      throw new Error('Scenario report requires both initial runs and an executed followup')
    if (!input.sources.length) throw new Error('Report requires source artifacts')
    // Actual links target the generic artifact files next to this report. The platform only owns source identities/hashes.
    for (const source of input.sources) {
      const { artifact } = this.artifacts.read(c, source)
      const path = relative(
        resolve(this.engine.directory, 'project-artifacts'),
        resolve(this.engine.directory, artifact.path),
      )
      if (!input.markdown.includes(`](${path})`))
        throw new Error(
          'Scenario report must link each declared source artifact using its relative file path',
        )
    }
    return this.artifacts.publish(c, {
      mediaType: 'text/markdown',
      content: input.markdown,
      sources: input.sources,
    })
  }
}
/** Load platform once, then install the example's concrete scientific tools. */
export async function apply(ctx: Context, config: Config) {
  const { instrumentProvider, ...base } = config
  const platform = await mountPlatform(ctx, base)
  const scenario = new FirstLoopScenario(platform.engine, platform.artifacts, instrumentProvider)
  const register = (
    name: string,
    parameters: ParameterSchemaSpec,
    run: (args: Record<string, unknown>, c: OperationContext, role: string) => unknown,
  ) =>
    ctx.tools.register(
      defineTool({
        name,
        description: `First-loop example: ${name}. Scientific stages are scenario policy.`,
        parameters,
        output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        async execute(a, e) {
          if (!e.agent) throw new Error('Live scenario participant required')
          const c = platform.access(e.agent, name)
          const role = platform.org.assertActor(e.agent).role
          return JSON.parse(JSON.stringify(await run(a, c, role))) as JsonValue
        },
      }),
    )
  const id = { type: 'string', required: true } as const
  register('scenario_submit', { request_json: id }, (a, c, role) =>
    scenario.submit(c, role, JSON.parse(String(a.request_json))),
  )
  register('scenario_analyze', { request_json: id }, (a, c) =>
    scenario.analyze(
      c,
      z
        .object({
          operationIds: z.array(z.string()),
          method: z.enum(['condition-summary', 'condition-order-regression']),
          rationale: z.string(),
        })
        .strict()
        .parse(JSON.parse(String(a.request_json))),
    ),
  )
  register('scenario_choose_followup', { request_json: id }, (a, c, role) => {
    if (role !== 'lead') throw new Error('Only scenario lead chooses followup')
    return scenario.choose(
      c,
      z
        .object({
          branch: z.enum(['A', 'B']),
          analysisIds: z.array(z.string()),
          conditions: blocks,
          rationale: z.string(),
        })
        .strict()
        .parse(JSON.parse(String(a.request_json))),
    )
  })
  register(
    'scenario_report',
    { markdown: id, source_ids: { type: 'array', items: { type: 'string' }, required: true } },
    (a, c, role) => {
      if (role !== 'lead') throw new Error('Only scenario lead publishes')
      return scenario.report(c, {
        markdown: String(a.markdown),
        sources: z.array(z.string()).parse(a.source_ids),
      })
    },
  )
  platform.engine.recordFact(
    platform.engine.issueContext(platform.org.config.project, 'scenario-registration', []),
    'scenario-configured',
    { name, provider: instrumentProvider } as Json,
  )
}
