/** Formal scenario topology and logical exceptions are reproducible and validated before model runs. */
import { expect, it } from 'vitest'
import { jointLaboratoryScenario } from './scenario.ts'
import { laboratoryScenarioSchema } from './schema.ts'

it('defines six projects with 48 original samples, distinct devices and cross-project dependencies', () => {
  const scenario = jointLaboratoryScenario(1)
  expect(scenario.projects).toHaveLength(6)
  expect(scenario.samples).toHaveLength(48)
  expect(scenario.devices).toHaveLength(20)
  expect(new Set(scenario.devices.map(device => device.kind)).size).toBeGreaterThanOrEqual(10)
  expect(scenario.tasks).toHaveLength(52)
  expect(scenario.tasks.some(task => task.projectId === 'P6' && task.prerequisites.some(id => id.startsWith('P5-')))).toBe(true)
  expect(scenario.tasks.every(task => task.requiredResults === 2)).toBe(true)
  expect(scenario.revisions).toHaveLength(4)
  expect(jointLaboratoryScenario(1)).toEqual(scenario)
  expect(jointLaboratoryScenario(2).faults).not.toEqual(scenario.faults)
})
it('rejects undefined method versions and cross-project sample substitution at configuration parsing', () => {
  const scenario = jointLaboratoryScenario(1)
  expect(laboratoryScenarioSchema.safeParse({ ...scenario, tasks: [{ ...scenario.tasks[0], methodVersion: 99 }] }).success).toBe(false)
  expect(laboratoryScenarioSchema.safeParse({ ...scenario, tasks: [{ ...scenario.tasks[0], rootSampleIds: ['P2-S1', 'P2-S2'] }] }).success).toBe(false)
})
