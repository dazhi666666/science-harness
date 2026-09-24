/** Source integration probe: real Loader, agent loop, subagents and disk storage. Only LLM output is scripted. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Agents from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Llm, { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Projections from '@deepseek-ai/dsh-session-projection'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Control from '@deepseek-ai/dsh-tool-subagent-control'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from '../../packages/core/agent-loop/tests/mock-adapter.ts'
import * as Science from './plugin.ts'

const contexts: Context[] = []
const roots: string[] = []
const signal = () => AbortSignal.timeout(15000)
const text = (value: string) => [{ type: 'text' as const, text: value }]
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

class IdleAdapter extends LlmAdapter {
  async * stream() { yield* textResponse('acknowledged') }
}

async function boot(script: ConstructorParameters<typeof MockAdapter>[0], existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'ai4science-probe-'))
  if (!existingRoot) roots.push(root)
  const adapter = new MockAdapter(script)
  const modules = new Map<string, unknown>([
    ['llm', Llm], ['sessions', Sessions], ['prompt', SystemPrompt], ['tools', Tools],
    ['agents', Agents], ['projections', Projections], ['jsonl', Jsonl], ['session-query', SessionQuery], ['loop', AgentLoop],
    ['subagents', Subagents], ['spawn', Spawn], ['control', Control], ['storage', Storage],
    ['storage-json', StorageJson], ['storage-domain', StorageDomain], ['science', Science],
    ['scripted-llm', { name: 'scripted-llm', inject: ['llm'], apply(ctx: Context) {
      ctx.llm.registerAdapter(['probe'], adapter)
      ctx.llm.registerAdapter(['idle-probe'], new IdleAdapter())
    } }],
  ])
  const configs: Record<string, unknown> = {
    jsonl: { root: join(root, 'sessions'), compression: 'none' },
    'session-query': { path: ':memory:', openAt: 'never' },
    loop: { agents: [] }, spawn: { providerName: 'spawn' },
    'storage-json': { root: join(root, 'records') },
    'storage-domain': { backend: 'json' },
    science: { project: 'probe-project', provider: 'spawn', maxDepth: 2 },
  }
  // JSON is valid YAML. All subject plugins activate via Loader entries, not manual ctx.plugin calls.
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([...modules.keys()].map(name => ({
    id: name, name, ...(configs[name] ? { config: configs[name] } : {}),
  })), null, 2))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(name: string) {
    if (!modules.has(name)) throw new Error(`unexpected module ${name}`)
    return modules.get(name)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => !entry.disabled && !entry.fiber).map(entry => entry.options.name)).toEqual([])
  return { ctx, root, adapter }
}

async function parent(ctx: Context, id: string, provider = 'idle-probe') {
  return ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider, model: 'probe' } })
}
async function stored(ctx: Context, id: SessionId) {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try { return { header: handle.header, events: (await handle.read()).events } } finally { await handle.close() }
}
async function execute(ctx: Context, name: string, args: unknown, agent?: Agent) {
  return ctx.tools.execute({ callId: ToolCallId('probe-call'), name, arguments: args, signal: signal(), ...(agent ? { agent } : {}) })
}
async function settled(ctx: Context, id: SessionId) {
  await vi.waitFor(() => expect(ctx.agents.get(id)).toBeUndefined(), { timeout: 10000 })
}
function start(ctx: Context, owner: Agent, id: string) {
  return ctx.subagents.startContinuable({
    provider: 'spawn', label: 'probe child', childId: SessionId(id), signal: signal(),
    request: { parent: owner, prompt: text('work'), agentOptions: { provider: 'probe', model: 'probe' }, maxDepth: 2 },
  })
}

it('loads the plugin, delegates through the real loop, persists caller-attributed science results, then reads after restart', async () => {
  const echoResult = (options: Parameters<LlmAdapter['stream']>[0]) => {
    const content = options.messages.at(-1)?.content.filter(block => block.type === 'tool-result').flatMap(block => block.content).filter(block => block.type === 'text').map(block => block.text).join('')
    return textResponse(content ?? '')
  }
  const { ctx, root, adapter } = await boot([
    toolCallResponse('delegate', 'science_delegate', { samples: [1, 2, 3] }),
    toolCallResponse('measure', 'science_measure', { samples: [1, 2, 3] }),
    echoResult, echoResult,
  ])
  const main = await parent(ctx, 'science-parent', 'probe')
  main.agent.followup(createUserMessage({ content: text('Summarize observations'), source: { kind: 'user' } }))
  await main.agent.whenIdle()
  expect(adapter.requests).toHaveLength(4)
  await main.dispose()
  const parentLog = await stored(ctx, SessionId('science-parent'))
  const delegation = parentLog.events.find(event => event.type === 'tool/result')
  expect(delegation?.data).toMatchObject({ message: { content: [{ isError: false }] } })
  const children = await ctx.subagents.listChildren(SessionId('science-parent'))
  expect(children).toHaveLength(1)
  const childId = children[0]!.id
  const childLog = await stored(ctx, childId)
  expect(childLog.header.parentSession).toBe('science-parent')
  const measurement = childLog.events.find(event => event.type === 'tool/result')
  if (measurement?.type !== 'tool/result') throw new Error('missing durable measurement')
  const result = JSON.parse(measurement.data.message.content[0].content.filter(block => block.type === 'text').map(block => block.text).join(''))
  expect(result).toMatchObject({ mean: 2, samples: [1, 2, 3], project: 'probe-project', callerSessionId: childId })
  expect(JSON.stringify(delegation)).toContain(result.id)
  expect(ctx.agents.get(childId)).toBeUndefined()
  await ctx.fiber.dispose()
  const second = await boot([], root)
  const reader = await parent(second.ctx, 'reader')
  const read = await execute(second.ctx, 'science_read', { id: result.id }, reader.agent)
  expect(read).toMatchObject({ isError: false, value: result })
  await reader.dispose()
  const entry = [...second.ctx.loader.entries()].find(entry => entry.options.name === 'science')!
  await entry.fiber!.dispose()
  expect(second.ctx.tools.get('science_measure')).toBeUndefined()
  expect(second.ctx.tools.get('science_delegate')).toBeUndefined()
  expect(second.ctx.tools.get('science_read')).toBeUndefined()
})

it('rejects missing callers and empty samples, derives identity despite forged arguments, and blocks child tool escalation', async () => {
  const { ctx } = await boot([])
  const main = await parent(ctx, 'identity-parent')
  expect(await execute(ctx, 'science_measure', { samples: [1] })).toMatchObject({ isError: true })
  expect(await execute(ctx, 'science_measure', { samples: [], callerSessionId: 'forged' }, main.agent)).toMatchObject({ isError: true })
  expect(await execute(ctx, 'science_measure', { samples: [1], callerSessionId: 'forged' }, main.agent)).toMatchObject({ isError: false, value: { callerSessionId: 'identity-parent' } })
  const child = await ctx.agents.create({ sessionId: SessionId('restricted'), setup(agentCtx) {
    agentCtx.tools.restrict({ allow: ['science_read'] })
  } })
  expect(ctx.tools.get('science_measure', child.agent)).toBeUndefined()
  expect(await execute(ctx, 'science_measure', { samples: [1] }, child.agent)).toMatchObject({ isError: true })
  await child.dispose()
  await main.dispose()
})

it('delivers child-to-parent results and parent-to-child follow-ups, rejects peers, and resumes from disk after host restart', async () => {
  const { ctx, root } = await boot(['hang', textResponse('resumed-result')])
  const main = await parent(ctx, 'communication-parent')
  const other = await parent(ctx, 'other-parent')
  const started = await start(ctx, main.agent, 'continuable')
  const child = ctx.agents.get(started.childId)!
  expect(child).toBeDefined()
  const receipt = await ctx.subagents.sendMessage(child, main.agent.id, text('child-result: 42'), { signal: signal() })
  await main.agent.whenIdle()
  await ctx.sessions.flush(main.agent.session)
  expect((await stored(ctx, main.agent.id)).events).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'user/message', data: expect.objectContaining({ id: receipt, source: expect.objectContaining({ kind: 'agent-message', senderSessionId: child.id }) }) }),
  ]))
  await expect(ctx.subagents.sendMessage(other.agent, child.id, text('cross-parent'), { signal: signal() })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  const sibling = await ctx.agents.create({ sessionId: SessionId('sibling'), meta: { parentSession: main.agent.id } })
  await expect(ctx.subagents.sendMessage(sibling.agent, child.id, text('sibling'), { signal: signal() })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  // A stale Agent object cannot authorize a message, even with the correct id.
  await sibling.dispose()
  await expect(ctx.subagents.sendMessage(sibling.agent, child.id, text('stale'), { signal: signal() })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  ctx.subagents.interrupt(child.id, { kind: 'ancestor', agent: main.agent })
  await settled(ctx, child.id)
  const followupId = await ctx.subagents.sendMessage(main.agent, child.id, text('resume-one'), { signal: signal() })
  await settled(ctx, child.id)
  const log = await stored(ctx, child.id)
  expect(log.events.some(event => event.type === 'user/message' && event.data.id === followupId)).toBe(true)
  expect(JSON.stringify(log.events)).toContain('resumed-result')
  await main.agent.whenIdle()
  await ctx.sessions.flush(main.agent.session)
  const parentEvents = (await stored(ctx, main.agent.id)).events
  expect(parentEvents.some(event => event.type === 'user/message' && event.data.source.kind === 'subagent-settled')).toBe(true)
  expect(JSON.stringify(parentEvents)).toContain('resumed-result')
  await main.dispose()
  await other.dispose()
  await ctx.fiber.dispose()
  const restarted = await boot([textResponse('after-restart')], root)
  const resumedParent = await restarted.ctx.agents.resume({ resumeSessionId: SessionId('communication-parent'), agentOptions: { provider: 'idle-probe', model: 'probe' } })
  await restarted.ctx.subagents.sendMessage(resumedParent.agent, child.id, text('resume-two'), { signal: signal() })
  await settled(restarted.ctx, child.id)
  expect(JSON.stringify((await stored(restarted.ctx, child.id)).events)).toContain('after-restart')
  await resumedParent.agent.whenIdle()
  await resumedParent.dispose()
})

it('enforces depth, reports cancellation as a non-success result, and disposes a one-shot run', async () => {
  const { ctx, adapter } = await boot(['hang'])
  const main = await parent(ctx, 'cancellation-parent')
  await expect(ctx.subagents.start('spawn', { parent: main.agent, prompt: text('work'), signal: signal(), maxDepth: 0 })).rejects.toThrow()
  const controller = new AbortController()
  const run = await ctx.subagents.start('spawn', { parent: main.agent, prompt: text('work'), signal: controller.signal, agentOptions: { provider: 'probe', model: 'probe' } })
  await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
  controller.abort()
  expect(await run.result).toMatchObject({ stopReason: 'aborted' })
  await run.dispose()
  expect(ctx.agents.get(run.id)).toBeUndefined()
  await expect(ctx.subagents.sendMessage(main.agent, run.id, text('cannot-resume-one-shot'), { signal: signal() })).rejects.toMatchObject({ code: 'NOT_RESUMABLE' })
  await main.dispose()
})

it('surfaces a truncated worker as a tool error and releases its live Agent', async () => {
  const { ctx } = await boot([maxTokensResponse('partial analysis')])
  const main = await parent(ctx, 'failed-worker-parent', 'probe')
  const result = await execute(ctx, 'science_delegate', { samples: [1, 2, 3] }, main.agent)
  expect(result).toMatchObject({ isError: true })
  expect(JSON.stringify(result)).toContain('max-tokens')
  const children = await ctx.subagents.listChildren(main.agent.id)
  expect(children).toHaveLength(1)
  expect(ctx.agents.get(children[0]!.id)).toBeUndefined()
  await main.dispose()
})
