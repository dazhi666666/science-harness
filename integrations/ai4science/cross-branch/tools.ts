/** Optional science consumer of the explicitly enabled host result-reference extension. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ScienceResultReader } from '@deepseek-ai/dsh-subagent'

/** Mount the store binding and narrow model tools. Default plugin configuration does not call this. */
export function installCrossBranchTools(ctx: Context, project: string, reader: ScienceResultReader): void {
  const exchange = ctx.subagents.scienceResults
  if (!exchange) throw new Error('cross-branch science tools require subagents.scienceResultProject opt-in')
  ctx.effect(() => exchange.bindResults(project, reader), 'science.crossBranchResults')
  const acknowledgement = {
    schema: { type: 'object', additionalProperties: false, properties: { accepted: { type: 'boolean', required: true } } },
    render: () => [{ type: 'text' as const, text: 'Science consent updated.' }],
  } as const
  ctx.tools.register(defineTool({
    name: 'science_authorize_peer',
    description: 'As the actual parent, authorize your continuable worker to exchange saved result references with one exact peer. The peer parent must independently authorize the reverse pair.',
    parameters: {
      worker_id: { type: 'string', required: true }, peer_id: { type: 'string', required: true }, peer_parent_id: { type: 'string', required: true },
    },
    output: acknowledgement,
    async execute(args, exec) {
      if (!exec.agent) throw new Error('science consent requires a live parent caller')
      const peerParent = ctx.agents.get(SessionId(args.peer_parent_id))
      if (!peerParent) throw new Error('peer parent is unavailable')
      await exchange.authorize(exec.agent, { childId: SessionId(args.worker_id), peerChildId: SessionId(args.peer_id), peerParent }, exec.signal)
      return { accepted: true }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'science_revoke_peer',
    description: 'As one authorizing parent, revoke both consents. Pending admissions stop; already accepted messages remain in the host inbox. Both parents must authorize again.',
    parameters: {}, output: acknowledgement,
    async execute(_args, exec) {
      if (!exec.agent) throw new Error('science revocation requires a live parent caller')
      exec.signal.throwIfAborted()
      exchange.revoke(exec.agent)
      return { accepted: true }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'science_send_result',
    description: 'Send your saved result reference to the exact worker authorized by both parents, or reply once to a received reference. Returns inbox acceptance, not processing completion.',
    parameters: {
      target_id: { type: 'string', required: true }, kind: { type: 'string', enum: ['reference', 'reply'], required: true },
      result_id: { type: 'string', required: true }, in_reply_to: { type: 'string' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { messageId: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('science sending requires a live worker caller')
      if (args.kind === 'reference' && args.in_reply_to !== undefined) throw new Error('reference cannot carry in_reply_to')
      if (args.kind === 'reply' && args.in_reply_to === undefined) throw new Error('reply requires in_reply_to')
      return { messageId: await exchange.send(exec.agent, SessionId(args.target_id), args.kind === 'reference'
        ? { kind: 'reference', resultId: args.result_id }
        : { kind: 'reply', resultId: args.result_id, inReplyTo: MessageId(args.in_reply_to!) }, exec.signal) }
    },
  }))
}
