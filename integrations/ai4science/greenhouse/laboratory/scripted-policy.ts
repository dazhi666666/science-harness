/** Scripted integration decisions consume only public tool replies; they make no production-model claims. */
import { z } from 'zod'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { toolCallResponse, textResponse } from '../fixtures/policy.ts'
import { laboratoryStateSchema, type LaboratoryCommand, type LaboratoryState } from './schema.ts'

type Call = { name: string; args: Record<string, unknown> }
type Flow<T> = Generator<Call, T, unknown>
type Sample = LaboratoryState['samples'][number]
type Measurement = LaboratoryState['results'][number]
type Task = LaboratoryState['tasks'][number]
const object = z.record(z.string(), z.unknown())

/** Build a decision coroutine for one native laboratory participant.
 * @param role Native role marker in the model input.
 * @param mode Whole organization being exercised.
 * @returns Stateful scripted responses driven by actual previous tool output.
 */
export function laboratoryPolicy(role: string, mode: 'single-agent' | 'multi-agent') {
  let ordinal = 0, lastCall = '', consumedCall = ''
  let catalog: Pick<LaboratoryState, 'devices' | 'methods' | 'batches' | 'shipments'>
  let projects: Pick<LaboratoryState, 'tasks' | 'deliveries' | 'revocations'>
  let samples: Sample[] = [], tick = 0, cursor = 0
  const measurements = new Map<string, Measurement>()
  const assignments = new Map<string, string>()
  const boardSchema = z.object({ tasks: z.array(z.object({ id: z.string(), title: z.string(), assignee: z.string(), status: z.string() }).passthrough()) }).passthrough()
  function* call(name: string, args: Record<string, unknown> = {}): Flow<unknown> { return yield { name, args } }
  function* observe(): Flow<void> {
    const value = object.parse(yield* call('laboratory_observe'))
    tick = z.number().parse(value.tick); cursor = z.number().parse(value.eventCursor)
  }
  function* refresh(): Flow<void> {
    catalog = laboratoryStateSchema.pick({ devices: true, methods: true, batches: true, shipments: true }).strip().parse(yield* call('laboratory_catalog'))
    projects = laboratoryStateSchema.pick({ tasks: true, deliveries: true, revocations: true }).strip().parse(yield* call('laboratory_projects'))
    samples = []
    let offset = 0, total = 0
    do {
      const value = z.object({ total: z.number(), samples: laboratoryStateSchema.shape.samples }).parse(yield* call('laboratory_samples', { offset, limit: 100 }))
      samples.push(...value.samples); total = value.total; offset += value.samples.length
    } while (offset < total)
    yield* observe()
  }
  function* wait(operationId?: string, projectId?: string): Flow<void> {
    yield* observe()
    const mail = z.array(z.unknown()).parse(yield* call('lab_inbox'))
    if (mail.length) return
    yield* call('laboratory_wait', { after_seq: cursor, ...(operationId ? { operation_id: operationId, project_id: projectId } : {}) })
  }
  function* read(projectId: string, operationId: string): Flow<Record<string, unknown>> {
    const value = object.parse(yield* call('laboratory_result', { project_id: projectId, operation_id: operationId }))
    for (const output of z.array(z.object({ data: z.object({ results: laboratoryStateSchema.shape.results.optional() }).passthrough() })).parse(value.outputs))
      for (const result of output.data.results ?? []) measurements.set(result.id, result)
    return object.parse(value.operation)
  }
  function* execute(projectId: string, command: LaboratoryCommand): Flow<Record<string, unknown>> {
    const { action, ...fields } = command
    let value = object.parse(yield* call(`laboratory_${action}`, { project_id: projectId, requestKey: `${role}-script-${++ordinal}`, ...fields }))
    const operationId = z.string().parse(value.id)
    while (['registered', 'dispatching', 'accepted', 'running'].includes(z.string().parse(value.state))) {
      yield* wait(operationId, projectId)
      value = yield* read(projectId, operationId)
    }
    if (value.state === 'succeeded') value = yield* read(projectId, operationId)
    yield* refresh()
    return value
  }
  function* maintain(projectId: string, deviceId: string): Flow<void> {
    let device = catalog.devices.find(device => device.id === deviceId)!
    if (!device.enabled) yield* execute(projectId, { action: 'configure', deviceId, enabled: true })
    device = catalog.devices.find(device => device.id === deviceId)!
    if (device.broken) yield* execute(projectId, { action: 'repair', deviceId })
    device = catalog.devices.find(device => device.id === deviceId)!
    if (device.dirty) yield* execute(projectId, { action: 'clean', deviceId })
    device = catalog.devices.find(device => device.id === deviceId)!
    if (catalog.methods.some(method => device.methods.includes(method.id) && method.requiresCalibration) &&
      (!device.calibrationId || (device.calibratedUntil ?? -1) < tick + 40)) yield* execute(projectId, { action: 'calibrate', deviceId })
  }
  function* facilities(projectId: string): Flow<void> {
    for (const device of catalog.devices.filter(device => device.broken && ['water-module', 'cold-store', 'freezer'].includes(device.kind)))
      yield* maintain(projectId, device.id)
  }
  function* move(sampleId: string, destination: string): Flow<void> {
    while (samples.find(sample => sample.id === sampleId)!.location !== destination) {
      const sample = samples.find(sample => sample.id === sampleId)!
      yield* facilities(sample.projectId)
      const robot = catalog.devices.find(device => device.kind === 'robot' && device.containers.includes(sample.container))
      if (!robot) throw new Error('Scripted policy has no compatible transport robot')
      yield* maintain(sample.projectId, robot.id); yield* maintain(sample.projectId, destination)
      yield* execute(sample.projectId, { action: 'transfer', deviceId: robot.id, sampleId, destination })
    }
  }
  function* store(sampleId: string): Flow<void> {
    const sample = samples.find(sample => sample.id === sampleId)!
    if (!sample.volumeUl) return
    const destination = catalog.devices.find(device => (sample.disposition === 'quarantined' ? device.kind === 'freezer' : ['cold-store', 'freezer'].includes(device.kind)) &&
      !device.broken && device.containers.includes(sample.container) && samples.filter(sample => sample.location === device.id && sample.volumeUl > 0).length < device.capacity)
    if (!destination) throw new Error('Scripted policy has no available sample storage')
    yield* move(sampleId, destination.id)
  }
  function rootOf(sample: Sample): string {
    const byId = new Map(samples.map(sample => [sample.id, sample]))
    while (sample.parentId) sample = byId.get(sample.parentId)!
    return sample.id
  }
  function* material(rootId: string, state: string): Flow<string> {
    const existing = samples.find(sample => rootOf(sample) === rootId && sample.state === state && sample.volumeUl >= 100 && sample.disposition === 'available' && sample.expiresAt >= tick)
    if (existing) return existing.id
    const task = projects.tasks.find(task => task.rootSampleIds.includes(rootId) && catalog.methods.find(method => method.id === task.methodId)!.outputState === state)
    if (!task) throw new Error(`Scripted policy has no material route for ${rootId} ${state}`)
    return (yield* process(rootId, task.methodId)).outputSampleId!
  }
  function* process(rootId: string, methodId: string): Flow<{ resultId: string; outputSampleId: string }> {
    for (;;) {
      const method = catalog.methods.find(method => method.id === methodId)!
      const sampleId = yield* material(rootId, method.inputState)
      const sample = samples.find(sample => sample.id === sampleId)!
      const device = catalog.devices.find(device => device.methods.includes(methodId) && device.containers.includes(sample.container))!
      yield* facilities(sample.projectId); yield* maintain(sample.projectId, device.id)
      const observation = object.parse(yield* call('laboratory_observe'))
      const water = laboratoryStateSchema.shape.facilities.parse(observation.facilities)
      if (water.waterUl < device.waterPerProcessUl) {
        yield* maintain(sample.projectId, 'reservoir')
        yield* execute(sample.projectId, { action: 'refill', deviceId: 'reservoir', volumeUl: water.waterCapacityUl - water.waterUl })
      }
      yield* move(sampleId, device.id)
      const current = catalog.methods.find(method => method.id === methodId)!
      const consumables: { batchId: string; units: number }[] = []
      for (const supply of current.supplies) {
        let batch = catalog.batches.find(batch => batch.kind === supply.kind && batch.disposition === 'available' && batch.units >= supply.units && batch.expiresAt >= tick)
        if (!batch) {
          yield* maintain(sample.projectId, 'analysis')
          yield* execute(sample.projectId, { action: 'order', deviceId: 'analysis', kind: supply.kind })
          while (!batch) {
            yield* wait(); yield* refresh(); yield* facilities(sample.projectId)
            batch = catalog.batches.find(batch => batch.kind === supply.kind && batch.disposition === 'available' && batch.units >= supply.units && batch.expiresAt >= tick)
          }
        }
        consumables.push({ batchId: batch.id, units: supply.units })
      }
      yield* facilities(sample.projectId)
      if (samples.find(sample => sample.id === sampleId)!.disposition !== 'available' || consumables.some(selection => catalog.batches.find(batch => batch.id === selection.batchId)!.disposition !== 'available')) {
        yield* store(sampleId); continue
      }
      const result = yield* execute(sample.projectId, { action: 'process', deviceId: device.id, sampleId, volumeUl: 100, methodId,
        methodVersion: catalog.methods.find(method => method.id === methodId)!.version, consumables })
      yield* store(sampleId)
      if (result.state === 'succeeded') {
        const operation = object.parse(yield* call('laboratory_result', { project_id: sample.projectId, operation_id: result.id }))
        const physical = z.object({ outputSampleId: z.string(), resultId: z.string() }).passthrough().parse(object.parse(z.array(object).parse(operation.outputs)[0]!.data).operation)
        yield* store(physical.outputSampleId)
        return physical
      }
    }
  }
  function valid(result: Measurement, task: Task): boolean {
    return result.methodId === task.methodId && result.methodVersion === task.methodVersion && task.rootSampleIds.includes(result.rootSampleId) &&
      !projects.revocations.some(revocation => revocation.resultId === result.id)
  }
  function* recoverMeasurements(projectId: string): Flow<void> {
    let offset = 0, total = 0
    do {
      const value = z.object({ total: z.number(), measurements: laboratoryStateSchema.shape.results }).parse(
        yield* call('laboratory_measurements', { project_id: projectId, offset, limit: 100 }))
      for (const result of value.measurements) measurements.set(result.id, result)
      total = value.total; offset += value.measurements.length
    } while (offset < total)
  }
  function* assign(task: Task): Flow<string | undefined> {
    if (mode === 'multi-agent') {
      const board = boardSchema.parse(yield* call('lab_status'))
      const assignment = board.tasks.find(value => value.title === task.id)
      if (!assignment) throw new Error('A phase must have a Router assignment before scripted execution')
      return assignment.assignee === role ? assignment.id : undefined
    }
    const known = assignments.get(task.id)
    if (known) return known
    const result = object.parse(yield* call('lab_assign', { assignee: 'lead', experiment_task: task.id }))
    const id = z.object({ id: z.string() }).parse(result.task).id
    assignments.set(task.id, id)
    return id
  }
  function* deliver(taskId: string, resultIds: string[]): Flow<void> {
    const task = projects.tasks.find(task => task.id === taskId)!
    for (const prerequisiteId of task.prerequisites) {
      const prerequisite = projects.tasks.find(task => task.id === prerequisiteId)!
      if (prerequisite.projectId !== task.projectId) continue
      const refs = resultIds.map(id => {
        const result = measurements.get(id)!, ancestry = new Set<string>()
        let sample = samples.find(sample => sample.id === result.sampleId)
        while (sample) { ancestry.add(sample.id); sample = samples.find(value => value.id === sample!.parentId) }
        const reference = [...measurements.values()].find(value => valid(value, prerequisite) && ancestry.has(value.outputSampleId ?? `sample:${value.operationId}`))
        if (!reference) throw new Error('Scripted policy could not align a prerequisite measurement')
        return reference.id
      })
      yield* deliver(prerequisiteId, refs)
    }
    const routerId = yield* assign(task)
    for (const resultId of resultIds) yield* read(task.projectId, measurements.get(resultId)!.operationId)
    const references: string[] = []
    for (const prerequisiteId of task.prerequisites) {
      const prerequisite = projects.tasks.find(value => value.id === prerequisiteId)!
      if (prerequisite.projectId === task.projectId) continue
      const delivery = projects.deliveries.find(value => value.taskId === prerequisiteId && value.valid)!
      yield* recoverMeasurements(prerequisite.projectId)
      for (const resultId of delivery.resultIds) {
        const result = measurements.get(resultId)
        if (!result) throw new Error('Prerequisite measurement must be recovered before scripted delivery')
        yield* read(prerequisite.projectId, result.operationId)
        references.push(resultId)
      }
    }
    yield* call('laboratory_deliver', { project_id: task.projectId, task_id: task.id, result_ids: resultIds, reference_result_ids: references })
    if (routerId) yield* call('lab_complete', { task_id: routerId })
    else {
      const board = boardSchema.parse(yield* call('lab_status')), owner = board.tasks.find(value => value.title === taskId)!
      yield* call('lab_message', { to: owner.assignee, task_id: owner.id, content: JSON.stringify({ kind: 'updated-phase-delivery', experimentTask: taskId, resultIds, referenceResultIds: references }) })
    }
    yield* refresh()
  }
  function* perform(task: Task): Flow<void> {
    yield* recoverMeasurements(task.projectId)
    const resultIds: string[] = []
    for (const rootId of task.rootSampleIds) {
      let result = [...measurements.values()].find(result => result.rootSampleId === rootId && valid(result, task))
      if (!result) result = measurements.get((yield* process(rootId, task.methodId)).resultId)!
      resultIds.push(result.id)
    }
    const latest = projects.tasks.find(value => value.id === task.id)!
    if (resultIds.every(id => valid(measurements.get(id)!, latest)) && latest.prerequisites.every(id => projects.deliveries.some(delivery => delivery.taskId === id && delivery.valid)))
      yield* deliver(task.id, resultIds)
  }
  function finishedProjects(): boolean {
    return projects.tasks.length > 0 && projects.tasks.every(task => projects.deliveries.some(delivery => delivery.taskId === task.id && delivery.valid))
  }
  function assignee(task: Task): string {
    return task.methodId === 'culture' ? 'facilities' : ['confirm', 'review'].includes(task.methodId) ? 'quality' : 'experiments'
  }
  function* coordinator(): Flow<void> {
    for (;;) {
      yield* call('lab_inbox'); yield* refresh()
      const board = boardSchema.parse(yield* call('lab_status'))
      if (finishedProjects() && board.tasks.every(task => task.status === 'done')) return
      const active = board.tasks.some(task => task.status !== 'done')
      if (!active) {
        const task = projects.tasks.find(task => !projects.deliveries.some(delivery => delivery.taskId === task.id && delivery.valid) &&
          task.prerequisites.every(id => projects.deliveries.some(delivery => delivery.taskId === id && delivery.valid)))
        if (task) {
          yield* call('lab_assign', { assignee: assignee(task), experiment_task: task.id })
          continue
        }
      }
      yield* wait()
    }
  }
  function* worker(): Flow<void> {
    yield* refresh()
    if (role === 'facilities')
      for (const device of catalog.devices.filter(device => device.kind === 'incubator')) yield* execute('P1', { action: 'configure', deviceId: device.id, enabled: false })
    for (;;) {
      yield* call('lab_inbox'); yield* refresh()
      const board = boardSchema.parse(yield* call('lab_status'))
      const nextAssignment = board.tasks.find(task => task.status !== 'done')
      const assignment = nextAssignment?.assignee === role ? nextAssignment : undefined
      if (!assignment) {
        if (finishedProjects()) return
        yield* wait(); continue
      }
      const task = projects.tasks.find(task => task.id === assignment.title)!
      const ready = task.prerequisites.every(id => projects.deliveries.some(delivery => delivery.taskId === id && delivery.valid))
      if (!ready) { yield* wait(); continue }
      yield* facilities(task.projectId)
      const delivery = projects.deliveries.find(delivery => delivery.taskId === task.id && delivery.valid)
      if (delivery) {
        yield* recoverMeasurements(task.projectId)
        for (const resultId of delivery.resultIds) yield* read(task.projectId, measurements.get(resultId)!.operationId)
        yield* call('lab_complete', { task_id: assignment.id })
      } else yield* perform(task)
    }
  }
  function* single(): Flow<void> {
    yield* refresh()
    for (const device of catalog.devices.filter(device => device.kind === 'incubator')) yield* execute('P1', { action: 'configure', deviceId: device.id, enabled: false })
    for (;;) {
      yield* call('lab_inbox'); yield* refresh(); yield* facilities('P1')
      const task = projects.tasks.find(task => !projects.deliveries.some(delivery => delivery.taskId === task.id && delivery.valid) &&
        task.prerequisites.every(id => projects.deliveries.some(delivery => delivery.taskId === id && delivery.valid)))
      if (!task) {
        if (projects.tasks.length && projects.tasks.every(task => projects.deliveries.some(delivery => delivery.taskId === task.id && delivery.valid))) return
        yield* wait(); continue
      }
      yield* assign(task)
      yield* perform(task)
    }
  }
  const createFlow = () => mode === 'single-agent' ? single() : role === 'lead' ? coordinator() : worker()
  let flow = createFlow(), finished = false
  return (options: GenerateOptions): StreamChunk[] => {
    if (!['lead', 'facilities', 'experiments', 'quality'].includes(role) || mode === 'single-agent' && role !== 'lead')
      throw new Error('Unknown scripted laboratory role')
    const message = options.messages.findLast(message => message.role === 'tool')
    let value: unknown
    if (message?.role === 'tool' && String(message.toolCallId) !== consumedCall) {
      consumedCall = String(message.toolCallId)
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      if (message.isError) throw new Error(`Scripted ${role} ${lastCall}: ${text}`)
      value = JSON.parse(text)
    }
    if (finished) { flow = createFlow(); finished = false; value = undefined }
    const next = flow.next(value)
    if (next.done) { finished = true; return textResponse('Scripted laboratory policy settled.') }
    lastCall = next.value.name
    return toolCallResponse(`${role}-lab-${++ordinal}`, next.value.name, next.value.args)
  }
}
