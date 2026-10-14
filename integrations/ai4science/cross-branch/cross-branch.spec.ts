/** Cross-research-parent probes for the opt-in host patch; no Team peer routing is used. */
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { boot, branch, execute, Gate, lead, payload, signal, stored, text, toolValue } from './fixture.ts'
import type { Probe } from './fixture.ts'

const probes: Probe[] = []
afterEach(async () => { for (const probe of probes.splice(0).reverse()) await probe.close() })
async function setup(label: string, enabled = true) { const probe = await boot(label, enabled); probes.push(probe); return probe }
async function absent(p: Probe, id: SessionId) { await vi.waitFor(() => expect(p.ctx.agents.get(id)).toBeUndefined(), { timeout: 10000 }) }
const measurement = z.object({ id: z.string(), project: z.string(), callerSessionId: z.string(), samples: z.array(z.number()), mean: z.number(), method: z.string() })
type Measurement = z.infer<typeof measurement>
const receipt = z.object({ messageId: z.string() })

async function parents(p: Probe) {
  const root = await lead(p, 'project-root')
  const gateA = new Gate(); const gateB = new Gate()
  p.model.queue('research-a', gateA.step('research-a ready'))
  p.model.queue('research-b', gateB.step('research-b ready'))
  const pa = await branch(p, root.agent, 'research-a')
  const pb = await branch(p, root.agent, 'research-b')
  const ra = p.ctx.agents.get(pa.childId)!
  const rb = p.ctx.agents.get(pb.childId)!
  return { root, ra, rb, gateA, gateB }
}
async function workers(p: Probe) {
  const world = await parents(p)
  const holdA = new Gate(); const holdB = new Gate()
  p.model.queue('midbrain-a', holdA.step()); p.model.queue('midbrain-b', holdB.step())
  const a = await branch(p, world.ra, 'midbrain-a')
  const b = await branch(p, world.rb, 'midbrain-b')
  await vi.waitFor(() => expect(p.model.requests.some(r => r.actor === 'midbrain-b')).toBe(true))
  return { ...world, a: p.ctx.agents.get(a.childId)!, b: p.ctx.agents.get(b.childId)!, holdA, holdB }
}
function consentArgs(worker: string, peer: string, peerParent: string) {
  return { worker_id: worker, peer_id: peer, peer_parent_id: peerParent }
}
async function authorize(p: Probe, ra: Agent, rb: Agent) {
  expect(await execute(p, 'science_authorize_peer', consentArgs('midbrain-a', 'midbrain-b', rb.id), ra)).toMatchObject({ isError: false })
  expect(await execute(p, 'science_authorize_peer', consentArgs('midbrain-b', 'midbrain-a', ra.id), rb)).toMatchObject({ isError: false })
}
async function result(p: Probe, a: Agent) {
  const value = await execute(p, 'science_measure', { samples: [1, 2, 3] }, a)
  if (value.isError) throw new Error('measurement failed')
  return measurement.parse(value.value)
}

