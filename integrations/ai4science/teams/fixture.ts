import { HARNESS_BASELINE } from '../platform/version.ts'
/** Isolated real Loader composition and gated external LLM fixture. No host internals are replaced. */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Agents from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Llm, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Projections from '@deepseek-ai/dsh-session-projection'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import TeamService from '@deepseek-ai/dsh-experimental-agent-team'
import * as TeamTools from '@deepseek-ai/dsh-experimental-tool-agent-team'
import { textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import * as Science from '../plugin.ts'

export const revision = HARNESS_BASELINE
export const text = (value: string) => [{ type: 'text' as const, text: value }]
export const signal = () => AbortSignal.timeout(15000)
export type ScriptStep = StreamChunk[] | ((options: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]>)
export interface Trace { ordinal: number; stage: string; sessionId?: string; seq?: number; data?: unknown }

/** Gate only scripted model responses; cancellation still propagates normally. */
export class Gate {
  private readonly deferred = Promise.withResolvers<void>()
  release(): void { this.deferred.resolve() }
  async wait(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const aborted = Promise.withResolvers<never>()
    const onAbort = () => { aborted.reject(signal?.reason) }
    signal?.addEventListener('abort', onAbort, { once: true })
    try { await Promise.race([this.deferred.promise, aborted.promise]) }
    finally { signal?.removeEventListener('abort', onAbort) }
  }
  step(reply = 'ready'): ScriptStep {
    return async options => { await this.wait(options.signal); return textResponse(reply) }
  }
}

/** Role-keyed scripts isolate interleaved requests from independent real Agents. */
export class ScriptedModel extends LlmAdapter {
  private readonly scripts = new Map<string, ScriptStep[]>()
  readonly requests: { actor: string; options: GenerateOptions }[] = []
  queue(actor: string, ...steps: ScriptStep[]): void {
    this.scripts.set(actor, [...(this.scripts.get(actor) ?? []), ...steps])
  }
  remaining(actor: string): number { return this.scripts.get(actor)?.length ?? 0 }
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const marker = options.messages.flatMap(message => message.content)
      .find(block => block.type === 'text' && /^ACTOR [\w-]+$/.test(block.text))
    const actor = marker?.type === 'text' ? marker.text.slice(6) : 'lead'
    this.requests.push({ actor, options })
    const step = this.scripts.get(actor)?.shift()
    // Parent settlement notices require no science action. Unscripted calls only acknowledge.
    const chunks = step === undefined ? textResponse(`${actor}: acknowledged`)
      : typeof step === 'function' ? await step(options) : step
    for (const chunk of chunks) { options.signal?.throwIfAborted(); yield chunk }
  }
}

export interface Probe {
  ctx: Context; model: ScriptedModel; root: string; trace: Trace[];
  report: Record<string, unknown>;
  note(stage: string, data?: unknown): void;
  close(): Promise<void>;
}

