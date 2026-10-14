/** Deterministic external-model scripts through the real Loader and native continuable Agent tree. */
import { afterEach, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { boot, Gate, lead, signal, execute, type Probe } from './organization-fixture.ts'
import { createOrganization, organizationSchema, type OrganizationConfig } from './organization.ts'
import { installOrganizationTools } from './host-plugin.ts'
const worlds: Probe[] = []
afterEach(async () => {
  for (const p of worlds.splice(0)) await p.close()
})
const tools = [
  'org_create',
  'org_discover',
  'org_authorize',
  'org_revoke',
  'org_send_result',
  'org_message',
  'org_wait',
  'org_finish',
  'science_measure',
  'science_read',
]
const role = (creates: Record<string, number> = {}) => ({
  instructions: 'Deterministic organization fixture',
  model: { provider: 'teams-probe', model: 'script' },
  tools,
  creates,
  maxInstances: 10,
})
function config(shape: 'fork' | 'chain'): OrganizationConfig {
  return {
    project: 'cross-branch-project',
    rootRole: 'coordinator',
    maxParticipants: 12,
    maxDepth: 3,
    roles:
      shape === 'fork'
        ? { coordinator: role({ supervisor: 3 }), supervisor: role({ worker: 2 }), worker: role() }
        : {
            coordinator: role({ relay: 1 }),
            relay: role({ supervisor: 1 }),
            supervisor: role({ worker: 1 }),
            worker: role(),
          },
    relations: [{ fromRole: 'worker', toRole: 'worker' }],
  }
}
async function setup(shape: 'fork' | 'chain') {
  const p = await boot(`organization-${shape}`)
  worlds.push(p)
  const events: unknown[] = []
  const org = createOrganization(p.ctx, config(shape), {
    record: (event, data) => events.push({ event, data }),
  })
  installOrganizationTools(p.ctx, org)
  const root = await lead(p, 'root')
  org.registerRoot(root.agent, 'Configured test organization')
  return { p, org, root, events }
}
async function held(w: Awaited<ReturnType<typeof setup>>, parent: Agent, role: string, label: string) {
  const gate = new Gate()
  w.p.model.queue(label, gate.step())
  const created = await w.org.create(parent, role, `ACTOR ${label}`, signal())
  await vi.waitFor(() => expect(w.p.model.requests.some((r) => r.actor === label)).toBe(true))
  return { agent: w.p.ctx.agents.get(created.participant.id)!, gate, created }
}
for (const shape of ['fork', 'chain'] as const)
  it(`${shape} config creates real parents dynamically, waits on native inbox, and drains without changing organization code`, async () => {
    const w = await setup(shape)
    let owner = w.root.agent
    const parents: Agent[] = []
    for (const [index, r] of (shape === 'fork' ? ['supervisor'] : ['relay', 'supervisor']).entries()) {
      const node = await held(w, owner, r, `parent-${index}`)
      parents.push(node.agent)
      owner = node.agent
    }
    const worker = await held(w, owner, 'worker', 'worker')
    expect(worker.agent.session.header.parentSession).toBe(owner.id)
    expect(w.org.discover(worker.agent).map((p) => p.id)).toContain(owner.id)
    const waiting = w.org.wait(worker.agent, 5000, signal())
    await w.org.message(owner, worker.agent.id, 'Wake from native message', signal())
    expect(await waiting).toEqual({ reason: 'message' })
    const log = worker.agent.session.snapshotEvents()
    expect(
      log.some(
        (e) =>
          e.type === 'agent/inbox/spliced' &&
          e.data.inserted.some((m) =>
            m.content.some((b) => b.type === 'text' && b.text === 'Wake from native message'),
          ),
      ),
    ).toBe(true)
    await expect(w.org.create(worker.agent, 'supervisor', 'forbidden', signal())).rejects.toThrow('denied')
    await w.org.close(w.root.agent)
    expect(parents.every((p) => w.p.ctx.agents.get(p.id) === undefined)).toBe(true)
    expect(w.p.ctx.agents.get(worker.agent.id)).toBeUndefined()
    w.p.report.status = 'passed'
    w.p.report.organizationEvents = w.events
  })
it('model tool calls create a configured role at runtime with configured model and tool visibility', async () => {
  const w = await setup('fork')
  const gate = new Gate()
  w.p.model.queue('child-from-tool', gate.step())
  w.p.model.queue(
    'lead',
    toolCallResponse('dynamic', 'org_create', { role: 'supervisor', task: 'ACTOR child-from-tool' }),
    textResponse('Delegated'),
  )
  w.root.agent.followup(
    createUserMessage({
      content: [{ type: 'text', text: 'Create the permitted participant now.' }],
      source: { kind: 'user' },
    }),
  )
  await vi.waitFor(() => expect(w.p.model.requests.some((r) => r.actor === 'child-from-tool')).toBe(true))
  const child = w.org.discover(w.root.agent).find((p) => p.role === 'supervisor')!
  expect(w.p.ctx.agents.get(child.id)?.session.header.parentSession).toBe(w.root.agent.id)
  expect(w.p.ctx.agents.get(child.id)?.options).toMatchObject({ provider: 'teams-probe', model: 'script' })
  expect(
    w.root.agent.session
      .snapshotEvents()
      .some(
        (e) =>
          e.type === 'tool/result' &&
          e.data.message.toolCallId === 'dynamic' && !e.data.message.isError,
      ),
  ).toBe(true)
  await w.org.close(w.root.agent)
  w.p.report.status = 'passed'
})
it('multiple explicit pairs retain provenance, scoped revoke, old-instance and project rejection', async () => {
  const w = await setup('fork')
  const parents = await Promise.all(
    [0, 1, 2].map((i) => held(w, w.root.agent, 'supervisor', `supervisor-${i}`)),
  )
  const workers = await Promise.all(parents.map((p, i) => held(w, p.agent, 'worker', `worker-${i}`)))
  const [a, b, c] = workers.map((x) => x.agent) as [Agent, Agent, Agent]
  const measured = await execute(w.p, 'science_measure', { samples: [1, 2, 3] }, a)
  expect(measured.isError).toBe(false)
  const resultId = (measured.value as { id: string }).id
  await expect(w.org.send(a, b.id, { kind: 'reference', resultId }, signal())).rejects.toMatchObject({
    code: 'SCIENCE_NO_GRANT',
  })
  for (const index of [1, 2]) {
    await w.org.authorize(parents[0]!.agent, a.id, workers[index]!.agent.id, signal())
    await w.org.authorize(parents[index]!.agent, workers[index]!.agent.id, a.id, signal())
  }
  const accepted = await w.org.send(a, b.id, { kind: 'reference', resultId }, signal())
  expect(
    b.session
      .snapshotEvents()
      .some(
        (e) =>
          e.type === 'agent/inbox/spliced' &&
          e.data.inserted.some(
            (m) =>
              m.id === accepted && m.source.kind === 'science-result' && m.source.senderSessionId === a.id,
          ),
      ),
  ).toBe(true)
  w.org.revoke(parents[0]!.agent, a.id, b.id)
  await expect(w.org.send(a, b.id, { kind: 'reference', resultId }, signal())).rejects.toMatchObject({
    code: 'SCIENCE_TARGET_DENIED',
  })
  expect(await w.org.send(a, c.id, { kind: 'reference', resultId }, signal())).toBeTruthy()
  await expect(
    w.org.send({ ...a } as Agent, c.id, { kind: 'reference', resultId }, signal()),
  ).rejects.toThrow('Exact live')
  await expect(
    w.org.send(a, SessionId('unrelated-project'), { kind: 'reference', resultId }, signal()),
  ).rejects.toThrow('denied')
  await expect(
    w.org.send(a, c.id, { kind: 'reference', resultId: 'foreign-result' }, signal()),
  ).rejects.toMatchObject({ code: 'SCIENCE_RESULT_UNAVAILABLE' })
  await w.p.ctx.subagents.drainChildren(w.root.agent, [parents[2]!.agent.id])
  expect(w.p.ctx.agents.get(parents[2]!.agent.id)).toBeUndefined()
  await expect(w.org.send(a, c.id, { kind: 'reference', resultId }, signal())).rejects.toMatchObject({
    code: 'SCIENCE_NO_GRANT',
  })
  await w.org.close(w.root.agent)
  w.p.report.status = 'passed'
  w.p.report.organizationEvents = w.events
})
it('configuration and unconfigured capability calls fail closed', async () => {
  expect(() => organizationSchema.parse({ ...config('fork'), rootRole: 'absent' })).toThrow('Unknown role')
  const w = await setup('fork')
  expect(() => w.org.assertActor(w.root.agent, 'shell')).toThrow('cannot use')
  const foreign = await lead(w.p, 'foreign')
  expect(() => w.org.discover(foreign.agent)).toThrow('Exact live')
  expect(() => createOrganization(w.p.ctx, { ...config('fork'), project: 'foreign' })).toThrow(
    'matching project',
  )
  await w.org.close(w.root.agent)
  w.p.report.status = 'passed'
})
it('unloading organization drains participants and revokes inner-parent consent without stopping unrelated host state', async () => {
  const p = await boot('organization-unload')
  worlds.push(p)
  let org: ReturnType<typeof createOrganization> | undefined
  const scope = p.ctx.plugin({
    name: 'unloadable-organization',
    inject: ['agents', 'subagents', 'tools', 'systemPrompt'],
    apply(ctx) {
      org = createOrganization(ctx, config('fork'))
      installOrganizationTools(ctx, org)
    },
  })
  await scope
  const root = await lead(p, 'unload-root')
  org!.registerRoot(root.agent, 'Unload fixture')
  const w = { p, org: org!, root, events: [] }
  const pa = await held(w, root.agent, 'supervisor', 'parent-a'),
    pb = await held(w, root.agent, 'supervisor', 'parent-b')
  const a = await held(w, pa.agent, 'worker', 'child-a'),
    b = await held(w, pb.agent, 'worker', 'child-b')
  await org!.authorize(pa.agent, a.agent.id, b.agent.id, signal())
  await org!.authorize(pb.agent, b.agent.id, a.agent.id, signal())
  const noMessage = org!.wait(a.agent, 10, signal())
  expect(await noMessage).toEqual({ reason: 'timeout' })
  const controller = new AbortController()
  const aborted = org!.wait(a.agent, 5000, controller.signal)
  controller.abort(new Error('Wait canceled'))
  await expect(aborted).rejects.toThrow('Wait canceled')
  expect(a.agent.status).toBe('running')
  await scope.dispose()
  expect(p.ctx.agents.get(root.agent.id)).toBe(root.agent)
  expect([pa, pb, a, b].every((v) => p.ctx.agents.get(v.agent.id) === undefined)).toBe(true)
  await expect(
    p.ctx.subagents.scienceResults!.send(
      a.agent,
      b.agent.id,
      { kind: 'reference', resultId: 'any' },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'SCIENCE_NO_GRANT' })
  expect(() => org!.assertActor(root.agent)).toThrow('Exact live')
  p.report.status = 'passed'
})
