/** Probe supported sibling delivery separately from cross-parent and cross-Team topologies. */
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { boot, branch, execute, Gate, lead, payload, signal, spawn, stored, text, toolValue } from './fixture.ts'
import type { Probe } from './fixture.ts'

const probes: Probe[] = []
afterEach(async () => { for (const probe of probes.splice(0).reverse()) await probe.close() })
async function setup(label: string) { const probe = await boot(label); probes.push(probe); return probe }
async function absent(probe: Probe, id: SessionId) {
  await vi.waitFor(() => expect(probe.ctx.agents.get(id)).toBeUndefined(), { timeout: 10000 })
}
async function live(probe: Probe, id: SessionId): Promise<Agent> {
  return vi.waitFor(() => { const agent = probe.ctx.agents.get(id); expect(agent).toBeDefined(); return agent! })
}
const summary = z.object({ id: z.string(), callerSessionId: z.string(), project: z.string(), samples: z.array(z.number()), mean: z.number(), method: z.string() })
const receipt = z.object({ messageId: z.string(), status: z.enum(['accepted', 'queued']) })
type Summary = z.infer<typeof summary>

for (const targetState of ['running', 'idle', 'inactive'] as const) {
  it(`same Lead only: A persists a result, ${targetState} B reads its reference and replies; receipt is not completion`, async () => {
    const probe = await setup(`roundtrip-${targetState}`)
    const { ctx, model } = probe
    const owner = await lead(probe, `lead-${targetState}`)
    const initialB = new Gate()
    const allowRead = new Gate()
    const helperGate = new Gate()
    model.queue('b', targetState === 'inactive' ? textResponse('B ready') : initialB.step('B ready'))
    const b = (await spawn(probe, owner.agent, 'b')).member
    let bBefore: Agent | undefined
    if (targetState === 'inactive') await absent(probe, b.id)
    else {
      bBefore = await live(probe, b.id)
      if (targetState === 'idle') {
        // Real child ownership retains an idle B Activation. No status or lifetime field is patched.
        model.queue('b-residency-child', helperGate.step('residency helper done'))
        await branch(probe, bBefore, 'b-residency-child')
        initialB.release()
        await bBefore.whenIdle()
        expect(ctx.agents.get(b.id)).toBe(bBefore)
        expect(bBefore.status).toBe('idle')
      } else expect(bBefore.status).toBe('running')
    }
    model.queue('a', textResponse('A ready'))
    const a = (await spawn(probe, owner.agent, 'a')).member
    await absent(probe, a.id)
    expect(ctx.agentTeams.listMembers(owner.agent).find(member => member.id === b.id)?.status).toBe(targetState)
    const aHeader = (await stored(probe, a.id)).header
    const bHeader = (await stored(probe, b.id)).header
    expect(aHeader.parentSession).toBe(owner.agent.id)
    expect(bHeader.parentSession).toBe(owner.agent.id)
    probe.report.topology = { kind: 'same-lead-direct-teammates', lead: owner.agent.id, a: a.id, b: b.id, parents: [aHeader.parentSession, bHeader.parentSession], targetState }

    if (targetState === 'inactive') {
      const noProgress = await execute(probe, 'wait_agent', {}, owner.agent)
      expect(noProgress).toMatchObject({ isError: false, value: { timedOut: false, noProgress: { reason: 'no-active-peer' } } })
      expect(ctx.agents.get(a.id)).toBeUndefined()
      expect(ctx.agents.get(b.id)).toBeUndefined()
      probe.report.inactiveWait = noProgress
    }

    let saved: Summary | undefined
    let forwardReceipt: z.infer<typeof receipt> | undefined
    let replyReceipt: z.infer<typeof receipt> | undefined
    let started = false
    let readFinished = false
    let replySeen = false
    model.queue('a',
      toolCallResponse('a-measure', 'science_measure', { samples: [1, 2, 3] }),
      options => {
        saved = summary.parse(toolValue(options, 'a-measure'))
        expect(saved.callerSessionId).toBe(a.id)
        probe.note('A-result-persisted', saved)
        return toolCallResponse('a-send-ref', 'send_message', {
          target: 'b',
          message: JSON.stringify({ kind: 'science-result-ref', resultId: saved.id, correlation: `roundtrip-${targetState}`, claimedSender: 'untrusted-payload-name' }),
        })
      },
      options => {
        forwardReceipt = receipt.parse(toolValue(options, 'a-send-ref'))
        probe.note('A-send-returned', forwardReceipt)
        return textResponse('A sent result reference; awaiting reply in a later activation')
      },
      options => {
        const reply = payload(options, 'science-result-reply')
        expect(reply).toMatchObject({ resultId: saved!.id, mean: 2, correlation: `roundtrip-${targetState}` })
        replySeen = true
        probe.note('A-reply-processing-started', reply)
        return textResponse(`A confirmed reply for ${String(reply.resultId)}`)
      },
    )
    model.queue('b',
      async options => {
        const ref = payload(options, 'science-result-ref')
        expect(ref.resultId).toBe(saved!.id)
        expect(ref).not.toHaveProperty('mean')
        expect(ref).not.toHaveProperty('samples')
        started = true
        probe.note('B-processing-started', ref)
        await allowRead.wait(options.signal)
        return toolCallResponse('b-read', 'science_read', { id: ref.resultId })
      },
      options => {
        const value = summary.parse(toolValue(options, 'b-read'))
        expect(value).toEqual(saved)
        readFinished = true
        probe.note('B-persisted-result-read', value)
        return toolCallResponse('b-reply', 'send_message', {
          target: 'a', message: JSON.stringify({ kind: 'science-result-reply', resultId: value.id, mean: value.mean, correlation: `roundtrip-${targetState}` }),
        })
      },
      options => {
        replyReceipt = receipt.parse(toolValue(options, 'b-reply'))
        probe.note('B-reply-returned', replyReceipt)
        return textResponse(`B completed read and reply for ${saved!.id}`)
      },
    )
    const change = ctx.agentTeams.waitForChange(owner.agent, 10000, signal())
    await ctx.subagents.sendMessage(owner.agent, a.id, text('Begin the scripted science calculation'), { signal: signal() })
    expect(await change).toEqual({ timedOut: false })
    expect(readFinished).toBe(false)
    probe.note('waitForChange-returned-before-completion')
    await vi.waitFor(() => expect(forwardReceipt).toBeDefined())
    expect(forwardReceipt!.status).toBe('accepted')
    expect(readFinished).toBe(false)
    expect(replySeen).toBe(false)
    await absent(probe, a.id)
    if (targetState === 'running') {
      expect(started).toBe(false)
      const pendingB = ctx.agents.get(b.id)!
      await ctx.sessions.flush(pendingB.session)
      const beforeClaim = (await stored(probe, b.id)).events
      expect(beforeClaim.some(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.source.kind === 'team-message' && message.source.messageId === forwardReceipt!.messageId))).toBe(true)
      expect(beforeClaim.some(event => event.type === 'user/message' && event.data.source.kind === 'team-message')).toBe(false)
      probe.note('accepted-but-not-claimed', { messageId: forwardReceipt!.messageId })
      initialB.release()
    }
    await vi.waitFor(() => expect(started).toBe(true))
    expect(readFinished).toBe(false)
    const activeB = ctx.agents.get(b.id)!
    if (targetState === 'idle') expect(activeB).toBe(bBefore)
    probe.note('B-processing-started-but-not-completed', { sessionId: b.id })
    allowRead.release()
    await vi.waitFor(() => expect(replySeen).toBe(true))
    await vi.waitFor(() => expect(replyReceipt).toBeDefined())
    await absent(probe, a.id)
    if (targetState === 'idle') { await activeB.whenIdle(); await ctx.sessions.flush(activeB.session) }
    else await absent(probe, b.id)
    await owner.agent.whenIdle()
    await ctx.sessions.flush(owner.agent.session)
    const aLog = await stored(probe, a.id)
    const bLog = await stored(probe, b.id)
    const leadLog = await stored(probe, owner.agent.id)
    const bReceived = bLog.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'team-message' && event.data.source.messageId === forwardReceipt!.messageId)
    expect(bReceived).toHaveLength(1)
    expect(bReceived[0]!.data).toMatchObject({ source: { kind: 'team-message', teamId: owner.agent.id, senderId: a.id, senderName: 'a', messageId: forwardReceipt!.messageId } })
    const aReceived = aLog.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'team-message' && event.data.source.messageId === replyReceipt!.messageId)
    expect(aReceived).toHaveLength(1)
    expect(aReceived[0]!.data).toMatchObject({ source: { kind: 'team-message', teamId: owner.agent.id, senderId: b.id, senderName: 'b' } })
    const final = bLog.events.find(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text' && block.text === `B completed read and reply for ${saved!.id}`))
    expect(final).toBeDefined()
    const completion = bLog.events.find(event => event.type === 'turn/end' && event.seq > final!.seq)
    expect(completion).toMatchObject({ data: { reason: { kind: 'completed' } } })
    expect(leadLog.events.filter(event => event.type === 'team/message/queued')).toHaveLength(2)
    expect(leadLog.events.filter(event => event.type === 'team/message/delivered')).toHaveLength(2)
    expect(model.remaining('a')).toBe(0)
    expect(model.remaining('b')).toBe(0)
    probe.report.exchange = { saved, forwardReceipt, replyReceipt, bProcessingStartSeq: bReceived[0]!.seq, bProcessingCompleteSeq: completion!.seq, aReplySeq: aReceived[0]!.seq }
    probe.report.status = 'passed'
    if (targetState === 'idle') helperGate.release()
  })
}

