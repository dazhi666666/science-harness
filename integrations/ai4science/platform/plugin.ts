/** Installable platform composition: native organization policy plus one durable execution manager. */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolRunContext, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { openConfiguredEngine } from './config.ts'
import { createOrganization, organizationSchema } from './organization.ts'
import { installOrganizationTools } from './host-plugin.ts'
import { installExperimentTools } from './experiment-tools.ts'
import { Artifacts } from './artifacts.ts'
import type { OperationContext, Json } from './sdk.ts'

export const name = 'ai4science-platform'
export const inject = ['agents', 'subagents', 'tools', 'systemPrompt']
const schema = z
  .object({
    deploymentFile: z.string().min(1),
    organizationFile: z.string().min(1),
    task: z.string().min(1),
    budget: z.number().nonnegative(),
    roleProviders: z.record(z.string(), z.array(z.string())),
  })
  .strict()
export type Config = z.infer<typeof schema>

/** Compose inside a host; no model, participant count, research phase or statistics are chosen here. */
export async function mountPlatform(ctx: Context, input: Config) {
  const config = schema.parse(input)
  const organizationConfig = organizationSchema.parse(
    JSON.parse(readFileSync(config.organizationFile, 'utf8')),
  )
  const extension = ctx.subagents.scienceResults
  if (
    !extension ||
    typeof extension.assertLiveParticipant !== 'function' ||
    extension.project !== organizationConfig.project
  )
    throw new Error('Explicit compatible AI4Science v0.1 host extension required')
  const opened = await openConfiguredEngine(config.deploymentFile)
  const { engine, config: deployment } = opened
  let admitted = true
  try {
    if (!deployment.management.projects.includes(organizationConfig.project))
      throw new Error('Project outside configured management domain permissions')
    for (const [role, providers] of Object.entries(config.roleProviders)) {
      if (
        !organizationConfig.roles[role] ||
        providers.some((id) => !deployment.management.allowedProviders.includes(id))
      )
        throw new Error('Role references undeclared provider capability')
    }
    engine.createProject(organizationConfig.project, config.budget)
    const admin = engine.issueContext(
      organizationConfig.project,
      'platform-facts',
      deployment.management.allowedProviders,
    )
    const artifacts = new Artifacts(engine)
    const org = createOrganization(ctx, organizationConfig, {
      record: (kind, data) => engine.recordFact(admin, kind, JSON.parse(JSON.stringify(data)) as Json),
      resultReader: (id) => {
        if (!admitted) return undefined
        const operation = engine.list(admin).find((o) => o.id === id && o.state === 'succeeded')
        if (operation) return { project: operation.projectId, ownerSessionId: SessionId(operation.actorId) }
        const artifact = artifacts.list(admin).find((a) => a.id === id)
        if (artifact) {
          artifacts.read(admin, id)
          return { project: artifact.projectId, ownerSessionId: SessionId(artifact.actorId) }
        }
        return undefined
      },
    })
    const grants = new WeakMap<Agent, OperationContext>()
    const access = (agent: Agent, tool: string) => {
      if (!admitted) throw new Error('Platform closed')
      const participant = org.assertActor(agent, tool)
      let grant = grants.get(agent)
      if (!grant) {
        grant = engine.issueContext(
          participant.project,
          agent.id,
          config.roleProviders[participant.role] ?? [],
        )
        grants.set(agent, grant)
      }
      return grant
    }
    ctx.on('agent/disposed', ({ agent }) => {
      const grant = grants.get(agent)
      if (grant) engine.revokeContext(grant)
    })
    ctx.on('agent/created', ({ agent }) => {
      if (!agent.session.header.parentSession) org.registerRoot(agent, config.task)
    })
    installOrganizationTools(ctx, org)
    installExperimentTools(ctx, engine, access)
    const register = (
      name: string,
      description: string,
      parameters: ParameterSchemaSpec,
      execute: (
        args: Record<string, unknown>,
        exec: ToolRunContext,
        grant: OperationContext,
      ) => Promise<unknown> | unknown,
    ) =>
      ctx.tools.register(
        defineTool({
          name,
          description,
          parameters,
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          async execute(args, exec) {
            if (!exec.agent) throw new Error('Exact live participant required')
            const grant = access(exec.agent, name)
            const result = await execute(args, exec, grant)
            return JSON.parse(JSON.stringify(result)) as JsonValue
          },
        }),
      )
    const id = { type: 'string', required: true } as const
    register(
      'execution_describe',
      'Describe authorized Providers: inputs, outputs, units, resource needs, completion and cancellation.',
      {},
      (_a, _e, c) => engine.descriptions(c),
    )
    register(
      'execution_submit',
      'Submit provider JSON under a durable request key. Acceptance is separate from completion.',
      { provider_id: id, request_key: id, input_json: id },
      (a, _e, c) =>
        engine.submit(c, {
          providerId: String(a.provider_id),
          requestKey: String(a.request_key),
          input: JSON.parse(String(a.input_json)) as Json,
        }),
    )
    register(
      'execution_query',
      'Query an operation once; unknown retains conflicting resources.',
      { operation_id: id },
      (a, _e, c) => engine.query(c, String(a.operation_id)),
    )
    register(
      'execution_wait',
      'Program waits for terminal or unknown state; timeout does not cancel equipment.',
      { operation_id: id, timeout_ms: { type: 'integer', required: true } },
      (a, e, c) =>
        engine.wait(c, String(a.operation_id), { timeoutMs: Number(a.timeout_ms), signal: e.signal }),
    )
    register(
      'execution_cancel',
      'Request cancellation; only a subsequent terminal observation proves it completed.',
      { operation_id: id },
      (a, _e, c) => engine.cancel(c, String(a.operation_id)),
    )
    register(
      'execution_result',
      'Read an operation and integrity-checked output artifacts available to this role.',
      { operation_id: id },
      (a, _e, c) => {
        const operation = engine.get(c, String(a.operation_id))
        return { operation, artifacts: operation.artifacts.map((x) => artifacts.read(c, x.id)) }
      },
    )
    register(
      'execution_facts',
      'Read persisted project tasks and accessible results. Historical IDs do not restore authority.',
      {},
      (_a, _e, c) => ({
        operations: engine.list(c),
        facts: engine.readFacts(c).filter((f) => {
          if (f.kind !== 'artifact-published') return true
          try {
            artifacts.read(c, (f.data as { id: string }).id)
            return true
          } catch {
            return false
          }
        }),
      }),
    )
    register(
      'artifact_publish',
      'Save text with valid source artifact IDs and content hash. No scientific quality judgement is performed.',
      {
        content: id,
        media_type: id,
        source_ids: { type: 'array', items: { type: 'string' }, required: true },
      },
      (a, _e, c) =>
        artifacts.publish(c, {
          content: String(a.content),
          mediaType: String(a.media_type),
          sources: z.array(z.string()).parse(a.source_ids),
        }),
    )
    register(
      'artifact_read',
      'Read an integrity-checked artifact in the current project.',
      { artifact_id: id },
      (a, _e, c) => artifacts.read(c, String(a.artifact_id)),
    )
    ctx.effect(
      () => async () => {
        admitted = false
        engine.revokeContext(admin)
        await engine.close()
      },
      'ai4science.execution',
    )
    return { engine, org, artifacts, access, config }
  } catch (error) {
    admitted = false
    await engine.close()
    throw error
  }
}
/** Cordis function-plugin entry. Disable/unload closes admission and management, not physical equipment. */
export async function apply(ctx: Context, config: Config) {
  await mountPlatform(ctx, config)
}
