/** JSON schemas for a synthetic greenhouse. Values describe game rules, not plant physiology. */
import { z } from 'zod'

export const chamberSchema = z.enum(['A', 'B', 'C'])
export type Chamber = z.infer<typeof chamberSchema>
const id = z.string().min(1)
export const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('light'), chamber: chamberSchema, level: z.number().min(0).max(1) }).strict(),
  z.object({ action: z.literal('temperature'), chamber: chamberSchema, target: z.number().min(10).max(35) }).strict(),
  z.object({ action: z.literal('water'), chamber: chamberSchema, litres: z.number().positive() }).strict(),
  z.object({ action: z.literal('inspect'), chamber: chamberSchema }).strict(),
  z.object({ action: z.literal('calibrate'), chamber: chamberSchema }).strict(),
  z.object({ action: z.literal('sample'), chamber: chamberSchema, taskId: id }).strict(),
  z.object({ action: z.literal('assay'), sampleId: id }).strict(),
  z.object({ action: z.literal('analyze'), taskId: id, assayIds: z.array(id).min(1) }).strict(),
])
export type Command = z.infer<typeof commandSchema>
export const taskSchema = z.object({
  id, chamber: chamberSchema, instructions: id, requiredAssays: z.number().int().positive(),
  minimumSpacingTicks: z.number().int().nonnegative(), requiredLight: z.number().min(0).max(1).optional(),
  requiredWaterLitres: z.number().positive().optional(), referenceTaskId: id.optional(),
}).strict()
export type Task = z.infer<typeof taskSchema>
const initialChamber = z.object({
  temperature: z.number().finite(), moisture: z.number().min(0).max(100), light: z.number().min(0).max(1),
  targetTemperature: z.number().min(10).max(35),
}).strict()
export const scenarioSchema = z.object({
  version: z.literal(1),
  tickMs: z.number().int().positive(),
  simulatedMinutesPerTick: z.number().positive(),
  initial: z.object({ chambers: z.object({ A: initialChamber, B: initialChamber, C: initialChamber }).strict(),
    waterLitres: z.number().nonnegative(), powerCapacity: z.number().positive() }).strict(),
  physics: z.object({ ambientTemperature: z.number().finite(), ambientRelaxation: z.number().min(0).max(1),
    temperatureControl: z.number().min(0).max(1), lightHeating: z.number().nonnegative(),
    moistureLoss: z.number().nonnegative(), lightMoistureLoss: z.number().nonnegative(),
    moisturePerLitre: z.number().positive(), powerPerLight: z.number().positive() }).strict(),
  durations: z.object({ light: z.number().int().positive(), temperature: z.number().int().positive(),
    water: z.number().int().positive(), inspect: z.number().int().positive(), calibrate: z.number().int().positive(),
    sample: z.number().int().positive(), assay: z.number().int().positive(), analyze: z.number().int().positive() }).strict(),
  operatingRange: z.object({ minimumTemperature: z.number(), maximumTemperature: z.number(),
    minimumMoisture: z.number(), maximumMoisture: z.number() }).strict(),
  tasks: z.array(taskSchema).min(1),
  events: z.array(z.discriminatedUnion('kind', [
    z.object({ id, tick: z.number().int().positive(), kind: z.literal('power'), capacity: z.number().positive() }).strict(),
    z.object({ id, tick: z.number().int().positive(), kind: z.literal('sensor'), chamber: chamberSchema, bias: z.number().finite() }).strict(),
    z.object({ id, tick: z.number().int().positive(), kind: z.literal('task'), task: taskSchema }).strict(),
  ])),
}).strict().superRefine((s, ctx) => {
  const allTasks = [...s.tasks, ...s.events.flatMap(e => e.kind === 'task' ? [e.task] : [])]
  if (new Set(allTasks.map(t => t.id)).size !== allTasks.length)
    ctx.addIssue({ code: 'custom', message: 'Task IDs must be unique, including future tasks' })
  if (new Set(s.events.map(e => e.id)).size !== s.events.length)
    ctx.addIssue({ code: 'custom', message: 'Event IDs must be unique' })
  for (const task of allTasks)
    if (task.referenceTaskId && (!allTasks.some(t => t.id === task.referenceTaskId) || task.referenceTaskId === task.id))
      ctx.addIssue({ code: 'custom', message: 'Reference task must name another declared task' })
  if (s.operatingRange.minimumTemperature >= s.operatingRange.maximumTemperature ||
      s.operatingRange.minimumMoisture >= s.operatingRange.maximumMoisture)
    ctx.addIssue({ code: 'custom', message: 'Operating ranges must be increasing' })
  const initialPower = Object.values(s.initial.chambers).reduce((sum, c) => sum + c.light * s.physics.powerPerLight, 0)
  if (initialPower > s.initial.powerCapacity)
    ctx.addIssue({ code: 'custom', message: 'Initial light load exceeds power capacity' })
})
export type Scenario = z.infer<typeof scenarioSchema>

const chamberState = initialChamber.extend({ sensorBias: z.number().finite() })
const sampleSchema = z.object({ id, taskId: id, chamber: chamberSchema, tick: z.number().int(),
  temperature: z.number(), moisture: z.number(), light: z.number() })
const assaySchema = z.object({ id, sampleId: id, taskId: id, chamber: chamberSchema, sampleTick: z.number().int(),
  temperature: z.number(), moisture: z.number(), light: z.number() })
export const jobSchema = z.object({
  id, projectId: id, identity: id, command: commandSchema, resources: z.array(id),
  state: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  startedTick: z.number().int(), dueTick: z.number().int(), completedTick: z.number().int().optional(),
  result: z.json().optional(), detail: z.string().optional(),
})
export type Job = z.infer<typeof jobSchema>
export const stateSchema = z.object({
  tick: z.number().int().nonnegative(), chambers: z.object({ A: chamberState, B: chamberState, C: chamberState }),
  waterLitres: z.number().nonnegative(), powerCapacity: z.number().positive(), tasks: z.array(taskSchema),
  completedTasks: z.array(id), appliedEvents: z.array(id), samples: z.array(sampleSchema), assays: z.array(assaySchema),
  jobs: z.array(jobSchema), metrics: z.object({ temperatureViolationTicks: z.number().int().nonnegative(),
    moistureViolationTicks: z.number().int().nonnegative(), powerOverloadTicks: z.number().int().nonnegative() }),
})
export type State = z.infer<typeof stateSchema>