for (const state of ['running', 'idle', 'inactive'] as const) {
  it(`different research parents: ${state} recipient reads a persisted reference and replies after both parent models consent`, async () => {
    const p = await setup(`roundtrip-${state}`)
    const { ctx, model } = p
    const world = await parents(p)
    const initialB = new Gate(); const keepB = new Gate(); const readGate = new Gate()
    model.queue('midbrain-a', textResponse('A ready'))
    model.queue('midbrain-b', state === 'inactive' ? textResponse('B ready') : initialB.step('B ready'))
    const a = (await branch(p, world.ra, 'midbrain-a')).childId
    const b = (await branch(p, world.rb, 'midbrain-b')).childId
    await absent(p, a)
    let previousB: Agent | undefined
    if (state === 'inactive') await absent(p, b)
    else {
      previousB = ctx.agents.get(b)!
      if (state === 'idle') {
        model.queue('b-residency', keepB.step())
        await branch(p, previousB, 'b-residency')
        initialB.release(); await previousB.whenIdle()
      }
      expect(previousB.status).toBe(state)
    }
    // Both grants come from actual model-issued tool calls by the two real parents.
    model.queue('research-a', toolCallResponse('consent-a', 'science_authorize_peer', consentArgs(a, b, world.rb.id)), new Gate().step())
    model.queue('research-b', toolCallResponse('consent-b', 'science_authorize_peer', consentArgs(b, a, world.ra.id)), new Gate().step())
    await ctx.subagents.sendMessage(world.root.agent, world.ra.id, text('Authorize the exact science peer'), { signal: signal() })
    await ctx.subagents.sendMessage(world.root.agent, world.rb.id, text('Authorize the reverse exact science peer'), { signal: signal() })
    world.gateA.release(); world.gateB.release()
    for (const [parent, callId] of [[world.ra, 'consent-a'], [world.rb, 'consent-b']] as const) {
      await vi.waitFor(() => expect(parent.session.snapshotEvents().some(event => event.type === 'tool/result' && event.data.message.toolCallId === callId && !event.data.message.isError)).toBe(true))
    }
    let saved: Measurement | undefined
    let sent: string | undefined
    let replied: string | undefined
    let started = false
    let read = false
    let replyProcessed = false
    model.queue('midbrain-a',
      toolCallResponse('measure-a', 'science_measure', { samples: [1, 2, 3] }),
      options => {
        saved = measurement.parse(toolValue(options, 'measure-a'))
        p.note('A-persisted-result', saved)
        return toolCallResponse('send-a', 'science_send_result', { target_id: b, kind: 'reference', result_id: saved.id })
      },
      options => {
        sent = receipt.parse(toolValue(options, 'send-a')).messageId
        p.note('reference-accepted', { messageId: sent })
        return textResponse('A sent reference; current activation can settle')
      },
      options => {
        const response = payload(options, 'reply')
        expect(response).toMatchObject({ resultId: saved!.id, inReplyTo: sent })
        replyProcessed = true
        p.note('A-reply-processed', response)
        return textResponse(`A finished ${saved!.id}`)
      },
    )
    model.queue('midbrain-b',
      async options => {
        const ref = payload(options, 'reference')
        expect(ref).toMatchObject({ resultId: saved!.id, project: 'cross-branch-project', senderSessionId: a })
        expect(ref).not.toHaveProperty('mean'); expect(ref).not.toHaveProperty('samples')
        started = true
        p.note('B-processing-started', ref)
        await readGate.wait(options.signal)
        return toolCallResponse('read-b', 'science_read', { id: ref.resultId })
      },
      options => {
        expect(measurement.parse(toolValue(options, 'read-b'))).toEqual(saved)
        read = true
        const ref = payload(options, 'reference')
        p.note('B-read-complete', { resultId: saved!.id })
        return toolCallResponse('reply-b', 'science_send_result', { target_id: ref.senderSessionId, kind: 'reply', result_id: saved!.id, in_reply_to: ref.messageId })
      },
      options => {
        replied = receipt.parse(toolValue(options, 'reply-b')).messageId
        p.note('reply-accepted', { messageId: replied })
        return textResponse(`B finished ${saved!.id}`)
      },
    )
    await ctx.subagents.sendMessage(world.ra, a, text('Begin science calculation'), { signal: signal() })
    await vi.waitFor(() => expect(sent).toBeDefined())
    expect(read).toBe(false); expect(replyProcessed).toBe(false)
    await absent(p, a)
    if (state === 'running') {
      expect(started).toBe(false)
      await ctx.sessions.flush(previousB!.session)
      const pending = (await stored(p, b)).events
      expect(pending.some(e => e.type === 'agent/inbox/spliced' && e.data.inserted.some(m => m.id === sent))).toBe(true)
      expect(pending.some(e => e.type === 'user/message' && e.data.id === sent)).toBe(false)
      p.note('accepted-not-processed', { messageId: sent })
      initialB.release()
    }
    await vi.waitFor(() => expect(started).toBe(true))
    expect(read).toBe(false)
    if (state === 'idle') expect(ctx.agents.get(b)).toBe(previousB)
    readGate.release()
    await vi.waitFor(() => expect(replyProcessed).toBe(true))
    await vi.waitFor(() => expect(replied).toBeDefined())
    await absent(p, a)
    if (state === 'idle') { await previousB!.whenIdle(); await ctx.sessions.flush(previousB!.session) }
    else await absent(p, b)
    const aLog = await stored(p, a); const bLog = await stored(p, b)
    expect(aLog.header.parentSession).toBe(world.ra.id)
    expect(bLog.header.parentSession).toBe(world.rb.id)
    expect(world.ra.id).not.toBe(world.rb.id)
    expect(ctx.agents.get(world.ra.id)).toBe(world.ra); expect(ctx.agents.get(world.rb.id)).toBe(world.rb)
    const forward = bLog.events.find(e => e.type === 'user/message' && e.data.id === sent)
    expect(forward?.data).toMatchObject({ source: { kind: 'science-result', senderSessionId: a, senderParentSessionId: world.ra.id, recipientParentSessionId: world.rb.id, project: 'cross-branch-project' } })
    const reverse = aLog.events.find(e => e.type === 'user/message' && e.data.id === replied)
    expect(reverse?.data).toMatchObject({ source: { kind: 'science-result', senderSessionId: b, senderParentSessionId: world.rb.id, recipientParentSessionId: world.ra.id } })
    const final = bLog.events.find(e => e.type === 'assistant/message' && e.data.message.content.some(t => t.type === 'text' && t.text === `B finished ${saved!.id}`))!
    const complete = bLog.events.find(e => e.type === 'turn/end' && e.seq > final.seq)
    expect(complete).toMatchObject({ data: { reason: { kind: 'completed' } } })
    expect(saved!.callerSessionId).toBe(a)
    p.report.exchange = { state, saved, sent, replied, root: world.root.agent.id, parents: [world.ra.id, world.rb.id], children: [a, b], actualParents: [aLog.header.parentSession, bLog.header.parentSession], startSeq: forward!.seq, completedSeq: complete!.seq }
    p.report.status = 'passed'
    if (state === 'idle') keepB.release()
  })
}

