/** Laboratory device rules use integer microlitres and logical ticks. */
import { z } from 'zod'

const id = z.string().min(1)
const tick = z.number().int().nonnegative()
const volume = z.number().int().positive()
const device = z.object({
  id, kind: z.enum(['liquid-handler', 'centrifuge', 'heater', 'screen', 'confirm', 'robot', 'cold-store', 'freezer', 'incubator', 'imager', 'water-module', 'analysis']),
  maximumBatchSamples: volume.default(1), batchMultiple: volume.default(1),
  waterRole: z.enum(['reservoir', 'filter', 'pump']).optional(),
  powerDraw: z.number().nonnegative().default(0), waterPerProcessUl: z.number().int().nonnegative().default(0),
  conditions: z.object({ initialTemperature: z.number().finite(), targetTemperature: z.number().finite(),
    minimumTarget: z.number().finite(), maximumTarget: z.number().finite(), ambientTemperature: z.number().finite(),
    driftPerTick: z.number().positive(), controlPerTick: z.number().positive() }).strict().optional(),
  methods: z.array(id), containers: z.array(id).min(1), capacity: z.number().int().positive(),
}).strict()
const method = z.object({
  id, version: z.number().int().positive(), inputState: id, outputState: id,
  processingTicks: z.number().int().positive(), requiresCalibration: z.boolean(), dirtiesDevice: z.boolean(),
  operatingRange: z.object({ minimumTemperature: z.number().finite(), maximumTemperature: z.number().finite() }).strict().optional(),
  supplies: z.array(z.object({ kind: id, units: volume }).strict()),
}).strict()
const sample = z.object({
  id, projectId: id, parentId: id.optional(), container: id, location: id,
  volumeUl: z.number().int().nonnegative(), state: id, expiresAt: tick,
  disposition: z.enum(['available', 'quarantined']), batchIds: z.array(id),
  preservation: z.object({ minimumTemperature: z.number().finite(), maximumTemperature: z.number().finite(),
    maximumExposureTicks: z.number().int().nonnegative() }).strict().optional(), exposureTicks: tick.default(0),
}).strict()

const batch = z.object({ id, kind: id, units: z.number().int().nonnegative(), expiresAt: tick,
  disposition: z.enum(['available', 'recalled']) }).strict()
const task = z.object({ id, projectId: id, title: id, methodId: id, methodVersion: z.number().int().positive(),
  rootSampleIds: z.array(id).min(1), requiredResults: z.number().int().positive(), prerequisites: z.array(id), releaseTick: tick }).strict()
const revision = z.discriminatedUnion('kind', [
  z.object({ id, tick, kind: z.literal('method'), methodId: id, version: z.number().int().positive() }).strict(),
  z.object({ id, tick, kind: z.literal('power'), capacity: z.number().positive() }).strict(),
  z.object({ id, tick, kind: z.literal('recall'), batchId: id, reason: id }).strict(),
])

