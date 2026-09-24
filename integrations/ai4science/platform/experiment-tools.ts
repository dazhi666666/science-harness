/** Native Harness tools over the experiment API; live Agent/role checks stay in platform access(). */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolRunContext, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import type { ExecutionEngine } from './execution.ts'
import type { OperationContext, Json } from './sdk.ts'

export function installExperimentTools(
  ctx: Context,
  engine: ExecutionEngine,
  access: (agent: Agent, tool: string) => OperationContext,
) {
  const id = { type: 'string', required: true } as const
  const list = { type: 'array', items: { type: 'string' }, required: true } as const
  const register = (
    name: string,
    description: string,
    parameters: ParameterSchemaSpec,
    body: (a: Record<string, unknown>, e: ToolRunContext, c: OperationContext) => unknown,
  ) =>
    ctx.tools.register(
      defineTool({
        name,
        description,
        parameters,
        output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        async execute(a, e) {
          if (!e.agent) throw new Error('Live experiment participant required')
          const c = access(e.agent, name)
          return JSON.parse(JSON.stringify(await body(a, e, c))) as JsonValue
        },
      }),
    )
  register(
    'experiment_create',
    'Record an experiment goal, method, inputs and exact permitted actions with limits. No work is executed by creation.',
    { request_key: id, request_json: id },
    (a, _e, c) => engine.experiments.create(c, String(a.request_key), JSON.parse(String(a.request_json))),
  )
  register(
    'experiment_claim',
    'Explicitly take control using a fresh live context. Historical owner IDs never restore authority.',
    { experiment_id: id, reason: id },
    (a, _e, c) => engine.experiments.claim(c, String(a.experiment_id), String(a.reason)),
  )
  register(
    'experiment_status',
    'Read experiment operations, decisions, assessments, blocking reason and feedback cursor.',
    { experiment_id: id },
    (a, _e, c) => engine.experiments.get(c, String(a.experiment_id)),
  )
  register(
    'experiment_act',
    'Select one exact approved action. Record a stable decision key, rationale and actual prior evidence; new work consumes budget.',
    { experiment_id: id, decision_json: id },
    (a, _e, c) => engine.experiments.submit(c, String(a.experiment_id), JSON.parse(String(a.decision_json))),
  )
  register(
    'experiment_wait',
    'Program waits for meaningful progress or a decision point. A timeout is feedback, never proof equipment stopped.',
    {
      experiment_id: id,
      after_seq: { type: 'integer', required: true },
      until: { type: 'string', enum: ['change', 'decision'], required: true },
      timeout_ms: { type: 'integer', required: true },
    },
    (a, e, c) =>
      engine.experiments.wait(c, String(a.experiment_id), {
        after: Number(a.after_seq),
        until: a.until === 'change' ? 'change' : 'decision',
        timeoutMs: Number(a.timeout_ms),
        signal: e.signal,
      }),
  )
  register(
    'experiment_escalate',
    'Record a proposed adjustment outside current requirements and block new actions for controller review.',
    { experiment_id: id, reason: id, proposal_json: id },
    (a, _e, c) =>
      engine.experiments.escalate(
        c,
        String(a.experiment_id),
        String(a.reason),
        JSON.parse(String(a.proposal_json)) as Json,
      ),
  )
  register(
    'experiment_resolve',
    'As current controller, authorize continuation within the original immutable requirements. Changed requirements need a new experiment.',
    { experiment_id: id, reason: id },
    (a, _e, c) => engine.experiments.resolve(c, String(a.experiment_id), String(a.reason)),
  )
  register(
    'experiment_finish',
    'As current controller, close settled execution with source-checked artifacts and assessment IDs. This does not certify scientific conclusions.',
    { experiment_id: id, summary: id, artifact_ids: list, assessment_ids: list },
    (a, _e, c) =>
      engine.experiments.finish(
        c,
        String(a.experiment_id),
        String(a.summary),
        z.array(z.string()).parse(a.artifact_ids),
        z.array(z.string()).parse(a.assessment_ids),
      ),
  )
  register(
    'experiment_cancel',
    'As current controller, stop new admission and request cancellation for active operations. Unknown or unstopped work cannot become cancelled.',
    { experiment_id: id },
    (a, _e, c) => engine.experiments.cancel(c, String(a.experiment_id)),
  )
}
