/** Reproducible six-project laboratory workload; future events stay in evaluator configuration. */
import { laboratoryScenarioSchema, type LaboratoryScenario } from './schema.ts'

/** Build independent rules for the joint water and greenhouse laboratory.
 * @param seed Positive scenario identity used to vary event timing reproducibly.
 * @returns Validated device, sample, task, method and exception definitions.
 */
export function jointLaboratoryScenario(seed: number): LaboratoryScenario {
  if (!Number.isSafeInteger(seed) || seed < 1) throw new Error('Scenario seed must be a positive safe integer')
  const containers = ['tube', 'vial']
  const definitions: { id: string; kind: LaboratoryScenario['devices'][number]['kind']; methods: string[]; capacity: number }[] = [
    ...[1, 2, 3].map(index => ({ id: `incubator-${index}`, kind: 'incubator' as const, methods: ['culture'], capacity: 8 })),
    ...['reservoir', 'filter', 'pump'].map(id => ({ id, kind: 'water-module' as const, methods: [], capacity: 1 })),
    ...[1, 2].map(index => ({ id: `robot-${index}`, kind: 'robot' as const, methods: [], capacity: 1 })),
    { id: 'liquid-handler', kind: 'liquid-handler', methods: [], capacity: 12 },
    ...[1, 2].map(index => ({ id: `centrifuge-${index}`, kind: 'centrifuge' as const, methods: ['separate'], capacity: 8 })),
    ...[1, 2].map(index => ({ id: `heater-${index}`, kind: 'heater' as const, methods: ['extract', 'water-prepare'], capacity: 8 })),
    ...[1, 2].map(index => ({ id: `cold-${index}`, kind: 'cold-store' as const, methods: [], capacity: 48 })),
    { id: 'freezer', kind: 'freezer', methods: [], capacity: 48 },
    { id: 'screen', kind: 'screen', methods: ['screen'], capacity: 2 },
    { id: 'confirm', kind: 'confirm', methods: ['confirm'], capacity: 2 },
    { id: 'imager', kind: 'imager', methods: ['image'], capacity: 4 },
    { id: 'analysis', kind: 'analysis', methods: ['review'], capacity: 4 },
  ]
  const projects = [
    { id: 'P1', title: 'Reclaimed water baseline' }, { id: 'P2', title: 'Water anomaly investigation' },
    { id: 'P3', title: 'Greenhouse recovery observation' }, { id: 'P4', title: 'Light condition experiment' },
    { id: 'P5', title: 'Nutrient condition experiment' }, { id: 'P6', title: 'Cross-batch review' },
  ]
  const samples = projects.flatMap((project, index) => Array.from({ length: 8 }, (_, sample) => ({
    id: `${project.id}-S${sample + 1}`, projectId: project.id, container: index < 2 ? 'vial' : 'tube',
    location: `cold-${index % 2 + 1}`, volumeUl: 1000, state: 'raw', expiresAt: 3000 + index * 500 + sample * 30,
    disposition: 'available' as const, batchIds: [],
    preservation: { minimumTemperature: index < 2 ? 0 : -15, maximumTemperature: index < 2 ? 8 : 35, maximumExposureTicks: 160 },
  })))
  const methods: LaboratoryScenario['methods'] = [
    { id: 'screen', version: 1, inputState: 'raw', outputState: 'screened', processingTicks: 3, requiresCalibration: true, dirtiesDevice: true, supplies: [] },
    { id: 'water-prepare', version: 1, inputState: 'raw', outputState: 'prepared', processingTicks: 5, requiresCalibration: false, dirtiesDevice: true,
      supplies: [{ kind: 'extraction', units: 1 }] },
    { id: 'culture', version: 1, operatingRange: { minimumTemperature: 20, maximumTemperature: 24 }, inputState: 'raw', outputState: 'cultured', processingTicks: 30, requiresCalibration: false, dirtiesDevice: false, supplies: [{ kind: 'medium', units: 1 }] },
    { id: 'image', version: 1, inputState: 'cultured', outputState: 'imaged', processingTicks: 4, requiresCalibration: false, dirtiesDevice: false, supplies: [] },
    { id: 'separate', version: 1, inputState: 'raw', outputState: 'pelleted', processingTicks: 6, requiresCalibration: false, dirtiesDevice: true, supplies: [] },
    { id: 'extract', version: 1, inputState: 'pelleted', outputState: 'prepared', processingTicks: 7, requiresCalibration: false, dirtiesDevice: true, supplies: [{ kind: 'extraction', units: 1 }] },
    { id: 'confirm', version: 1, inputState: 'prepared', outputState: 'confirmed', processingTicks: 10, requiresCalibration: true, dirtiesDevice: true, supplies: [] },
    { id: 'confirm', version: 2, inputState: 'prepared', outputState: 'confirmed', processingTicks: 12, requiresCalibration: true, dirtiesDevice: true, supplies: [] },
    { id: 'review', version: 1, inputState: 'confirmed', outputState: 'reviewed', processingTicks: 5, requiresCalibration: false, dirtiesDevice: false, supplies: [] },
  ]
  const tasks: LaboratoryScenario['tasks'] = []
  for (const project of projects) {
    for (let group = 0; group < 4; group++) {
      const rootSampleIds = samples.filter(sample => sample.projectId === project.id).slice(group * 2, group * 2 + 2).map(sample => sample.id)
      const phases = project.id === 'P1' ? ['screen'] : project.id === 'P3' || project.id === 'P4' ? ['culture', 'image'] :
        project.id === 'P5' ? ['separate', 'extract', 'confirm'] : project.id === 'P6' ? ['water-prepare', 'confirm', 'review'] : ['water-prepare', 'confirm']
      let previous: string | undefined
      for (const methodId of phases) {
        const id = `${project.id}-B${group + 1}-${methodId}`
        const prerequisites = previous ? [previous] : project.id === 'P2' ? [`P1-B${group + 1}-screen`] :
          project.id === 'P6' ? [`P2-B${group + 1}-confirm`, `P5-B${group + 1}-confirm`] : []
        tasks.push({ id, projectId: project.id, title: `${project.title}: group ${group + 1} ${methodId}`, methodId, methodVersion: 1,
          rootSampleIds, requiredResults: 2, prerequisites, releaseTick: group * 40 })
        previous = id
      }
    }
  }
  const offset = seed % 5 * 7
  return laboratoryScenarioSchema.parse({ version: 1, externalReferences: true, facilities: { ambientTemperature: 22, powerCapacity: 12, initialWaterUl: 200, waterCapacityUl: 5000 },
    supplyCatalog: [{ kind: 'extraction', unitsPerOrder: 24, deliveryTicks: 20, shelfLifeTicks: 3000 },
      { kind: 'medium', unitsPerOrder: 24, deliveryTicks: 15, shelfLifeTicks: 3000 }], devices: definitions.map(device => {
      const thermal = ['incubator', 'cold-store', 'freezer'].includes(device.kind)
      const target = device.kind === 'cold-store' ? 4 : device.kind === 'freezer' ? -10 : 22
      const compatible = device.id === 'heater-1' ? ['vial'] : device.id === 'centrifuge-1' || device.kind === 'incubator' || device.kind === 'imager' ? ['tube'] : containers
      return { ...device, containers: compatible, maximumBatchSamples: device.kind === 'centrifuge' ? device.id === 'centrifuge-1' ? 4 : 2 : device.kind === 'incubator' ? 4 : device.kind === 'heater' ? 2 : 1,
        ...(device.kind === 'water-module' ? { waterRole: device.id } : {}),
        waterPerProcessUl: device.kind === 'incubator' ? 100 : device.kind === 'heater' ? 25 : 0,
        powerDraw: thermal ? 1 : device.kind === 'confirm' ? 3 : device.kind === 'heater' || device.kind === 'centrifuge' ? 2 : 0.5,
        ...(thermal ? { conditions: { initialTemperature: target, targetTemperature: target,
          minimumTarget: device.kind === 'cold-store' ? 0 : device.kind === 'freezer' ? -20 : 16,
          maximumTarget: device.kind === 'cold-store' ? 8 : device.kind === 'freezer' ? -5 : 28,
          ambientTemperature: 22, driftPerTick: 1, controlPerTick: 2 } } : {}) }
    }),
    methods, samples, projects, tasks, calibrationLifetimeTicks: 400, loadingTicks: 1, handlingTicks: 2, maintenanceTicks: 5,
    batches: [{ id: 'extraction-A', kind: 'extraction', units: 12, expiresAt: 5000, disposition: 'available' },
      { id: 'extraction-B', kind: 'extraction', units: 8, expiresAt: 5000, disposition: 'available' },
      { id: 'medium-A', kind: 'medium', units: 8, expiresAt: 5000, disposition: 'available' }],
    faults: [{ id: 'confirm-interruption', tick: 180 + offset, deviceId: 'confirm' },
      { id: 'cold-interruption', tick: 260 + offset, deviceId: 'cold-1' },
      { id: 'water-filter-interruption', tick: 600 + offset, deviceId: 'filter' }],
    revisions: [{ id: 'reduced-power', tick: 220 + offset, kind: 'power', capacity: 8 },
      { id: 'restored-power', tick: 500 + offset, kind: 'power', capacity: 12 }, { id: 'extraction-recall', tick: 340 + offset, kind: 'recall', batchId: 'extraction-A', reason: 'Batch quality notice' },
      { id: 'confirm-method-update', tick: 420 + offset, kind: 'method', methodId: 'confirm', version: 2 }],
  })
}