/** Versioned scenario definition; scheduled faults are evaluator-only data. */
export const laboratoryScenarioSchema = z.object({
  version: z.literal(1), externalReferences: z.boolean().default(false), devices: z.array(device).min(1), methods: z.array(method).min(1), samples: z.array(sample).min(1),
  calibrationLifetimeTicks: z.number().int().positive(),
  loadingTicks: z.number().int().positive(), handlingTicks: z.number().int().positive(), maintenanceTicks: z.number().int().positive(),
  facilities: z.object({ powerCapacity: z.number().positive(), ambientTemperature: z.number().finite(), initialWaterUl: tick, waterCapacityUl: volume }).strict(),
  supplyCatalog: z.array(z.object({ kind: id, unitsPerOrder: volume, deliveryTicks: volume, shelfLifeTicks: volume }).strict()),
  projects: z.array(z.object({ id, title: id }).strict()), tasks: z.array(task), batches: z.array(batch), revisions: z.array(revision),
  faults: z.array(z.object({ id, tick, deviceId: id }).strict()),
}).strict().superRefine((scenario, ctx) => {
  for (const [name, values] of Object.entries({ devices: scenario.devices, methods: scenario.methods.map(method => ({ id: `${method.id}@${method.version}` })),
    samples: scenario.samples, faults: scenario.faults, projects: scenario.projects, tasks: scenario.tasks, batches: scenario.batches, revisions: scenario.revisions })) {
    if (new Set(values.map(value => value.id)).size !== values.length)
      ctx.addIssue({ code: 'custom', message: `Duplicate ${name} IDs` })
  }
  if (scenario.facilities.initialWaterUl > scenario.facilities.waterCapacityUl)
    ctx.addIssue({ code: 'custom', message: 'Initial water exceeds storage capacity' })
  if (new Set(scenario.supplyCatalog.map(value => value.kind)).size !== scenario.supplyCatalog.length)
    ctx.addIssue({ code: 'custom', message: 'Supply catalog kinds must be unique' })
  const devices = new Map(scenario.devices.map(value => [value.id, value]))
  const methods = new Set(scenario.methods.map(value => value.id))
  for (const value of scenario.devices) {
    if (value.batchMultiple > value.maximumBatchSamples || value.maximumBatchSamples > value.capacity)
      ctx.addIssue({ code: 'custom', message: 'Device batch limits exceed physical capacity' })
    if (value.conditions && (value.conditions.minimumTarget > value.conditions.maximumTarget || value.conditions.targetTemperature < value.conditions.minimumTarget || value.conditions.targetTemperature > value.conditions.maximumTarget))
      ctx.addIssue({ code: 'custom', message: 'Device target temperature is outside declared settings' })
    if (value.methods.some(methodId => !methods.has(methodId)))
      ctx.addIssue({ code: 'custom', message: 'Device references an unknown method' })
  }
  for (const value of scenario.samples) {
    if (value.preservation && value.preservation.minimumTemperature > value.preservation.maximumTemperature)
      ctx.addIssue({ code: 'custom', message: 'Sample preservation temperature range is inverted' })
    const location = devices.get(value.location)
    if (!location || !location.containers.includes(value.container))
      ctx.addIssue({ code: 'custom', message: 'Sample location or container is unsupported' })
    if (value.parentId !== undefined)
      ctx.addIssue({ code: 'custom', message: 'Initial samples must be original samples' })
  }
  for (const value of scenario.devices)
    if (scenario.samples.filter(item => item.location === value.id).length > value.capacity)
      ctx.addIssue({ code: 'custom', message: 'Initial storage capacity exceeded' })
  const projects = new Set(scenario.projects.map(project => project.id))
  for (const sample of scenario.samples)
    if (!projects.has(sample.projectId) || sample.batchIds.some(batchId => !scenario.batches.some(batch => batch.id === batchId)))
      ctx.addIssue({ code: 'custom', message: 'Sample references unknown project or consumable batch' })
  const tasks = new Map(scenario.tasks.map(value => [value.id, value]))
  const samples = new Map(scenario.samples.map(value => [value.id, value]))
  for (const value of scenario.tasks) {
    if (!projects.has(value.projectId) || !scenario.methods.some(method => method.id === value.methodId && method.version === value.methodVersion) ||
      value.rootSampleIds.some(sampleId => samples.get(sampleId)?.projectId !== value.projectId) ||
      new Set(value.rootSampleIds).size < value.requiredResults || value.prerequisites.some(taskId => !tasks.has(taskId)))
      ctx.addIssue({ code: 'custom', message: 'Task has invalid project, method, roots, result count or prerequisites' })
    const visited = new Set<string>(), pending = [...value.prerequisites]
    while (pending.length) {
      const next = pending.pop()!
      if (next === value.id) { ctx.addIssue({ code: 'custom', message: 'Task prerequisites contain a cycle' }); break }
      if (!visited.has(next)) { visited.add(next); pending.push(...(tasks.get(next)?.prerequisites ?? [])) }
    }
  }
  for (const value of scenario.methods) {
    if (value.operatingRange && value.operatingRange.minimumTemperature > value.operatingRange.maximumTemperature)
      ctx.addIssue({ code: 'custom', message: 'Method operating temperature range is inverted' })
    if (new Set(value.supplies.map(supply => supply.kind)).size !== value.supplies.length)
      ctx.addIssue({ code: 'custom', message: 'Method supply kinds must be unique' })
  }
  for (const value of scenario.revisions) {
    if (value.tick === 0 || (value.kind === 'power' ? false : value.kind === 'method' ? !scenario.methods.some(method => method.id === value.methodId && method.version === value.version) :
      !scenario.batches.some(batch => batch.id === value.batchId)))
      ctx.addIssue({ code: 'custom', message: 'Revision needs a known target and a positive tick' })
  }

  for (const fault of scenario.faults)
    if (!devices.has(fault.deviceId) || fault.tick === 0)
      ctx.addIssue({ code: 'custom', message: 'Fault needs a known device and a positive tick' })
})
export type LaboratoryScenario = z.infer<typeof laboratoryScenarioSchema>