/** Load source modules via real Loader entries and preserve disk evidence after teardown. */
export async function boot(label: string): Promise<Probe> {
  const evidence = fileURLToPath(new URL('../evidence/teams/', import.meta.url))
  await mkdir(evidence, { recursive: true })
  const root = await mkdtemp(join(evidence, `${label}-`))
  const ctx = new Context()
  const model = new ScriptedModel()
  const trace: Trace[] = []
  const report: Record<string, unknown> = { label, revision, status: 'incomplete', root }
  const note = (stage: string, data?: unknown) => { trace.push({ ordinal: trace.length, stage, data }) }
  const modules = new Map<string, unknown>([
    ['llm', Llm], ['sessions', Sessions], ['prompt', SystemPrompt], ['tools', Tools],
    ['agents', Agents], ['projections', Projections], ['jsonl', Jsonl], ['query', SessionQuery],
    ['loop', AgentLoop], ['subagents', Subagents], ['spawn', Spawn],
    ['storage', Storage], ['storage-json', StorageJson], ['storage-domain', StorageDomain],
    ['science', Science], ['teams', TeamService], ['team-tools', TeamTools],
    ['observation', { name: 'observation', inject: ['llm', 'sessions', 'agents'], apply(observed: Context) {
      observed.llm.registerAdapter(['teams-probe'], model)
      observed.on('session/event', (session, event) => {
        trace.push({ ordinal: trace.length, stage: event.type, sessionId: session.id, seq: event.seq, data: event.data })
      })
      observed.on('agent/status', ({ agent, status }) => {
        trace.push({ ordinal: trace.length, stage: 'agent/status', sessionId: agent.id, data: { status } })
      })
      observed.on('agent/disposed', ({ agent }) => {
        trace.push({ ordinal: trace.length, stage: 'agent/disposed', sessionId: agent.id })
      })
    } }],
  ])
  const configs: Record<string, unknown> = {
    jsonl: { root: join(root, 'sessions'), compression: 'none' },
    query: { path: ':memory:', openAt: 'never' }, loop: { agents: [] },
    spawn: { providerName: 'spawn' }, 'storage-json': { root: join(root, 'records') },
    'storage-domain': { backend: 'json' }, science: { project: 'teams-probe-project', provider: 'spawn', maxDepth: 3 },
    teams: { maxMembers: 8, maxTasks: 16, maxPendingMessagesPerMember: 8, maxMessageBytes: 4096, disposalTimeoutMs: 5000 },
    'team-tools': { freshProvider: 'spawn', forkProvider: 'fork' },
  }
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([...modules.keys()].map(name => ({ id: name, name, ...(configs[name] ? { config: configs[name] } : {}) })), null, 2))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  try {
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = { version: 'v2', async import(name: string) {
      if (!modules.has(name)) throw new Error(`unexpected Loader import ${name}`)
      return modules.get(name)
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const unloaded = [...ctx.loader.entries()].filter(entry => !entry.disabled && !entry.fiber)
    if (unloaded.length) throw new Error(`unloaded entries: ${unloaded.map(entry => entry.options.name)}`)
  } catch (error) { await ctx.fiber.dispose(); throw error }
  return { ctx, model, root, trace, report, note, async close() {
    try { await ctx.subagents.drainContinuableDescendants(ctx.agents.roots()); await ctx.fiber.dispose() }
    finally {
      await writeFile(join(root, 'timeline.json'), JSON.stringify(trace, null, 2) + '\n')
      await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    }
  } }
}

export async function lead(probe: Probe, name: string) {
  return probe.ctx.agents.create({ sessionId: SessionId(name), agentOptions: { provider: 'teams-probe', model: 'script' } })
}
export function spawn(probe: Probe, owner: Agent, name: string, actor = name) {
  return probe.ctx.agentTeams.spawnTeammate(owner, {
    name, description: `Probe ${actor}`, prompt: text(`ACTOR ${actor}`), context: 'fresh', provider: 'spawn', signal: signal(),
  })
}
export function branch(probe: Probe, owner: Agent, id: string) {
  return probe.ctx.subagents.startContinuable({
    provider: 'spawn', childId: SessionId(id), label: id, signal: signal(),
    request: { parent: owner, prompt: text(`ACTOR ${id}`), maxDepth: 3 },
  })
}
export async function execute(probe: Probe, name: string, args: unknown, agent?: Agent) {
  return probe.ctx.tools.execute({ callId: ToolCallId(`probe-${name}`), name, arguments: args, signal: signal(), ...(agent ? { agent } : {}) })
}
export async function stored(probe: Probe, id: SessionId) {
  const handle = await probe.ctx.sessionPersistence.open(id, 'read')
  try { return { header: handle.header, events: (await handle.read()).events } }
  finally { await handle.close() }
}

/** Read actual rendered tool JSON, without substituting a result in the model fixture. */
export function toolValue(options: GenerateOptions, callId: string): unknown {
  const message = options.messages.findLast(message => message.role === 'tool' && message.toolCallId === callId)
  if (message?.role !== 'tool' || message.isError) throw new Error(`missing successful tool result ${callId}`)
  return JSON.parse(message.content.filter(part => part.type === 'text').map(part => part.text).join(''))
}

/** Parse only the explicitly typed message fixture from the model's real message history. */
export function payload(options: GenerateOptions, kind: string): Record<string, unknown> {
  for (const block of options.messages.flatMap(message => message.content).toReversed()) {
    if (block.type !== 'text' || !block.text.startsWith('{')) continue
    const value: unknown = JSON.parse(block.text)
    if (value !== null && typeof value === 'object' && 'kind' in value && value.kind === kind) return value as Record<string, unknown>
  }
  throw new Error(`missing message payload ${kind}`)
}
