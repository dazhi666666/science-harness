/** Deterministic demo responses, never evidence of production-model reasoning or token costs. */
import { z } from 'zod'
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Chamber } from '../schema.ts'

/** Encode a synthetic tool call through the normal streaming protocol.
 * @param id Fixture call identity.
 * @param name Actual registered tool.
 * @param args Structured tool parameters.
 * @returns Scripted response with zero production-model usage.
 */
export function toolCallResponse(id: string, name: string, args: object): StreamChunk[] {
  const argumentsJson = JSON.stringify(args), callId = ToolCallId(id)
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }, { type: 'finish', reason: { kind: 'tool-calls' } }]
}

/** Encode a synthetic settled text response.
 * @param text Fixture reply.
 * @returns Scripted protocol chunks without production-model usage.
 */
export function textResponse(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text }, { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }, { type: 'finish', reason: { kind: 'stop' } }]
}

const toolResult = (options: GenerateOptions) => {
  const message = options.messages.findLast(message => message.role === 'tool')
  if (message?.role !== 'tool') return undefined
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
  return { callId: String(message.toolCallId), error: !!message.isError, text }
}

/** Script decisions read only actual rendered tool results, including mailbox-carried cross-branch assay IDs. */
/** Build the fixed three-task demo policy, reading only real tool results.
 * @param chamber Assigned demo chamber.
 * @returns A scripted response function; this is not a language model.
 */
export function createWorkerPolicy(chamber: Chamber) {
  let ordinal = 0, consumed = '', lastName = '', lastArgs: Record<string, unknown> = {}, after = 0
  let assignment: string | undefined, operation: string | undefined, retry: { name: string; args: Record<string, unknown> } | undefined
  let sampled = 0, sampleId: string | undefined, watered = chamber !== 'B', lit = chamber !== 'A'
  let analysis: string | undefined, completed = false, shared = false, inboxChecked = false
  const assays: string[] = [], references: string[] = []
  const task = chamber === 'A' ? 'light-A' : chamber === 'B' ? 'water-B' : 'reference-C'
  const call = (name: string, args: Record<string, unknown>): StreamChunk[] => {
    lastName = name; lastArgs = args
    return toolCallResponse(`${chamber}-${++ordinal}`, name, args)
  }
  return (options: GenerateOptions): StreamChunk[] => {
    const result = toolResult(options)
    if (result && result.callId !== consumed) {
      consumed = result.callId
      if (result.error) {
        if (!/Resource busy/i.test(result.text)) throw new Error(`${chamber}: ${lastName}: ${result.text}`)
        retry = { name: lastName, args: lastArgs }
        return call('greenhouse_observe', {})
      }
      const value = JSON.parse(result.text)
      if (lastName === 'greenhouse_observe') {
        after = value.events.at(-1)?.seq ?? after
        if (operation && !value.activeOperations.some((active: { id: string }) => active.id === operation))
          return call('greenhouse_result', { operation_id: operation })
        return call('greenhouse_wait', { after_seq: after, ...(operation ? { operation_id: operation } : {}) })
      }
      if (lastName === 'greenhouse_wait') {
        after = value.last_seq
        if (retry) { const pending = retry; retry = undefined; return call(pending.name, pending.args) }
        if (operation) return call('greenhouse_result', { operation_id: operation })
        inboxChecked = false
      }
      if (lastName === 'lab_inbox') {
        inboxChecked = true
        for (const message of value) {
          if (message.from === 'lead' && message.task_id) assignment = message.task_id
          if (message.from === 'chamber-B') {
            const data = JSON.parse(message.content)
            references.push(...z.array(z.string()).parse(data.assayIds))
          }
        }
      }
      if (lastName.startsWith('greenhouse_') && !['greenhouse_result', 'greenhouse_wait', 'greenhouse_observe'].includes(lastName)) {
        operation = value.id
        return call('greenhouse_result', { operation_id: operation })
      }
      if (lastName === 'greenhouse_result') {
        const current = value.operation
        if (current.state !== 'succeeded') {
          if (current.state !== 'running' && current.state !== 'accepted') throw new Error(`Unexpected device state ${current.state}`)
          return call('greenhouse_observe', {})
        }
        operation = undefined
        const command = current.input, output = value.outputs[0].data.result
        if (command.action === 'water') watered = true
        if (command.action === 'light') lit = true
        if (command.action === 'sample') { sampleId = output.sampleId; sampled++ }
        if (command.action === 'assay') { assays.push(output.id); sampleId = undefined }
        if (command.action === 'analyze') analysis = current.id
      }
      if (lastName === 'lab_complete') completed = true
      if (lastName === 'lab_message') shared = true
    }
    if (!assignment) {
      if (!inboxChecked) return call('lab_inbox', {})
      return call('greenhouse_observe', {})
    }
    if (!lit) return call('greenhouse_light', { chamber, level: 0.7, requestKey: `${chamber}-light` })
    if (!watered) return call('greenhouse_water', { chamber, litres: 2, requestKey: `${chamber}-water` })
    if (sampleId) return call('greenhouse_assay', { sampleId, requestKey: `${chamber}-assay-${sampled}` })
    if (sampled < 2) return call('greenhouse_sample', { chamber, taskId: task, requestKey: `${chamber}-sample-${sampled + 1}` })
    if (chamber === 'C' && !references.length) {
      if (!inboxChecked) return call('lab_inbox', {})
      inboxChecked = false
      return call('greenhouse_observe', {})
    }
    if (!analysis) return call('greenhouse_analyze', { taskId: task, assayIds: [...assays, ...references], requestKey: `${chamber}-analysis` })
    if (!completed) return call('lab_complete', { task_id: assignment, operation_id: analysis })
    if (chamber === 'B' && !shared) return call('lab_message', { to: 'chamber-C', content: JSON.stringify({ assayIds: assays }) })
    return textResponse(`${chamber}: real execution completed and accounted for.`)
  }
}
