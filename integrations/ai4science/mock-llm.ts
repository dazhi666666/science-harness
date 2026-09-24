/** Keyless CLI fixture. No network calls; only the LLM service is scripted. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { textResponse, toolCallResponse } from '../../packages/core/agent-loop/tests/mock-adapter.ts'

export const name = 'science-mock'
export const inject = ['llm']

class ScienceMock extends LlmAdapter {
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model }
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const lastResult = options.messages.at(-1)?.content.filter(block => block.type === 'tool-result').flatMap(block => block.content).filter(block => block.type === 'text').map(block => block.text).join('')
    if (lastResult) {
      yield* textResponse(lastResult)
      return
    }
    if (process.env.AI4S_PROBE_RESULT_ID) {
      yield* toolCallResponse('read', 'science_read', { id: process.env.AI4S_PROBE_RESULT_ID })
      return
    }
    const worker = options.tools?.some(tool => tool.name === 'science_measure')
      && !options.tools.some(tool => tool.name === 'science_delegate')
    yield* toolCallResponse(worker ? 'measure' : 'delegate', worker ? 'science_measure' : 'science_delegate', { samples: [1, 2, 3] })
  }
}

/** Mount one deterministic external-service substitute for the CLI smoke. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['science-mock'], new ScienceMock())
}