it('creation is Lead-only; exact live callers and per-Team target namespaces are enforced', async () => {
  const probe = await setup('permissions-and-scope')
  const { ctx, model } = probe
  const alpha = await lead(probe, 'lead-alpha')
  const beta = await lead(probe, 'lead-beta')
  const gateA = new Gate()
  model.queue('a', gateA.step())
  const a = (await spawn(probe, alpha.agent, 'a')).member
  const caller = await live(probe, a.id)
  const b = (await spawn(probe, alpha.agent, 'b')).member
  const remoteB = (await spawn(probe, beta.agent, 'b', 'remote-b')).member
  const remoteOnly = (await spawn(probe, beta.agent, 'remote-only')).member
  await absent(probe, b.id); await absent(probe, remoteB.id); await absent(probe, remoteOnly.id)
  expect(ctx.agentTeams.membership(alpha.agent)).toMatchObject({ role: 'lead', id: alpha.agent.id })
  expect(ctx.agentTeams.membership(caller)).toMatchObject({ role: 'teammate', id: alpha.agent.id })
  await expect(spawn(probe, caller, 'forbidden-nested')).rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
  expect(await execute(probe, 'spawn_teammate', { name: 'forbidden-tool-child', description: 'negative', prompt: 'never run' }, caller)).toMatchObject({ isError: true })
  expect(await execute(probe, 'send_message', { target: 'b', message: 'missing caller' })).toMatchObject({ isError: true })
  expect(ctx.agentTeams.listMembers(caller).map(member => member.id)).toEqual([alpha.agent.id, a.id, b.id])
  const measurement = await execute(probe, 'science_measure', { samples: [1, 2, 3] }, caller)
  if (measurement.isError) throw new Error('measurement failed')
  const saved = summary.parse(measurement.value)
  const ref = text(JSON.stringify({ kind: 'science-result-ref', resultId: saved.id }))
  const remoteBefore = (await stored(probe, remoteB.id)).events.length
  const rejected: { target: string; code: string }[] = []
  for (const target of ['remote-only', remoteB.id, 'lead-beta/b']) {
    await expect(ctx.agentTeams.sendMessage(caller, { target, content: ref, signal: signal() })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
    rejected.push({ target, code: 'TEAM_MEMBER_NOT_FOUND' })
  }
  const ownReceipt = await ctx.agentTeams.sendMessage(caller, { target: 'b', content: ref, signal: signal() })
  await absent(probe, b.id)
  const ownLog = await stored(probe, b.id)
  expect(ownLog.events.some(event => event.type === 'user/message' && event.data.source.kind === 'team-message' && event.data.source.messageId === ownReceipt.messageId)).toBe(true)
  expect((await stored(probe, remoteB.id)).events).toHaveLength(remoteBefore)
  expect(ctx.agents.get(remoteB.id)).toBeUndefined()
  gateA.release()
  await absent(probe, a.id)
  const holdAgain = new Gate()
  model.queue('a', holdAgain.step())
  await ctx.agentTeams.sendMessage(alpha.agent, { target: 'a', content: ref, signal: signal() })
  const reactivated = await live(probe, a.id)
  expect(reactivated).not.toBe(caller)
  expect(reactivated.id).toBe(caller.id)
  await expect(ctx.agentTeams.sendMessage(caller, { target: 'b', content: ref, signal: signal() })).rejects.toMatchObject({ code: 'TEAM_NOT_MEMBER' })
  await expect(spawn(probe, caller, 'stale-child')).rejects.toMatchObject({ code: 'TEAM_NOT_MEMBER' })
  expect(ctx.agentTeams.tryMembership(caller)).toBeUndefined()
  expect(ctx.agentTeams.membership(reactivated).role).toBe('teammate')
  probe.report.authorization = { creator: alpha.agent.id, forbiddenCreator: a.id, creationCode: 'TEAM_LEAD_REQUIRED', staleCode: 'TEAM_NOT_MEMBER', rejected, ownTarget: b.id, foreignTarget: remoteB.id, savedResultId: saved.id }
  probe.report.status = 'passed'
  holdAgain.release()
})

it('real research-branch children are outside Team membership and cannot communicate across their different parents', async () => {
  const probe = await setup('different-research-parents')
  const { ctx, model } = probe
  const owner = await lead(probe, 'research-lead')
  const gates = new Map(['research-a', 'research-b', 'midbrain-a', 'midbrain-b'].map(actor => [actor, new Gate()]))
  for (const [actor, gate] of gates) model.queue(actor, gate.step())
  const researchA = (await spawn(probe, owner.agent, 'research-a')).member
  const researchB = (await spawn(probe, owner.agent, 'research-b')).member
  const ra = await live(probe, researchA.id)
  const rb = await live(probe, researchB.id)
  await expect(spawn(probe, ra, 'midbrain-via-team')).rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
  const midA = await branch(probe, ra, 'midbrain-a')
  const midB = await branch(probe, rb, 'midbrain-b')
  const ma = await live(probe, midA.childId)
  const mb = await live(probe, midB.childId)
  await vi.waitFor(() => expect(model.requests.some(request => request.actor === 'midbrain-b')).toBe(true))
  expect(ma.session.header.parentSession).toBe(ra.id)
  expect(mb.session.header.parentSession).toBe(rb.id)
  expect(ra.id).not.toBe(rb.id)
  expect(ctx.agentTeams.tryMembership(ma)).toBeUndefined()
  expect(ctx.agentTeams.tryMembership(mb)).toBeUndefined()
  const measured = await execute(probe, 'science_measure', { samples: [1, 2, 3] }, ma)
  if (measured.isError) throw new Error('measurement failed')
  const saved = summary.parse(measured.value)
  const ref = text(JSON.stringify({ kind: 'science-result-ref', resultId: saved.id }))
  const bSeq = mb.session.seq
  const bRequests = model.requests.filter(request => request.actor === 'midbrain-b').length
  const leadQueueCount = owner.agent.session.snapshotEvents().filter(event => event.type === 'team/message/queued').length
  await expect(ctx.agentTeams.sendMessage(ma, { target: 'midbrain-b', content: ref, signal: signal() })).rejects.toMatchObject({ code: 'TEAM_NOT_MEMBER' })
  await expect(ctx.agentTeams.sendMessage(ra, { target: mb.id, content: ref, signal: signal() })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
  await expect(ctx.subagents.sendMessage(ma, mb.id, ref, { signal: signal() })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  await expect(spawn(probe, ma, 'nested-team')).rejects.toMatchObject({ code: 'TEAM_NOT_MEMBER' })
  expect(mb.session.seq).toBe(bSeq)
  expect(model.requests.filter(request => request.actor === 'midbrain-b')).toHaveLength(bRequests)
  expect(owner.agent.session.snapshotEvents().filter(event => event.type === 'team/message/queued')).toHaveLength(leadQueueCount)
  probe.report.topology = {
    kind: 'distinct-research-parents', root: owner.agent.id,
    researchA: ra.id, researchB: rb.id, midbrainA: ma.id, midbrainB: mb.id,
    midbrainAParent: ma.session.header.parentSession, midbrainBParent: mb.session.header.parentSession,
    savedResultId: saved.id, teamSend: 'TEAM_NOT_MEMBER', directSend: 'UNAUTHORIZED', receiverContinued: false,
  }
  probe.report.status = 'passed'
  for (const gate of gates.values()) gate.release()
})