it('requires both true parents, exact live workers, an authorized target and an existing project-owned result', async () => {
  const p = await setup('authorization-negatives'); const w = await workers(p)
  const exchange = p.ctx.subagents.scienceResults!
  const saved = await result(p, w.a)
  const send = () => exchange.send(w.a, w.b.id, { kind: 'reference', resultId: saved.id }, signal())
  await expect(send()).rejects.toMatchObject({ code: 'SCIENCE_NO_GRANT' })
  await exchange.authorize(w.ra, { childId: w.a.id, peerChildId: w.b.id, peerParent: w.rb }, signal())
  await expect(send()).rejects.toMatchObject({ code: 'SCIENCE_NO_GRANT' })
  await expect(exchange.authorize(w.ra, { childId: w.b.id, peerChildId: w.a.id, peerParent: w.rb }, signal())).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  await expect(exchange.authorize(w.a, { childId: w.a.id, peerChildId: w.b.id, peerParent: w.rb }, signal())).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  await exchange.authorize(w.rb, { childId: w.b.id, peerChildId: w.a.id, peerParent: w.ra }, signal())
  expect(() => exchange.revoke(w.root.agent)).toThrow(expect.objectContaining({ code: 'SCIENCE_NO_GRANT' }))
  await expect(exchange.send(w.a, w.ra.id, { kind: 'reference', resultId: saved.id }, signal())).rejects.toMatchObject({ code: 'SCIENCE_TARGET_DENIED' })
  await expect(exchange.send(w.a, w.b.id, { kind: 'reference', resultId: 'missing' }, signal())).rejects.toMatchObject({ code: 'SCIENCE_RESULT_UNAVAILABLE' })
  await expect(exchange.send(w.b, w.a.id, { kind: 'reference', resultId: saved.id }, signal())).rejects.toMatchObject({ code: 'SCIENCE_RESULT_OWNER' })
  await expect(exchange.send(w.b, w.a.id, { kind: 'reply', resultId: saved.id, inReplyTo: MessageId('fake') }, signal())).rejects.toMatchObject({ code: 'SCIENCE_REPLY_MISMATCH' })
  expect(await execute(p, 'science_send_result', { target_id: w.b.id, kind: 'reference', result_id: saved.id })).toMatchObject({ isError: true })
  await expect(exchange.send(w.a, w.b.id, { kind: 'reference', resultId: saved.id, project: 'foreign', command: 'run arbitrary work' } as never, signal())).rejects.toThrow()
  await expect(p.ctx.subagents.sendMessage(w.a, w.b.id, text(saved.id), { signal: signal() })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  await expect(p.ctx.agentTeams.sendMessage(w.a, { target: 'midbrain-b', content: text(saved.id), signal: signal() })).rejects.toMatchObject({ code: 'TEAM_NOT_MEMBER' })
  expect(w.b.session.snapshotEvents().filter(e => e.type === 'agent/inbox/spliced' && e.data.inserted.some(m => m.source.kind === 'science-result'))).toHaveLength(0)
  p.report.rejections = ['no-consent', 'one-sided-consent', 'wrong-owning-parent', 'worker-grants', 'unrelated-target', 'missing-result', 'wrong-result-owner', 'unmatched-reply', 'missing-caller', 'foreign-project-and-arbitrary-content', 'legacy-parent-check', 'unchanged-Team-check']
  p.report.status = 'passed'
})

it('rejects a stale worker after cold resume of the same Session id', async () => {
  const p = await setup('stale-worker'); const w = await workers(p)
  await authorize(p, w.ra, w.rb)
  const saved = await result(p, w.a)
  w.holdA.release(); await absent(p, w.a.id)
  p.model.queue('midbrain-a', new Gate().step())
  await p.ctx.subagents.sendMessage(w.ra, w.a.id, text('resume same worker'), { signal: signal() })
  const current = p.ctx.agents.get(w.a.id)!
  expect(current).not.toBe(w.a)
  await expect(p.ctx.subagents.scienceResults!.send(w.a, w.b.id, { kind: 'reference', resultId: saved.id }, signal())).rejects.toMatchObject({ code: 'SCIENCE_STALE_AGENT' })
  const accepted = await p.ctx.subagents.scienceResults!.send(current, w.b.id, { kind: 'reference', resultId: saved.id }, signal())
  expect(accepted).toBeTypeOf('string')
  p.report.status = 'passed'
})

for (const invalidParent of ['sender', 'recipient'] as const) {
  it(`${invalidParent} parent disposal/replacement invalidates old consent, even for the same parent Session id`, async () => {
    const p = await setup(`replaced-${invalidParent}-parent`); const w = await workers(p)
    await authorize(p, w.ra, w.rb)
    const saved = await result(p, w.a)
    const oldParent = invalidParent === 'sender' ? w.ra : w.rb
    await p.ctx.subagents.drainChildren(w.root.agent, [oldParent.id])
    expect(p.ctx.agents.get(oldParent.id)).toBeUndefined()
    await expect(p.ctx.subagents.scienceResults!.send(w.a, w.b.id, { kind: 'reference', resultId: saved.id }, signal())).rejects.toMatchObject({ code: 'SCIENCE_NO_GRANT' })
    p.model.queue(oldParent.id, new Gate().step())
    await p.ctx.subagents.sendMessage(w.root.agent, oldParent.id, text('resume research parent'), { signal: signal() })
    const newParent = p.ctx.agents.get(oldParent.id)!
    expect(newParent).not.toBe(oldParent)
    const exchange = p.ctx.subagents.scienceResults!
    await expect(exchange.authorize(oldParent, { childId: invalidParent === 'sender' ? w.a.id : w.b.id, peerChildId: invalidParent === 'sender' ? w.b.id : w.a.id, peerParent: invalidParent === 'sender' ? w.rb : w.ra }, signal())).rejects.toMatchObject({ code: 'SCIENCE_STALE_AGENT' })
    await expect(exchange.send(w.a, w.b.id, { kind: 'reference', resultId: saved.id }, signal())).rejects.toMatchObject({ code: 'SCIENCE_NO_GRANT' })
    p.report.parentReplacement = { side: invalidParent, id: oldParent.id, oldObjectDenied: true, oldConsentInvalid: true }
    p.report.status = 'passed'
  })
}

it('revocation during cold publication wins before acceptance and rolls back the target activation', async () => {
  const p = await setup('revoke-before-acceptance'); const w = await workers(p)
  await authorize(p, w.ra, w.rb)
  const saved = await result(p, w.a)
  w.holdB.release(); await absent(p, w.b.id)
  const exchange = p.ctx.subagents.scienceResults!
  const stop = p.ctx.on('agent/created', ({ agent }) => {
    if (agent.id === w.b.id) { p.note('revoked-at-cold-publication'); exchange.revoke(w.ra) }
  })
  await expect(exchange.send(w.a, w.b.id, { kind: 'reference', resultId: saved.id }, signal())).rejects.toThrow()
  stop()
  await absent(p, w.b.id)
  expect((await stored(p, w.b.id)).events.some(e => e.type === 'agent/inbox/spliced' && e.data.inserted.some(m => m.source.kind === 'science-result'))).toBe(false)
  p.report.boundary = 'revoked before final synchronous enqueue: no receipt, no science inbox item, cold activation rolled back'
  p.report.status = 'passed'
})

it('rejects a parent that has begun disposal before its old object leaves the registry', async () => {
  const p = await setup('parent-disposal-cutoff'); const w = await workers(p)
  await authorize(p, w.ra, w.rb)
  const saved = await result(p, w.a)
  const closing = p.ctx.subagents.drainChildren(w.root.agent, [w.rb.id])
  expect(p.ctx.agents.get(w.rb.id)).toBe(w.rb)
  await expect(p.ctx.subagents.scienceResults!.send(w.a, w.b.id, { kind: 'reference', resultId: saved.id }, signal())).rejects.toMatchObject({ code: 'SCIENCE_STALE_AGENT' })
  await closing
  expect((await stored(p, w.b.id)).events.some(e => e.type === 'agent/inbox/spliced' && e.data.inserted.some(m => m.source.kind === 'science-result'))).toBe(false)
  p.report.boundary = 'parent disposal transaction is an immediate authority cutoff, before registry removal'
  p.report.status = 'passed'
})

it('revocation from the committed inbox event cannot recall acceptance, but blocks later sends and replies', async () => {
  const p = await setup('revoke-after-acceptance'); const w = await workers(p)
  await authorize(p, w.ra, w.rb)
  const saved = await result(p, w.a)
  const exchange = p.ctx.subagents.scienceResults!
  const stop = p.ctx.on('session/event', (session, event) => {
    if (session.id === w.b.id && event.type === 'agent/inbox/spliced' && event.data.inserted.some(m => m.source.kind === 'science-result')) {
      p.note('revoked-after-inbox-commit'); exchange.revoke(w.rb)
    }
  })
  const id = await exchange.send(w.a, w.b.id, { kind: 'reference', resultId: saved.id }, signal())
  stop()
  expect(w.b.inbox.nextStep.some(message => message.id === id)).toBe(true)
  await expect(exchange.send(w.a, w.b.id, { kind: 'reference', resultId: saved.id }, signal())).rejects.toMatchObject({ code: 'SCIENCE_NO_GRANT' })
  await expect(exchange.send(w.b, w.a.id, { kind: 'reply', resultId: saved.id, inReplyTo: id }, signal())).rejects.toMatchObject({ code: 'SCIENCE_NO_GRANT' })
  p.model.queue('midbrain-b', options => {
    expect(payload(options, 'reference')).toMatchObject({ messageId: id, resultId: saved.id })
    return toolCallResponse('read-accepted', 'science_read', { id: saved.id })
  }, options => { expect(measurement.parse(toolValue(options, 'read-accepted'))).toEqual(saved); return textResponse('accepted work completed after revoke') })
  w.holdB.release(); await absent(p, w.b.id)
  expect((await stored(p, w.b.id)).events.some(e => e.type === 'user/message' && e.data.id === id)).toBe(true)
  p.report.boundary = { acceptedId: id, acceptedWorkProcessedAfterRevoke: true, furtherAdmissionDenied: true }
  p.report.status = 'passed'
})

it('default-off mode adds no science authority or tools and preserves parent/Team rejection', async () => {
  const p = await setup('default-off', false); const w = await workers(p)
  expect(p.ctx.subagents.scienceResults).toBeUndefined()
  expect(p.ctx.tools.get('science_send_result', w.a)).toBeUndefined()
  expect(p.ctx.tools.get('science_authorize_peer', w.ra)).toBeUndefined()
  await expect(p.ctx.subagents.sendMessage(w.a, w.b.id, text('still not adjacent'), { signal: signal() })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  await expect(p.ctx.agentTeams.sendMessage(w.a, { target: 'midbrain-b', content: text('still not a Team member'), signal: signal() })).rejects.toMatchObject({ code: 'TEAM_NOT_MEMBER' })
  const normal = await p.ctx.subagents.sendMessage(w.ra, w.a.id, text('ordinary parent message'), { signal: signal() })
  expect(w.a.inbox.nextStep.some(m => m.id === normal && m.source.kind === 'agent-message')).toBe(true)
  p.report.status = 'passed'
})

it('limits pending references, accepts one exact reverse reply, and requires both consents again after revoke', async () => {
  const p = await setup('bounded-correlation-and-regrant'); const w = await workers(p)
  await authorize(p, w.ra, w.rb)
  const saved = await result(p, w.a)
  const exchange = p.ctx.subagents.scienceResults!
  const ids = []
  for (let i = 0; i < 8; i++) ids.push(await exchange.send(w.a, w.b.id, { kind: 'reference', resultId: saved.id }, signal()))
  await expect(exchange.send(w.a, w.b.id, { kind: 'reference', resultId: saved.id }, signal())).rejects.toMatchObject({ code: 'SCIENCE_REFERENCE_LIMIT' })
  const different = await result(p, w.a)
  await expect(exchange.send(w.b, w.a.id, { kind: 'reply', resultId: different.id, inReplyTo: ids[0]! }, signal())).rejects.toMatchObject({ code: 'SCIENCE_REPLY_MISMATCH' })
  await exchange.send(w.b, w.a.id, { kind: 'reply', resultId: saved.id, inReplyTo: ids[0]! }, signal())
  await expect(exchange.send(w.b, w.a.id, { kind: 'reply', resultId: saved.id, inReplyTo: ids[0]! }, signal())).rejects.toMatchObject({ code: 'SCIENCE_REPLY_MISMATCH' })
  expect(await exchange.send(w.a, w.b.id, { kind: 'reference', resultId: saved.id }, signal())).toBeTypeOf('string')
  expect(await execute(p, 'science_revoke_peer', {}, w.ra)).toMatchObject({ isError: false })
  await exchange.authorize(w.ra, { childId: w.a.id, peerChildId: w.b.id, peerParent: w.rb }, signal())
  await expect(exchange.send(w.a, w.b.id, { kind: 'reference', resultId: saved.id }, signal())).rejects.toMatchObject({ code: 'SCIENCE_NO_GRANT' })
  await exchange.authorize(w.rb, { childId: w.b.id, peerChildId: w.a.id, peerParent: w.ra }, signal())
  await expect(exchange.send(w.b, w.a.id, { kind: 'reply', resultId: saved.id, inReplyTo: ids[1]! }, signal())).rejects.toMatchObject({ code: 'SCIENCE_REPLY_MISMATCH' })
  expect(await exchange.send(w.a, w.b.id, { kind: 'reference', resultId: saved.id }, signal())).toBeTypeOf('string')
  p.report.correlation = { maxPending: 8, duplicateReplyRejected: true, staleCorrelationAfterRegrantRejected: true, newExchangeAfterBothConsents: true }
  p.report.status = 'passed'
})

it('removing the science store binding revokes grants and removes the optional tools', async () => {
  const p = await setup('disable-consumer'); const w = await workers(p)
  await authorize(p, w.ra, w.rb)
  const saved = await result(p, w.a)
  const exchange = p.ctx.subagents.scienceResults!
  const entry = [...p.ctx.loader.entries()].find(entry => entry.options.name === 'science')!
  await entry.update({ config: { project: 'cross-branch-project', provider: 'spawn', maxDepth: 3, crossBranchResults: false } })
  // Loader update starts a restart; the Fiber owns completion and startup errors.
  await entry.fiber!.await()
  expect(p.ctx.tools.get('science_send_result', w.a)).toBeUndefined()
  expect(p.ctx.tools.get('science_measure', w.a)).toBeDefined()
  await expect(exchange.send(w.a, w.b.id, { kind: 'reference', resultId: saved.id }, signal())).rejects.toMatchObject({ code: 'SCIENCE_NO_GRANT' })
  await exchange.authorize(w.ra, { childId: w.a.id, peerChildId: w.b.id, peerParent: w.rb }, signal())
  await exchange.authorize(w.rb, { childId: w.b.id, peerChildId: w.a.id, peerParent: w.ra }, signal())
  await expect(exchange.send(w.a, w.b.id, { kind: 'reference', resultId: saved.id }, signal())).rejects.toMatchObject({ code: 'SCIENCE_RESULT_UNAVAILABLE' })
  p.report.status = 'passed'
})


it('cross-branch cold delivery respects the upstream activation capacity and succeeds after a slot is released', async () => {
  const p = await boot('upstream-capacity', true, 4); probes.push(p)
  const w = await workers(p)
  await authorize(p, w.ra, w.rb)
  const saved = await result(p, w.a)
  w.holdB.release(); await absent(p, w.b.id)
  const busy = new Gate(); p.model.queue('capacity-holder', busy.step())
  await branch(p, w.ra, 'capacity-holder')
  const exchange = p.ctx.subagents.scienceResults!
  await expect(exchange.send(w.a, w.b.id, { kind: 'reference', resultId: saved.id }, signal())).rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED' })
  expect(p.ctx.agents.get(w.b.id)).toBeUndefined()
  expect((await stored(p, w.b.id)).events.some(e => e.type === 'agent/inbox/spliced' && e.data.inserted.some(m => m.source.kind === 'science-result'))).toBe(false)
  busy.release(); await absent(p, SessionId('capacity-holder'))
  p.model.queue('midbrain-b', options => {
    expect(payload(options, 'reference')).toMatchObject({ resultId: saved.id, senderSessionId: w.a.id })
    return textResponse('Reference processed after capacity became available.')
  })
  const id = await exchange.send(w.a, w.b.id, { kind: 'reference', resultId: saved.id }, signal())
  await absent(p, w.b.id)
  expect((await stored(p, w.b.id)).events.some(e => e.type === 'user/message' && e.data.id === id)).toBe(true)
  p.report.status = 'passed'
})

it('awaited Agent creation retains the final authority check after an asynchronous initialization gap', async () => {
  const p = await setup('upstream-async-creation'); const w = await workers(p)
  await authorize(p, w.ra, w.rb)
  const saved = await result(p, w.a)
  w.holdB.release(); await absent(p, w.b.id)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const stop = p.ctx.on('agent/created', async ({ agent }) => {
    if (agent.id !== w.b.id) return
    entered.resolve()
    await release.promise
  })
  const exchange = p.ctx.subagents.scienceResults!
  let settled = false
  const delivery = exchange.send(w.a, w.b.id, { kind: 'reference', resultId: saved.id }, signal()).then(
    value => { settled = true; return { accepted: true, value } },
    error => { settled = true; return { accepted: false, error } },
  )
  try {
    await entered.promise
    expect(settled).toBe(false)
    exchange.revoke(w.ra)
  } finally { release.resolve(); stop() }
  expect((await delivery).accepted).toBe(false)
  await absent(p, w.b.id)
  expect((await stored(p, w.b.id)).events.some(e => e.type === 'agent/inbox/spliced' && e.data.inserted.some(m => m.source.kind === 'science-result'))).toBe(false)
  p.report.status = 'passed'
})
