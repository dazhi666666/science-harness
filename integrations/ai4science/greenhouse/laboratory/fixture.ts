/** Small laboratory scenario for device-chain integration checks. */
import { laboratoryScenarioSchema } from './schema.ts'

/** Construct independent rules for preparation, screening, confirmation and cold storage.
 * @returns A six-device scenario with one original water sample.
 */
export function laboratoryFixture() {
  return laboratoryScenarioSchema.parse({ version: 1, facilities: { ambientTemperature: 22, powerCapacity: 100, initialWaterUl: 10000, waterCapacityUl: 20000 }, supplyCatalog: [], calibrationLifetimeTicks: 100,
    loadingTicks: 1, handlingTicks: 2, maintenanceTicks: 2,
    projects: [{ id: 'P1', title: 'Water investigation' }], tasks: [], batches: [], revisions: [],
    devices: [
      { id: 'liquid', kind: 'liquid-handler', methods: [], containers: ['tube'], capacity: 8 },
      { id: 'heater', kind: 'heater', methods: ['prepare'], containers: ['tube'], capacity: 4 },
      { id: 'screen', kind: 'screen', methods: ['screen'], containers: ['tube'], capacity: 1 },
      { id: 'confirm', kind: 'confirm', methods: ['confirm'], containers: ['tube'], capacity: 1 },
      { id: 'robot', kind: 'robot', methods: [], containers: ['tube'], capacity: 1 },
      { id: 'cold', kind: 'cold-store', methods: [], containers: ['tube'], capacity: 2 },
    ], methods: [
      { id: 'prepare', version: 1, inputState: 'raw', outputState: 'prepared', processingTicks: 3, requiresCalibration: false, dirtiesDevice: true, supplies: [] },
      { id: 'screen', version: 1, inputState: 'raw', outputState: 'screened', processingTicks: 2, requiresCalibration: true, dirtiesDevice: true, supplies: [] },
      { id: 'confirm', version: 1, inputState: 'prepared', outputState: 'confirmed', processingTicks: 4, requiresCalibration: true, dirtiesDevice: true, supplies: [] },
    ], samples: [{ id: 'water', projectId: 'P1', container: 'tube', location: 'liquid', volumeUl: 100,
      state: 'raw', expiresAt: 1000, disposition: 'available', batchIds: [] }], faults: [] })
}
