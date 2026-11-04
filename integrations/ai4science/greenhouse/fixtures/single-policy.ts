/** Fixed baseline single-Agent script. It uses actual tool results and is never a production-model benchmark. */
import { z } from 'zod'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { textResponse, toolCallResponse } from './policy.ts'

/** Build a single-owner baseline script with the same device tools and evidence requirements as the team.
 * @returns Response generator; its sequential strategy is a fixture choice, not a single-Agent capability restriction.
 */
export function createSinglePolicy() {
  let count = 0, consumed = '', last = '', taskIndex = 0, operation: string | undefined, after = 0
  let assignment: string | undefined, lightSet = false, watered = false, sampled = 0, sampleId: string | undefined
  let analysis: string | undefined
  const taskIds = ['light-A', 'water-B', 'reference-C']
  const allAssays = new Map<string, string[]>()
  const call = (name: string, args: object): StreamChunk[] => {
    last = name
    return toolCallResponse(`single-${++count}`, name, args)
  }
  return (options: GenerateOptions): StreamChunk[] => {
    const tool = options.messages.findLast(message => message.role === 'tool')
    if (tool?.role === 'tool' && String(tool.toolCallId) !== consumed) {
      consumed = String(tool.toolCallId)
      const text = tool.content.filter(block => block.type === 'text').map(block => block.text).join('')
      if (tool.isError) throw new Error(`Single fixture ${last}: ${text}`)
      const value = JSON.parse(text)
      if (last === 'lab_assign') assignment = z.object({ task: z.object({ id: z.string() }).passthrough() }).passthrough().parse(value).task.id
      if (last === 'greenhouse_observe') {
        after = value.events.at(-1)?.seq ?? after
        if (operation && value.activeOperations.some((active: { id: string }) => active.id === operation))
          return call('greenhouse_wait', { after_seq: after, operation_id: operation })
      }
      if (last === 'greenhouse_wait') after = value.last_seq
      if (last === 'greenhouse_result') {
        if (value.operation.state === 'running' || value.operation.state === 'accepted') return call('greenhouse_observe', {})
        if (value.operation.state !== 'succeeded') throw new Error(`Single fixture device failed: ${value.operation.state}`)
        operation = undefined
        const command = value.operation.input, result = value.outputs[0].data.result
        if (command.action === 'light') lightSet = true
        if (command.action === 'water') watered = true
        if (command.action === 'sample') { sampled++; sampleId = result.sampleId }
        if (command.action === 'assay') {
          const assays = allAssays.get(taskIds[taskIndex]!) ?? []
          assays.push(result.id); allAssays.set(taskIds[taskIndex]!, assays); sampleId = undefined
        }
        if (command.action === 'analyze') analysis = value.operation.id
      } else if (last.startsWith('greenhouse_') && !['greenhouse_wait', 'greenhouse_observe'].includes(last)) {
        operation = z.object({ id: z.string() }).passthrough().parse(value).id
      }
      if (last === 'lab_complete') {
        taskIndex++; assignment = undefined; sampled = 0; sampleId = undefined; analysis = undefined
      }
    }
    if (operation) return call('greenhouse_result', { operation_id: operation })
    if (taskIndex === taskIds.length) return textResponse('Fixed single-Agent baseline completed; no superiority claim.')
    const taskId = taskIds[taskIndex]!, chamber = (['A', 'B', 'C'] as const)[taskIndex]!
    if (!assignment) return call('lab_assign', { assignee: 'lead', experiment_task: taskId })
    if (chamber === 'A' && !lightSet) return call('greenhouse_light', { chamber, level: 0.7, requestKey: 'single-A-light' })
    if (chamber === 'B' && !watered) return call('greenhouse_water', { chamber, litres: 2, requestKey: 'single-B-water' })
    if (sampleId) return call('greenhouse_assay', { sampleId, requestKey: `single-${chamber}-assay-${sampled}` })
    if (sampled < 2) return call('greenhouse_sample', { chamber, taskId, requestKey: `single-${chamber}-sample-${sampled + 1}` })
    if (!analysis) return call('greenhouse_analyze', { taskId, assayIds: [...(allAssays.get(taskId) ?? []),
      ...(chamber === 'C' ? allAssays.get('water-B') ?? [] : [])], requestKey: `single-${chamber}-analysis` })
    return call('lab_complete', { task_id: assignment, operation_id: analysis })
  }
}
