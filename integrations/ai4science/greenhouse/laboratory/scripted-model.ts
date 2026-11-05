/** Explicit scripted laboratory adapter for the ordinary native dsh runtime. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { laboratoryPolicy } from './scripted-policy.ts'
import { textResponse } from '../fixtures/policy.ts'

export const name = 'laboratory-scripted-model'
export const inject = ['llm']
class LaboratoryScriptedModel extends LlmAdapter {
  private readonly single = laboratoryPolicy('lead', 'single-agent')
  private readonly team = Object.fromEntries(['lead', 'facilities', 'experiments', 'quality'].map(role => [role, laboratoryPolicy(role, 'multi-agent')]))
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: 'Scripted laboratory integration', contextWindow: 256000 }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const marker = options.messages.flatMap(message => message.content).find(block => block.type === 'text' && /^ACTOR [\w-]+(?:\n|$)/.test(block.text))
    const role = marker?.type === 'text' ? marker.text.split('\n')[0]!.slice(6) : 'lead'
    const policy = options.model === 'single-workflow' ? this.single : this.team[role]
    if (!policy) throw new Error('Unknown native laboratory role marker')
    const response = options.purpose === 'compaction' ? textResponse('Scripted integration state is recovered through laboratory tools and its explicit policy.') : policy(options)
    for (const chunk of response) { options.signal?.throwIfAborted(); yield chunk }
  }
}

/** Register only the named scripted route; its source is recorded by the organization.
 * @param ctx Existing native model service.
 */
export function apply(ctx: Context): void { ctx.llm.registerAdapter(['laboratory-scripted'], new LaboratoryScriptedModel()) }
