/** Native stop-boundary continuation respects actual work state and explicit cancellation. */
import { afterEach, expect, it, vi } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { maxTokensResponse, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { boot, lead, Gate, text, type Probe } from '../platform/organization-fixture.ts'
import { keepPendingWork } from './continuation.ts'

const probes: Probe[] = []
afterEach(async () => { for (const p of probes.splice(0)) await p.close() })

it.each(['completed', 'max-tokens'] as const)('continues a premature %s response until a real tool completes pending work', async reason => {
  const p = await boot('greenhouse-pending-' + reason, true, async () => ({ withoutScience: true }))
  probes.push(p)
  const handle = await lead(p, 'guard')
  let pending = true
  p.ctx.effect(() => p.ctx.tools.register(defineTool({ name: 'finish_pending', description: 'Complete the fixture work through a real tool.', parameters: {},
    output: { schema: { type: 'json' }, render: () => text('finished') },
    async execute() { pending = false; return { finished: true } },
  })))
  keepPendingWork(p.ctx, agent => agent === handle.agent && pending ? 'Router T1; experiment A; no successful analysis yet.' : undefined, new AbortController().signal)
  p.model.queue('guard', reason === 'max-tokens' ? maxTokensResponse('Stopping too early') : textResponse('Stopping too early'), options => {
    expect(options.messages.flatMap(message => message.content).some(block => block.type === 'text' && block.text.includes('Router T1'))).toBe(true)
    return toolCallResponse('finish', 'finish_pending', {})
  }, textResponse('Delivered'))
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: text('ACTOR guard\nStart assigned work.') }))
  await handle.agent.whenIdle()
  expect(pending).toBe(false)
  expect(p.model.requests.filter(request => request.actor === 'guard').length).toBeGreaterThanOrEqual(2)
})

it('does not restart explicitly cancelled work or continue after owner shutdown', async () => {
  const p = await boot('greenhouse-pending-cancel', true, async () => ({ withoutScience: true }))
  probes.push(p)
  const handle = await lead(p, 'guard')
  const owner = new AbortController(), gate = new Gate()
  keepPendingWork(p.ctx, agent => agent === handle.agent ? 'Pending T1' : undefined, owner.signal)
  p.model.queue('guard', textResponse('Premature stop'), gate.step('Cancelled response'), textResponse('Unexpected restart'))
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: text('ACTOR guard\nStart.') }))
  await vi.waitFor(() => { expect(p.model.requests.filter(request => request.actor === 'guard')).toHaveLength(2) })
  handle.agent.cancel({ kind: 'user' })
  await handle.agent.whenIdle()
  gate.release()
  await handle.agent.whenIdle()
  expect(p.model.remaining('guard')).toBe(1)
  owner.abort()
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: text('Finish without automatic continuation.') }))
  await handle.agent.whenIdle()
  expect(p.model.requests.filter(request => request.actor === 'guard')).toHaveLength(3)
})
