import { HARNESS_BASELINE } from './version.ts'
/** Actual Loader composition connects native scripted Agents to independently journaled Provider execution. */
import { afterEach, expect, it, vi } from 'vitest'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { boot, Gate, lead, signal, execute, toolValue, payload, type Probe } from './organization-fixture.ts'
import { mountPlatform, type Config } from './plugin.ts'
import type { OrganizationConfig } from './organization.ts'
import type { OperationRecord } from './sdk.ts'
const probes: Probe[] = []
afterEach(async () => {
  for (const p of probes.splice(0)) await p.close()
})
const names = [
  'org_create',
  'org_discover',
  'org_authorize',
  'org_revoke',
  'org_send_result',
  'org_message',
  'org_wait',
  'org_finish',
  'execution_submit',
  'execution_query',
  'execution_wait',
  'execution_result',
  'execution_facts',
  'artifact_publish',
  'artifact_read',
]
const role = (creates: Record<string, number>) => ({
  instructions: 'Run only the deterministic tool sequence supplied by the test adapter.',
  model: { provider: 'teams-probe', model: 'script' },
  tools: names,
  creates,
  maxInstances: 3,
})

it('native cross-parent participants execute, wait, exchange persisted job references, read then reply, and publish a sourced artifact', async () => {
  let mounted: Awaited<ReturnType<typeof mountPlatform>> | undefined
  const p = await boot('platform-provider-roundtrip', true, async (root) => {
    const organization: OrganizationConfig = {
      project: 'cross-branch-project',
      rootRole: 'coordinator',
      maxParticipants: 5,
      maxDepth: 2,
      roles: { coordinator: role({ supervisor: 2 }), supervisor: role({ worker: 1 }), worker: role({}) },
      relations: [{ fromRole: 'worker', toRole: 'worker' }],
    }
    const organizationFile = join(root, 'organization.json'),
      deploymentFile = join(root, 'deployment.json')
    await writeFile(organizationFile, JSON.stringify(organization))
    await writeFile(
      deploymentFile,
      JSON.stringify({
        apiVersion: 1,
        enabled: true,
        baseline: HARNESS_BASELINE,
        directory: join(root, 'execution'),
        pollIntervalMs: 2,
        providerCallTimeoutMs: 5000,
        management: {
          actorId: 'test-admin',
          projects: ['cross-branch-project'],
          allowedProviders: ['compute'],
        },
        providers: [
          {
            module: fileURLToPath(new URL('./providers/compute.ts', import.meta.url)),
            config: {
              id: 'compute',
              directory: join(root, 'device'),
              resource: 'one-cpu',
              tickMs: 1,
              chunkSize: 2,
            },
          },
        ],
      }),
    )
    const config: Config = {
      deploymentFile,
      organizationFile,
      task: 'Exercise infrastructure only.',
      budget: 100,
      roleProviders: { coordinator: ['compute'], supervisor: [], worker: ['compute'] },
    }
    return {
      withoutScience: true,
      modules: {
        platform: {
          name: 'platform-test-consumer',
          inject: ['agents', 'subagents', 'tools', 'systemPrompt'],
          async apply(ctx: Context) {
            mounted = await mountPlatform(ctx, config)
          },
        },
      },
    }
  })
  probes.push(p)
  const m = mounted!
  const root = await lead(p, 'platform-root')
  const create = async (parent: Agent, role: string, actor: string) => {
    const gate = new Gate()
    p.model.queue(actor, gate.step())
    const c = await m.org.create(parent, role, `ACTOR ${actor}`, signal())
    await vi.waitFor(() => expect(p.model.requests.some((r) => r.actor === actor)).toBe(true))
    return { agent: p.ctx.agents.get(c.participant.id)!, gate }
  }
  const pa = await create(root.agent, 'supervisor', 'parent-left'),
    pb = await create(root.agent, 'supervisor', 'parent-right')
  const a = await create(pa.agent, 'worker', 'executor-left'),
    b = await create(pb.agent, 'worker', 'executor-right')
  expect(a.agent.session.header.parentSession).toBe(pa.agent.id)
  expect(b.agent.session.header.parentSession).toBe(pb.agent.id)
  expect(pa.agent.id).not.toBe(pb.agent.id)
  for (const [parent, worker, peer] of [
    [pa, a, b],
    [pb, b, a],
  ] as const) {
    p.model.queue(
      parent === pa ? 'parent-left' : 'parent-right',
      toolCallResponse(`consent-${worker.agent.id}`, 'org_authorize', {
        child_id: worker.agent.id,
        peer_child_id: peer.agent.id,
      }),
      new Gate().step(),
    )
    await m.org.message(
      root.agent,
      parent.agent.id,
      'Authorize your exact child and configured peer.',
      signal(),
    )
    parent.gate.release()
  }
  await vi.waitFor(() =>
    expect(
      [pa, pb].every((parent) =>
        parent.agent.session
          .snapshotEvents()
          .some(
            (e) =>
              e.type === 'tool/result' &&
              e.data.message.toolCallId.startsWith('consent-') && !e.data.message.isError,
          ),
      ),
    ).toBe(true),
  )
  const denied = await execute(
    p,
    'execution_submit',
    { provider_id: 'compute', request_key: 'denied', input_json: '{"text":"no permission","iterations":2}' },
    pa.agent,
  )
  expect(denied.isError).toBe(true)
  let operation: OperationRecord | undefined
  let accepted: string | undefined
  let replied = false
  let artifactId: string | undefined
  p.model.queue(
    'executor-left',
    toolCallResponse('submit', 'execution_submit', {
      provider_id: 'compute',
      request_key: 'durable-key',
      input_json: '{"text":"seed","iterations":6}',
    }),
    (options) => {
      operation = toolValue(options, 'submit') as OperationRecord
      return toolCallResponse('wait', 'execution_wait', { operation_id: operation.id, timeout_ms: 5000 })
    },
    (options) => {
      operation = toolValue(options, 'wait') as OperationRecord
      expect(operation.state).toBe('succeeded')
      return toolCallResponse('send', 'org_send_result', {
        target_id: b.agent.id,
        result_id: operation.id,
        kind: 'reference',
      })
    },
    (options) => {
      accepted = (toolValue(options, 'send') as { messageId: string }).messageId
      return textResponse('Reference accepted; settle until the peer replies.')
    },
    (options) => {
      const reply = payload(options, 'reply')
      expect(reply.inReplyTo).toBe(accepted)
      expect(reply.resultId).toBe(operation!.id)
      replied = true
      return toolCallResponse('publish', 'artifact_publish', {
        content: 'Deterministic execution completed; peer read the persisted digest before replying.',
        media_type: 'text/plain',
        source_ids: [operation!.artifacts[0]!.id],
      })
    },
    (options) => {
      artifactId = (toolValue(options, 'publish') as { id: string }).id
      return textResponse('Artifact published.')
    },
  )
  p.model.queue(
    'executor-right',
    (options) => {
      const ref = payload(options, 'reference')
      expect(ref.senderSessionId).toBe(a.agent.id)
      return toolCallResponse('read', 'execution_result', { operation_id: ref.resultId })
    },
    (options) => {
      const result = toolValue(options, 'read') as {
        operation: OperationRecord
        artifacts: { content: string }[]
      }
      expect(result.operation.id).toBe(operation!.id)
      expect(JSON.parse(result.artifacts[0]!.content)).toMatchObject({ complete: true, iterations: 6 })
      const ref = payload(options, 'reference')
      return toolCallResponse('reply', 'org_send_result', {
        target_id: ref.senderSessionId,
        result_id: ref.resultId,
        kind: 'reply',
        in_reply_to: ref.messageId,
      })
    },
    textResponse('Peer result was read and reply accepted.'),
  )
  await m.org.message(pa.agent, a.agent.id, 'Execute the requested job.', signal())
  a.gate.release()
  await vi.waitFor(() => expect(accepted).toBeDefined(), { timeout: 10000 })
  expect(replied).toBe(false)
  b.gate.release()
  await vi.waitFor(() => expect(artifactId).toBeDefined(), { timeout: 10000 })
  expect(replied).toBe(true)
  const privileged = m.access(root.agent, 'execution_facts')
  expect(m.engine.list(privileged)).toHaveLength(1)
  const artifact = m.artifacts.read(privileged, artifactId!)
  expect(artifact.artifact.sources).toEqual([operation!.artifacts[0]!.id])
  const noProvider = m.access(pa.agent, 'artifact_read')
  expect(() => m.artifacts.read(noProvider, operation!.artifacts[0]!.id)).toThrow()
  expect(() => m.artifacts.read(noProvider, artifactId!)).toThrow()
  const db = new DatabaseSync(join(p.root, 'device', 'compute.sqlite'), { readOnly: true })
  expect(db.prepare('SELECT COUNT(*) AS n FROM starts').get()).toMatchObject({ n: 1 })
  db.close()
  const old = await execute(p, 'execution_result', { operation_id: operation!.id }, a.agent)
  expect(old.isError).toBe(true)
  await m.org.close(root.agent)
  const facts = await readFile(join(p.root, 'deployment.json'), 'utf8')
  expect(facts).toContain('compute')
  p.report.status = 'passed'
  p.report.platform = {
    operationId: operation!.id,
    referenceAccepted: accepted,
    replyProcessed: replied,
    artifactId,
    independentProviderStarts: 1,
    parents: [pa.agent.id, pb.agent.id],
    children: [a.agent.id, b.agent.id],
  }
})