/** Commands accepted by the laboratory execution provider. */
export const laboratoryCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('aliquot'), deviceId: id, sampleId: id, volumeUl: volume, container: id }).strict(),
  z.object({ action: z.literal('process'), deviceId: id, sampleId: id, volumeUl: volume, methodId: id,
    methodVersion: z.number().int().positive(), additionalSampleIds: z.array(id).optional(), consumables: z.array(z.object({ batchId: id, units: volume }).strict()).optional() }).strict(),
  z.object({ action: z.literal('transfer'), deviceId: id, sampleId: id, destination: id }).strict(),
  z.object({ action: z.literal('configure'), deviceId: id, enabled: z.boolean(), targetTemperature: z.number().finite().optional() }).strict(),
  z.object({ action: z.literal('refill'), deviceId: id, volumeUl: volume }).strict(),
  z.object({ action: z.literal('order'), deviceId: id, kind: id }).strict(),
  z.object({ action: z.literal('clean'), deviceId: id }).strict(),
  z.object({ action: z.literal('calibrate'), deviceId: id }).strict(),
  z.object({ action: z.literal('repair'), deviceId: id }).strict(),
])
export type LaboratoryCommand = z.infer<typeof laboratoryCommandSchema>

const operation = z.object({
  id, identity: id, projectId: id, command: laboratoryCommandSchema,
  state: z.enum(['running', 'succeeded', 'failed', 'cancelled']), stage: z.enum(['loading', 'processing', 'finished']),
  acceptedTick: tick, nextTick: tick, completedTick: tick.optional(), consumedUl: z.number().int().nonnegative(),
  consumedWaterUl: tick, consumedBatches: z.array(z.object({ batchId: id, units: volume }).strict()),
  outputSampleIds: z.array(id).optional(), resultIds: z.array(id).optional(),
  detail: id.optional(), outputSampleId: id.optional(), resultId: id.optional(),
}).strict()
export type LaboratoryOperation = z.infer<typeof operation>

/** Persisted state contains immutable measurement records and separately appended revocations. */
export const laboratoryStateSchema = z.object({
  tick, externalReferences: z.boolean().default(false), samples: z.array(sample), devices: z.array(device.extend({
    dirty: z.boolean(), broken: z.boolean(), enabled: z.boolean(), temperature: z.number().finite().optional(), targetTemperature: z.number().finite().optional(), calibrationId: id.optional(), calibratedUntil: tick.optional(),
  })), operations: z.array(operation), appliedFaults: z.array(id),
  facilities: z.object({ powerCapacity: z.number().positive(), ambientTemperature: z.number().finite(), waterUl: tick, waterCapacityUl: volume }).strict(),
  facilityMetrics: z.object({ powerOverloadTicks: tick, waterUnavailableTicks: tick, unsafeSampleTicks: tick }).strict(),
  shipments: z.array(z.object({ id, kind: id, units: volume, arrivesAt: tick, shelfLifeTicks: volume, delivered: z.boolean() }).strict()),
  batches: z.array(batch), methods: z.array(method), tasks: z.array(task), appliedRevisions: z.array(id),
  deliveries: z.array(z.object({ taskId: id, resultIds: z.array(id), referenceResultIds: z.array(id).optional(), tick, valid: z.boolean() }).strict()),
  results: z.array(z.object({ id, operationId: id, sampleId: id, rootSampleId: id, methodId: id,
    methodVersion: z.number().int().positive(), outputSampleId: id.optional(), calibrationId: id.optional(), batchIds: z.array(id), completedTick: tick }).strict()),
  revocations: z.array(z.object({ resultId: id, reason: id, tick }).strict()),
}).strict()
export type LaboratoryState = z.infer<typeof laboratoryStateSchema>
