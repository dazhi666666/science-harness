/** Scripted feasibility uses the normal Provider/ExecutionEngine; it measures no model advantage. */
import { expect, it } from 'vitest'
import { z } from 'zod'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionEngine } from '../../platform/execution.ts'
import { LaboratoryWorld } from './world.ts'
import { openLaboratoryProvider } from './provider.ts'
import { jointLaboratoryScenario } from './scenario.ts'
import type { LaboratoryCommand } from './schema.ts'

it('completes all six projects through staged devices, recalls and method updates without changing the scenario', async () => {
  const root = mkdtempSync(join(tmpdir(), 'laboratory-feasibility-'))
  const scenario = jointLaboratoryScenario(1), file = join(root, 'scenario.json'), directory = join(root, 'device')
  writeFileSync(file, JSON.stringify(scenario))
  const world = new LaboratoryWorld(directory, scenario)
  const adapter = openLaboratoryProvider({ id: 'laboratory', directory, scenarioFile: file })
  const engine = new ExecutionEngine({ directory: join(root, 'execution'), providers: [adapter.provider], pollIntervalMs: 1, providerCallTimeoutMs: 1000 })
  try {
    await engine.open()
    const actors = new Map(scenario.projects.map(project => {
      engine.createProject(project.id, 0)
      return [project.id, engine.issueContext(project.id, 'scripted-feasibility', ['laboratory'])]
    }))
    let request = 0
    async function execute(projectId: string, command: LaboratoryCommand) {
      const actor = actors.get(projectId)!
      let operation = await engine.submit(actor, { providerId: 'laboratory', requestKey: `feasibility-${++request}`, input: z.json().parse(command) })
      while (operation.state === 'running') {
        world.advance()
        operation = await engine.query(actor, operation.id)
      }
      return operation
    }
    async function maintain(projectId: string, deviceId: string) {
      let device = world.observe().devices.find(value => value.id === deviceId)!
      if (!device.enabled) await execute(projectId, { action: 'configure', deviceId, enabled: true })
      if (device.broken) await execute(projectId, { action: 'repair', deviceId })
      device = world.observe().devices.find(value => value.id === deviceId)!
      if (device.dirty) await execute(projectId, { action: 'clean', deviceId })
      device = world.observe().devices.find(value => value.id === deviceId)!
      if (world.observe().methods.some(method => device.methods.includes(method.id) && method.requiresCalibration) &&
        (!device.calibrationId || (device.calibratedUntil ?? -1) < world.observe().tick + 30))
        await execute(projectId, { action: 'calibrate', deviceId })
    }
    async function maintainFacilities(projectId: string) {
      for (const device of world.observe().devices.filter(value => value.broken && ['water-module', 'cold-store', 'freezer'].includes(value.kind)))
        await maintain(projectId, device.id)
    }
    async function move(sampleId: string, destination: string) {
      let sample = world.observe().samples.find(value => value.id === sampleId)!
      while (sample.location !== destination) {
        await maintain(sample.projectId, 'robot-1')
        await maintain(sample.projectId, destination)
        await execute(sample.projectId, { action: 'transfer', deviceId: 'robot-1', sampleId, destination })
        sample = world.observe().samples.find(value => value.id === sampleId)!
      }
    }
    async function store(sampleId: string) {
      const state = world.observe(), sample = state.samples.find(value => value.id === sampleId)!
      if (!sample.volumeUl) return
      const destination = state.devices.find(device => (sample.disposition === 'quarantined' ? device.kind === 'freezer' : ['cold-store', 'freezer'].includes(device.kind)) && !device.broken &&
        state.samples.filter(value => value.location === device.id && value.volumeUl > 0).length < device.capacity)!
      expect(destination, 'Available sample storage').toBeDefined()
      await move(sampleId, destination.id)
    }
    async function material(rootId: string, desiredState: string): Promise<string> {
      const state = world.observe()
      const byId = new Map(state.samples.map(sample => [sample.id, sample]))
      const rootOf = (sampleId: string) => {
        let sample = byId.get(sampleId)!
        while (sample.parentId) sample = byId.get(sample.parentId)!
        return sample.id
      }
      const existing = state.samples.find(sample => rootOf(sample.id) === rootId && sample.state === desiredState &&
        sample.volumeUl >= 100 && sample.disposition === 'available' && sample.expiresAt >= state.tick)
      if (existing) return existing.id
      const rootSample = state.samples.find(sample => sample.id === rootId)!
      const task = state.tasks.find(task => task.projectId === rootSample.projectId && task.rootSampleIds.includes(rootId) &&
        state.methods.find(method => method.id === task.methodId)!.outputState === desiredState)
      expect(task, `Material path for ${rootId} ${desiredState}`).toBeDefined()
      const result = await processRoot(rootId, task!.methodId)
      return result.outputSampleId!
    }
    async function processRoot(rootId: string, methodId: string) {
      for (;;) {
        const method = world.observe().methods.find(value => value.id === methodId)!
        const sampleId = await material(rootId, method.inputState)
        const source = world.observe().samples.find(value => value.id === sampleId)!
        const device = world.observe().devices.find(value => value.methods.includes(methodId) && value.containers.includes(source.container))!
        const projectId = world.observe().samples.find(value => value.id === sampleId)!.projectId
        await maintainFacilities(projectId)
        await maintain(projectId, device.id)
        if (device.waterPerProcessUl > world.observe().facilities.waterUl) {
          await maintain(projectId, 'reservoir')
          const tank = world.observe().facilities
          await execute(projectId, { action: 'refill', deviceId: 'reservoir', volumeUl: tank.waterCapacityUl - tank.waterUl })
        }
        await move(sampleId, device.id)
        if (world.observe().samples.find(value => value.id === sampleId)!.disposition !== 'available') { await store(sampleId); continue }
        const current = world.observe().methods.find(value => value.id === methodId)!
        const consumables: { batchId: string; units: number }[] = []
        for (const supply of current.supplies) {
          let batch = world.observe().batches.find(value => value.kind === supply.kind && value.disposition === 'available' && value.units >= supply.units)
          if (!batch) {
            await maintain(projectId, 'analysis')
            await execute(projectId, { action: 'order', deviceId: 'analysis', kind: supply.kind })
            while (!batch) {
              world.advance()
              await maintainFacilities(projectId)
              batch = world.observe().batches.find(value => value.kind === supply.kind && value.disposition === 'available' && value.units >= supply.units)
            }
          }
          consumables.push({ batchId: batch.id, units: supply.units })
        }
        await maintainFacilities(projectId)
        const latest = world.observe()
        if (latest.samples.find(value => value.id === sampleId)!.disposition !== 'available' ||
          consumables.some(selection => latest.batches.find(value => value.id === selection.batchId)!.disposition !== 'available')) { await store(sampleId); continue }
        const result = await execute(projectId, { action: 'process', deviceId: device.id, sampleId, volumeUl: 100,
          methodId, methodVersion: latest.methods.find(value => value.id === methodId)!.version, consumables })
        await store(sampleId)
        if (result.state === 'succeeded') {
          const physical = world.observe().operations.find(value => value.id === result.id)!
          await store(physical.outputSampleId!)
          return physical
        }
      }
    }
    function alignPrerequisites(taskId: string, resultIds: string[]): void {
      const state = world.observe(), task = state.tasks.find(value => value.id === taskId)!
      for (const prerequisiteId of task.prerequisites) {
        const prerequisite = state.tasks.find(value => value.id === prerequisiteId)!
        if (prerequisite.projectId !== task.projectId) continue
        const references = resultIds.map(id => {
          const result = state.results.find(value => value.id === id)!
          const ancestors = new Set<string>()
          let sample = state.samples.find(value => value.id === result.sampleId)
          while (sample) { ancestors.add(sample.id); sample = state.samples.find(value => value.id === sample!.parentId) }
          return state.results.find(value => value.methodId === prerequisite.methodId && value.methodVersion === prerequisite.methodVersion &&
            ancestors.has(`sample:${value.operationId}`))!.id
        })
        alignPrerequisites(prerequisiteId, references)
        const external = prerequisite.prerequisites.filter(id => state.tasks.find(task => task.id === id)!.projectId !== prerequisite.projectId)
          .flatMap(id => world.observe().deliveries.find(delivery => delivery.taskId === id && delivery.valid)!.resultIds)
        world.deliver(prerequisite.projectId, prerequisiteId, references, external)
      }
    }
    for (const device of world.observe().devices.filter(value => value.kind === 'incubator'))
      await execute('P1', { action: 'configure', deviceId: device.id, enabled: false })
    while (world.observe().deliveries.filter(delivery => delivery.valid).length < scenario.tasks.length) {
      await maintainFacilities('P1')
      const state = world.observe()
      const task = state.tasks.find(task => !state.deliveries.some(delivery => delivery.taskId === task.id && delivery.valid) &&
        task.prerequisites.every(id => state.deliveries.some(delivery => delivery.taskId === id && delivery.valid)))
      if (!task) { expect(world.advance()).not.toBeNull(); continue }
      const resultIds: string[] = []
      for (const rootId of task.rootSampleIds) {
        const current = world.observe()
        let result = current.results.find(value => value.rootSampleId === rootId && value.methodId === task.methodId &&
          value.methodVersion === current.methods.find(method => method.id === task.methodId)!.version &&
          !current.revocations.some(revocation => revocation.resultId === value.id))
        if (!result) {
          const physical = await processRoot(rootId, task.methodId)
          result = world.observe().results.find(value => value.id === physical.resultId)!
        }
        resultIds.push(result.id)
      }
      const current = world.observe()
      if (resultIds.every(id => current.results.find(value => value.id === id)!.methodVersion ===
        current.methods.find(method => method.id === task.methodId)!.version && !current.revocations.some(value => value.resultId === id)) &&
        task.prerequisites.every(id => current.deliveries.some(delivery => delivery.taskId === id && delivery.valid)))
        {
          alignPrerequisites(task.id, resultIds)
          const references = task.prerequisites.filter(id => current.tasks.find(value => value.id === id)!.projectId !== task.projectId)
            .flatMap(id => world.observe().deliveries.find(delivery => delivery.taskId === id && delivery.valid)!.resultIds)
          world.deliver(task.projectId, task.id, resultIds, references)
        }
    }
    const final = world.observe()
    expect(final.deliveries.filter(delivery => delivery.valid)).toHaveLength(52)
    expect(final.appliedFaults).toHaveLength(3)
    expect(final.appliedRevisions).toHaveLength(4)
    expect(final.operations.every(operation => operation.state !== 'running')).toBe(true)
    expect(final.shipments.some(shipment => shipment.delivered)).toBe(true)
    expect(final.operations.some(operation => operation.command.action === 'refill')).toBe(true)
    expect(final.facilityMetrics.unsafeSampleTicks).toBeGreaterThan(0)
    expect(final.batches.every(batch => batch.units >= 0)).toBe(true)
    expect(new Set(final.results.flatMap(result => result.batchIds))).toContain('extraction-B')
    expect(new Set(final.operations.map(operation => operation.projectId)).size).toBe(6)
  } finally {
    await engine.close(); adapter.close(); world.close()
    rmSync(root, { recursive: true, force: true })
  }
})
