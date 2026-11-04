/** Explicit scripted demo adapter; native Agents, tools, device operations and messages remain real. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { createSinglePolicy } from './single-policy.ts'
import { createWorkerPolicy, textResponse, toolCallResponse } from './policy.ts'

export const name = 'greenhouse-scripted-model'
export const inject = ['llm']
class DemoAdapter extends LlmAdapter {
  private readonly single = createSinglePolicy()
  private leadStep = 0
  private leadReading = false
  private readonly workers = {
    'chamber-A': createWorkerPolicy('A'), 'chamber-B': createWorkerPolicy('B'), 'chamber-C': createWorkerPolicy('C'),
  }
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: 'Scripted greenhouse demo' }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const marker = options.messages.flatMap(message => message.content)
      .find(block => block.type === 'text' && /^ACTOR [\w-]+(?:\n|$)/.test(block.text))
    const actor = marker?.type === 'text' ? marker.text.split('\n')[0]!.slice(6) : 'lead'
    let response: StreamChunk[]
    if (options.model === 'single-baseline') response = this.single(options)
    else if (actor === 'lead') {
      const assignment = [
        { assignee: 'chamber-A', experiment_task: 'light-A' },
        { assignee: 'chamber-B', experiment_task: 'water-B' },
        { assignee: 'chamber-C', experiment_task: 'reference-C' },
      ][this.leadStep++]
      if (assignment) response = toolCallResponse(`demo-assignment-${this.leadStep}`, 'lab_assign', assignment)
      else if (!this.leadReading) {
        this.leadReading = true
        response = toolCallResponse(`demo-inbox-${this.leadStep}`, 'lab_inbox', {})
      } else {
        this.leadReading = false
        response = textResponse('Scripted lead: actual mailbox read; production-model reasoning has not been tested.')
      }
    } else {
      const policy = this.workers[actor as keyof typeof this.workers]
      if (!policy) throw new Error(`Unknown scripted demo actor ${actor}`)
      response = policy(options)
    }
    for (const chunk of response) { options.signal?.throwIfAborted(); yield chunk }
  }
}

/** Register only the explicitly named scripted route; no fallback to a real model. */
export function apply(ctx: Context): void { ctx.llm.registerAdapter(['greenhouse-scripted'], new DemoAdapter()) }
