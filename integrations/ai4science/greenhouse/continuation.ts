/** Keep assigned work active through the native stop boundary, without another scheduler or round cap. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from './agents.ts'

/** Queue a logged native steering notice only when this exact participant still has unfinished work.
 * @param ctx Application lifecycle owner.
 * @param pending Current permitted work context, or undefined when the participant may settle.
 * @param ownerSignal Explicit application shutdown signal; cancellation is never overridden.
 * @returns Registers the lifecycle-owned native stop listener.
 */
export function keepPendingWork(ctx: Context, pending: (agent: Agent) => string | undefined, ownerSignal: AbortSignal): void {
  ctx.on('agent/turn-stopping', ({ agent, signal }) => {
    if (ownerSignal.aborted || signal.aborted || ctx.agents.get(agent.id) !== agent) return
    const work = pending(agent)
    if (work === undefined || ownerSignal.aborted || signal.aborted) return
    agent.steer(createUserMessage({ source: { kind: 'greenhouse-coordination', form: 'notice', summary: 'Unfinished assigned greenhouse work' },
      content: [{ type: 'text', text: `已分配的实验尚未交付。继续调用真实工具，不要因为对话很长或单次输出截断而提前总结结束；无需长篇回顾。可以并行提交资源不冲突的动作。已成功的分析只需交付，不要重复实验。\n${work}` }] }))
  })
}
