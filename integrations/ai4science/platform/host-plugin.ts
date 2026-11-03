/** Public Harness consumer tools for configurable project organizations. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Organization, OrganizationConfig } from './organization.ts'
import { createOrganization } from './organization.ts'
export const name = 'ai4science-organization'
export const inject = ['agents', 'subagents', 'tools', 'systemPrompt']
/** Auto-enrollment is limited to newly created root Agents, never loaded participant ids. */
export interface Config extends OrganizationConfig {
  task: string
}
/** Register the small tool surface; domain tools stay in separately loaded plugins. */
export function installOrganizationTools(ctx: Context, org: Organization) {
  const register = (
    name: string,
    description: string,
    parameters: ParameterSchemaSpec,
    body: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<unknown>,
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
          if (!exec.agent) throw new Error('Live participant required')
          org.assertActor(exec.agent, name === 'org_revoke' ? 'org_authorize' : name)
          return JSON.parse(JSON.stringify(await body(args, exec))) as JsonValue
        },
      }),
    )
  const id = { type: 'string', required: true } as const
  const optionalString = { type: 'string' } as const
  // Discovery identifies project members; native policy owns live ancestry and continuable peer sessions.
  const resolveTarget = (a: Record<string, unknown>, e: ToolRunContext, idKey: string,
    roleKey: string, scope: 'direct' | 'peer' | 'child' | 'peer-child') => {
    const explicit = a[idKey], role = a[roleKey]
    if ((typeof explicit === 'string') === (typeof role === 'string'))
      throw new Error(`Provide exactly one of ${idKey} or ${roleKey}`)
    if (typeof explicit === 'string') return SessionId(explicit)
    const actor = org.assertActor(e.agent!)
    const matches = org.discover(e.agent!).filter(p => {
      if (p.role !== role) return false
      if (scope === 'child') return p.parentId === actor.id
      if (scope === 'peer-child') return p.depth === actor.depth + 1 && p.parentId !== actor.id
      if (scope === 'direct') return p.id === actor.parentId || p.parentId === actor.id
      return p.id !== actor.id && p.depth === actor.depth && p.parentId !== actor.parentId
    })
    if (matches.length !== 1) throw new Error(`Role ${String(role)} needs exactly one visible ${scope}; found ${matches.length}`)
    return matches[0]!.id
  }
  register(
    'org_create',
    'Create an allowed role as your real continuable child.',
    { role: id, task: id },
    async (a, e) => org.create(e.agent!, String(a.role), String(a.task), e.signal),
  )
  register(
    'org_discover',
    'Discover direct relatives and configured collaboration candidates; discovery does not authorize sending.',
    {},
    async (_a, e) => org.discover(e.agent!),
  )
  register(
    'org_authorize',
    'Authorize your exact child and configured peer using IDs or unique visible roles (child_role, peer_role); both real parents must consent.',
    { child_id: optionalString, peer_child_id: optionalString, child_role: optionalString, peer_role: optionalString },
    async (a, e) => {
      const childId = resolveTarget(a, e, 'child_id', 'child_role', 'child')
      const peerChildId = resolveTarget(a, e, 'peer_child_id', 'peer_role', 'peer-child')
      await org.authorize(
        e.agent!,
        childId,
        peerChildId,
        e.signal,
      )
      return { accepted: true, childId, peerChildId }
    },
  )
  register(
    'org_revoke',
    'Revoke the exact pair before future inbox acceptance. Accepted messages are not recalled.',
    { child_id: id, peer_child_id: id },
    async (a, e) => {
      org.revoke(e.agent!, SessionId(String(a.child_id)), SessionId(String(a.peer_child_id)))
      return { revoked: true }
    },
  )
  register(
    'org_send_result',
    'Send a persisted result to target_id OR a unique visible peer target_role. Both parent consents remain required; receipt means accepted, not completed.',
    {
      target_id: optionalString,
      target_role: optionalString,
      result_id: id,
      kind: { type: 'string', enum: ['reference', 'reply'], required: true },
      in_reply_to: { type: 'string' },
    },
    async (a, e) => {
      if (a.kind === 'reply' && !a.in_reply_to) throw new Error('Reply requires in_reply_to')
      if (a.kind === 'reference' && a.in_reply_to !== undefined)
        throw new Error('Reference cannot carry in_reply_to')
      const targetId = resolveTarget(a, e, 'target_id', 'target_role', 'peer')
      return {
        targetId,
        messageId: await org.send(
          e.agent!,
          targetId,
          a.kind === 'reference'
            ? { kind: 'reference', resultId: String(a.result_id) }
            : { kind: 'reply', resultId: String(a.result_id), inReplyTo: MessageId(String(a.in_reply_to)) },
          e.signal,
        ),
      }
    },
  )
  register(
    'org_message',
    'Send an assignment to your native parent or direct child using target_id OR a unique visible target_role.',
    { target_id: optionalString, target_role: optionalString, text: id },
    async (a, e) => {
      const targetId = resolveTarget(a, e, 'target_id', 'target_role', 'direct')
      return { targetId, messageId: await org.message(e.agent!, targetId, String(a.text), e.signal) }
    },
  )
  register(
    'org_wait',
    'Wait in program code for a native inbox event or bounded timeout. This does not cancel a device.',
    { timeout_ms: { type: 'integer', required: true } },
    async (a, e) => org.wait(e.agent!, Number(a.timeout_ms), e.signal),
  )
  register(
    'org_finish',
    'As the live root, drain your participant tree and close organization admission. Provider operations remain separately managed.',
    {},
    async (_a, e) => {
      await org.close(e.agent!)
      e.concludeTurn()
      return { closed: true }
    },
  )
}
/** Loadable independently or composed by the platform plugin with execution-store hooks. */
export function apply(ctx: Context, config: Config) {
  const { task, ...organization } = config
  const org = createOrganization(ctx, organization)
  installOrganizationTools(ctx, org)
  ctx.on('agent/created', ({ agent }) => {
    if (!agent.session.header.parentSession) org.registerRoot(agent, task)
  })
}
