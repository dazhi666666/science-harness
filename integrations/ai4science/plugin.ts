/** Minimal science tools; all agents, sessions and storage remain host-owned. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as recordSchema } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { installCrossBranchTools } from './cross-branch/tools.ts'

export const name = 'ai4science-minimal'
export const inject = ['tools', 'agents', 'subagents', 'storage', 'storageDomain']
export interface Config { project: string; provider: string; maxDepth: number; crossBranchResults?: boolean }
export const Config: z<Config> = z.object({
  project: z.string().min(1).required(),
  provider: z.string().min(1).required(),
  maxDepth: z.natural().max(Number.MAX_SAFE_INTEGER).required(),
  crossBranchResults: z.boolean().default(false),
})

const record = recordSchema.object({
  id: recordSchema.string(), project: recordSchema.string(),
  callerSessionId: recordSchema.string(),
  samples: recordSchema.array(recordSchema.number().finite()).min(1),
  mean: recordSchema.number().finite(),
  method: recordSchema.literal('arithmetic-mean/v1'),
})
const spec = defineDomain({
  name: 'ai4science_minimal', version: 1,
  tables: { results: domainTable(record) },
})
const samples = { type: 'array', required: true, items: { type: 'number' }, description: 'One or more finite observations.' } as const
const resultProperties = {
  id: { type: 'string', required: true },
  project: { type: 'string', required: true },
  callerSessionId: { type: 'string', required: true },
  samples,
  mean: { type: 'number', required: true },
  method: { type: 'string', required: true },
} as const

/** Register three tools on one configured trusted installation/project. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const domain = await ctx.storage.domain.open(spec)
  ctx.effect(() => () => domain.close(), 'ai4science.results')
  const results = domain.table('results')
  if (config.crossBranchResults) installCrossBranchTools(ctx, config.project, (id) => {
    const value = results.get(id)
    return value === undefined ? undefined : { project: value.project, ownerSessionId: SessionId(value.callerSessionId) }
  })
  ctx.tools.register(defineTool({
    name: 'science_measure',
    description: 'Compute and save the arithmetic mean of supplied observations. Returns a durable result reference; does not acquire new measurements.',
    parameters: { samples },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: resultProperties },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!exec.agent || ctx.agents.get(exec.agent.id) !== exec.agent) throw new Error('science tool requires the exact live caller')
      exec.signal.throwIfAborted()
      // Reject empty/non-finite/overflowing data before persisting a scientific fact.
      const values = recordSchema.array(recordSchema.number().finite()).min(1).parse(args.samples)
      const value = record.parse({
        id: randomUUID(), project: config.project, callerSessionId: exec.agent.id,
        samples: values, mean: values.reduce((sum, value) => sum + value / values.length, 0),
        method: 'arithmetic-mean/v1',
      })
      await results.put(value.id, value)
      return value
    },
  }))
  ctx.tools.register(defineTool({
    name: 'science_read', description: 'Read a saved observation summary by its result id.',
    parameters: { id: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: resultProperties },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!exec.agent || ctx.agents.get(exec.agent.id) !== exec.agent) throw new Error('science tool requires the exact live caller')
      exec.signal.throwIfAborted()
      const value = results.get(args.id)
      if (!value || value.project !== config.project) throw new Error('science result unavailable in configured project')
      return value
    },
  }))
  ctx.tools.register(defineTool({
    name: 'science_delegate',
    description: 'Ask a science worker to summarize supplied observations and report the saved result id. Waits for the worker to finish.',
    parameters: { samples },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          childId: { type: 'string', required: true },
          stopReason: { type: 'string', required: true },
          output: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!exec.agent || ctx.agents.get(exec.agent.id) !== exec.agent) throw new Error('science tool requires the exact live caller')
      const values = recordSchema.array(recordSchema.number().finite()).min(1).parse(args.samples)
      const run = await ctx.subagents.start(config.provider, {
        parent: exec.agent, signal: exec.signal, label: 'Summarize observations',
        prompt: [{ type: 'text', text: `Call science_measure with ${JSON.stringify({ samples: values })}, then report its complete result including id.` }],
        maxDepth: config.maxDepth,
        toolFilter: { allow: ['science_measure', 'science_read'] },
      })
      try {
        const result = await run.result
        if (result.stopReason !== 'completed') throw new Error(`science worker ended: ${result.stopReason}`)
        return {
          childId: run.id, stopReason: result.stopReason,
          output: result.output.filter(block => block.type === 'text').map(block => block.text).join('\n'),
        }
      } finally {
        await run.dispose()
      }
    },
  }))
}
