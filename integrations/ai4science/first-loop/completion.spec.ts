/** Real host loop regression for a late settlement notice after report completion; only the test LLM is scripted. */
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Llm, { createUserMessage, type MessageId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Projections from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { installCompletionBoundary } from './completion.ts'

it('finishes the root turn without a second model request when a concluding tool receives a late settlement notice', async () => {
  const ctx = new Context()
  try {
    for (const plugin of [Llm, Sessions, Projections, SystemPrompt, Tools, Agents]) await ctx.plugin(plugin)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([toolCallResponse('finish-call', 'finish', {})])
    ctx.llm.registerAdapter(['test-only-completion'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('completion-test-root'), { provider: 'test-only-completion', model: 'test-only' })
    let completed = false
    let lateId: MessageId | undefined
    const declined: MessageId[] = []
    installCompletionBoundary(ctx, () => completed, subject => subject === agent, (_subject, ids) => declined.push(...ids))
    ctx.tools.register(defineContentToolFixture({
      name: 'finish', description: 'Test-only completed report', parameters: {},
      async execute(_args, exec) {
        completed = true
        const late = createUserMessage({ content: [{ type: 'text', text: 'Late child settlement notice' }], source: { kind: 'plugin', plugin: 'completion-test' } })
        lateId = late.id
        agent.steer(late)
        exec.concludeTurn()
        return [{ type: 'text', text: 'Report completed' }]
      },
    }))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Finish once' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(completed).toBe(true)
    expect(adapter.requests).toHaveLength(1)
    expect(declined).toEqual([lateId])
    const events = agent.session.snapshotEvents()
    expect(events.filter(e => e.type === 'step/start')).toHaveLength(1)
    expect(events.filter(e => e.type === 'tool/result')).toHaveLength(1)
    expect(events.filter(e => e.type === 'turn/end').map(e => e.data.reason)).toEqual([{ kind: 'completed' }])
    expect(events.filter(e => e.type === 'user/message').map(e => e.data.id)).not.toContain(lateId)
  } finally { await ctx.fiber.dispose() }
})
