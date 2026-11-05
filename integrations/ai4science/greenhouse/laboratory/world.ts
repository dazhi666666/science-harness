/** Transactional laboratory device state; only explicit event advancement changes logical time. */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson, type Json } from '../../platform/sdk.ts'
import { advanceConditions, powerDemand, preservationEvent, thermalEvent, waterAvailable } from './facilities.ts'
import { laboratoryOutputIds, laboratorySampleIds } from './commands.ts'
import { deliveryValid, refreshDeliveries } from './projects.ts'
import { laboratoryCommandSchema, laboratoryScenarioSchema, laboratoryStateSchema,
  type LaboratoryCommand, type LaboratoryOperation, type LaboratoryScenario, type LaboratoryState } from './schema.ts'

/** Admission refusals have no effects; failures of accepted work retain committed stage effects. */
export class LaboratoryRefusal extends Error {
  constructor(readonly code: 'busy' | 'unavailable' | 'sample' | 'capacity' | 'method' | 'identity' | 'supply' | 'task', message: string) {
    super(message)
  }
}
const rowSchema = z.object({ config: z.string(), state: z.string() })
const eventSchema = z.object({ seq: z.number(), tick: z.number(), kind: z.string(), payload: z.string() })
function json(value: unknown): Json { return z.json().parse(value) }
function sampleOf(state: LaboratoryState, id: string) {
  const value = state.samples.find(sample => sample.id === id)
  if (!value) throw new LaboratoryRefusal('sample', `Unknown sample ${id}`)
  return value
}
function deviceOf(state: LaboratoryState, id: string) {
  const value = state.devices.find(device => device.id === id)
  if (!value) throw new LaboratoryRefusal('unavailable', `Unknown device ${id}`)
  return value
}

/** SQLite owns admission, stage effects and event records in a single transaction. */
export class LaboratoryWorld {
  readonly directory: string
  readonly scenario: LaboratoryScenario
  readonly scenarioHash: string
  private readonly db: DatabaseSync
  private closed = false

  /** Open a fresh domain or reopen matching rules; each formal run uses its own directory.
   * @param directory Private laboratory device directory.
   * @param input Scenario rules, including evaluator-only future faults.
   */
  constructor(directory: string, input: LaboratoryScenario) {
    this.directory = resolve(directory)
    this.scenario = laboratoryScenarioSchema.parse(input)
    const config = canonicalJson(json(JSON.parse(JSON.stringify(this.scenario))))
    this.scenarioHash = createHash('sha256').update(config).digest('hex')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(join(this.directory, 'laboratory.sqlite'))
    try {
      const version = z.object({ user_version: z.number() }).parse(this.db.prepare('PRAGMA user_version').get()).user_version
      if (version !== 0 && version !== 1) throw new Error(`Unsupported laboratory schema ${version}`)
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS world(id INTEGER PRIMARY KEY CHECK(id=1),config TEXT NOT NULL,state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS domain(id INTEGER PRIMARY KEY CHECK(id=1),directory TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,tick INTEGER NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL);
        PRAGMA user_version=1; BEGIN IMMEDIATE;`)
      const existing = this.db.prepare('SELECT config,state FROM world WHERE id=1').get()
      if (existing) {
        const row = rowSchema.parse(existing)
        if (row.config !== config) throw new Error('Laboratory rules changed; use a new run directory')
        laboratoryStateSchema.parse(JSON.parse(row.state))
      } else {
        const state: LaboratoryState = { tick: 0, externalReferences: this.scenario.externalReferences, samples: this.scenario.samples,
          devices: this.scenario.devices.map(device => ({ ...device, dirty: false, broken: false, enabled: true,
            ...(device.conditions ? { temperature: device.conditions.initialTemperature, targetTemperature: device.conditions.targetTemperature } : {}) })),
          operations: [], results: [], revocations: [], appliedFaults: [], batches: this.scenario.batches, tasks: this.scenario.tasks,
          methods: this.scenario.methods.filter(method => !this.scenario.methods.some(other => other.id === method.id && other.version < method.version)),
          appliedRevisions: [], deliveries: [], shipments: [],
          facilities: { ambientTemperature: this.scenario.facilities.ambientTemperature, powerCapacity: this.scenario.facilities.powerCapacity, waterUl: this.scenario.facilities.initialWaterUl, waterCapacityUl: this.scenario.facilities.waterCapacityUl },
          facilityMetrics: { powerOverloadTicks: 0, waterUnavailableTicks: 0, unsafeSampleTicks: 0 } }
        this.db.prepare('INSERT INTO world VALUES(1,?,?)').run(config, JSON.stringify(state))
        this.event(0, 'laboratory-created', { scenarioHash: this.scenarioHash })
      }
      this.db.exec('COMMIT')
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      this.db.close()
      throw error
    }
  }
  private load(): LaboratoryState {
    if (this.closed) throw new Error('Laboratory is closed')
    const row = rowSchema.parse(this.db.prepare('SELECT config,state FROM world WHERE id=1').get())
    return laboratoryStateSchema.parse(JSON.parse(row.state))
  }
  private update<T>(body: (state: LaboratoryState) => T): T {
    if (this.closed) throw new Error('Laboratory is closed')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const state = this.load(), result = body(state)
      this.db.prepare('UPDATE world SET state=? WHERE id=1').run(JSON.stringify(laboratoryStateSchema.parse(state)))
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  private event(tick: number, kind: string, payload: Json): void {
    this.db.prepare('INSERT INTO events(tick,kind,payload) VALUES(?,?,?)').run(tick, kind, JSON.stringify(payload))
  }
  private validate(state: LaboratoryState, projectId: string, command: LaboratoryCommand, batchMember = false): void {
    const device = deviceOf(state, command.deviceId)
    const active = state.operations.filter(operation => operation.state === 'running')
    if (active.some(operation => operation.command.deviceId === device.id))
      throw new LaboratoryRefusal('busy', 'Device has accepted work; query or wait for its operation')
    if (command.action === 'repair' || command.action === 'configure') {
      if (command.action === 'configure' && command.targetTemperature !== undefined && (!device.conditions || command.targetTemperature < device.conditions.minimumTarget || command.targetTemperature > device.conditions.maximumTarget))
        throw new LaboratoryRefusal('unavailable', 'Target temperature is outside declared device settings')
      return
    }
    if (!device.enabled) throw new LaboratoryRefusal('unavailable', 'Device is disabled')
    if (device.broken) throw new LaboratoryRefusal('unavailable', 'Device requires repair')
    if (command.action === 'refill') {
      if (device.waterRole !== 'reservoir' || command.volumeUl + state.facilities.waterUl > state.facilities.waterCapacityUl)
        throw new LaboratoryRefusal('supply', 'Refill needs a water module and sufficient tank capacity')
      return
    }
    if (command.action === 'order') {
      if (device.kind !== 'analysis' || !this.scenario.supplyCatalog.some(value => value.kind === command.kind))
        throw new LaboratoryRefusal('supply', 'Order needs the analysis workstation and a catalog supply kind')
      return
    }
    if (command.action === 'calibrate' && !this.scenario.methods.some(method => device.methods.includes(method.id) && method.requiresCalibration))
      throw new LaboratoryRefusal('method', 'Device has no calibration-dependent method')
    if (command.action === 'clean' || command.action === 'calibrate') return
    if (command.action === 'process' && !batchMember) {
      const inputs = laboratorySampleIds(command)
      if (new Set(inputs).size !== inputs.length || inputs.length > device.maximumBatchSamples || inputs.length % device.batchMultiple !== 0)
        throw new LaboratoryRefusal('capacity', 'Batch needs distinct samples within device limits and balancing multiple')
      for (const sampleId of inputs.slice(1)) this.validate(state, projectId, {
        action: 'process', deviceId: command.deviceId, sampleId, volumeUl: command.volumeUl,
        methodId: command.methodId, methodVersion: command.methodVersion,
      }, true)
    }
    const sample = sampleOf(state, command.sampleId)
    if (sample.projectId !== projectId || sample.volumeUl === 0 || command.action !== 'transfer' && (sample.disposition !== 'available' || sample.expiresAt < state.tick))
      throw new LaboratoryRefusal('sample', 'Sample is unavailable for this project')
    if (active.some(operation => 'sampleId' in operation.command && laboratorySampleIds(operation.command).includes(sample.id)))
      throw new LaboratoryRefusal('busy', 'Sample has accepted work')
    if (!device.containers.includes(sample.container)) throw new LaboratoryRefusal('sample', 'Container is incompatible')
    if (command.action === 'transfer') {
      if (device.kind !== 'robot') throw new LaboratoryRefusal('method', 'Transfer requires a robot')
      const destination = deviceOf(state, command.destination)
      if (destination.kind === 'robot' || destination.broken || !destination.containers.includes(sample.container))
        throw new LaboratoryRefusal('unavailable', 'Destination cannot store this sample')
      if (active.some(operation => operation.command.deviceId === destination.id))
        throw new LaboratoryRefusal('busy', 'Destination has accepted work')
      const incoming = active.filter(operation => operation.command.action === 'transfer' && operation.command.destination === destination.id)
      if (state.samples.filter(value => value.location === destination.id && value.volumeUl > 0).length + incoming.length >= destination.capacity)
        throw new LaboratoryRefusal('capacity', 'Destination has no unreserved position')
      return
    }
    const incoming = active.filter(operation => operation.command.action === 'transfer' && operation.command.destination === device.id)
    const occupied = state.samples.filter(value => value.location === device.id && value.volumeUl > 0).length
    if (occupied + incoming.length + laboratorySampleIds(command).filter(id => command.volumeUl < sampleOf(state, id).volumeUl).length > device.capacity)
      throw new LaboratoryRefusal('capacity', 'Output requires an unreserved device position')
    if (device.dirty) throw new LaboratoryRefusal('unavailable', 'Device requires cleaning')
    if (command.volumeUl > sample.volumeUl) throw new LaboratoryRefusal('sample', 'Insufficient remaining sample volume')
    if (command.action === 'aliquot') {
      if (device.kind !== 'liquid-handler' || !device.containers.includes(command.container))
        throw new LaboratoryRefusal('method', 'Aliquot requires a compatible liquid handler and output container')
      if (sample.location !== device.id) throw new LaboratoryRefusal('sample', 'Transport sample to the liquid handler first')
      return
    }
    const method = state.methods.find(value => value.id === command.methodId)
    if (!method || method.version !== command.methodVersion || !device.methods.includes(method.id) || method.inputState !== sample.state)
      throw new LaboratoryRefusal('method', 'Method version, device capability or sample preparation is incompatible')
    const operatingTemperature = device.temperature ?? state.facilities.ambientTemperature
    if (method.operatingRange && (operatingTemperature < method.operatingRange.minimumTemperature || operatingTemperature > method.operatingRange.maximumTemperature))
      throw new LaboratoryRefusal('method', 'Device temperature is outside the method operating range')
    if (device.waterPerProcessUl && (!waterAvailable(state) || state.facilities.waterUl < device.waterPerProcessUl))
      throw new LaboratoryRefusal('supply', 'Water-dependent processing needs a clean functioning water path and sufficient water')
    const additionalPower = device.conditions ? 0 : device.powerDraw
    if (powerDemand(state) + additionalPower > state.facilities.powerCapacity)
      throw new LaboratoryRefusal('supply', 'Insufficient shared power for this device operation')
    if (!batchMember) this.validateSupplies(state, command, method.supplies.map(supply => ({ ...supply, units: supply.units * laboratorySampleIds(command).length })))
    if (sample.location !== device.id) throw new LaboratoryRefusal('sample', 'Transport sample to the processing device first')
    if (method.requiresCalibration && (!device.calibrationId || (device.calibratedUntil ?? -1) < state.tick))
      throw new LaboratoryRefusal('unavailable', 'Method requires a current calibration')
  }

  private validateSupplies(state: LaboratoryState, command: Extract<LaboratoryCommand, { action: 'process' }>,
    required: { kind: string; units: number }[]): void {
    const selected = command.consumables ?? []
    if (new Set(selected.map(value => value.batchId)).size !== selected.length)
      throw new LaboratoryRefusal('supply', 'Consumable batch IDs must be unique')
    const supplied = new Map<string, number>()
    for (const selection of selected) {
      const batch = state.batches.find(value => value.id === selection.batchId)
      if (!batch || batch.disposition !== 'available' || batch.expiresAt < state.tick)
        throw new LaboratoryRefusal('supply', 'Consumable batch is unavailable')
      const reserved = state.operations.filter(operation => operation.state === 'running' && operation.stage === 'loading')
        .flatMap(operation => operation.command.action === 'process' ? operation.command.consumables ?? [] : [])
        .filter(value => value.batchId === batch.id).reduce((sum, value) => sum + value.units, 0)
      if (batch.units - reserved < selection.units) throw new LaboratoryRefusal('supply', 'Consumable stock is reserved or insufficient')
      supplied.set(batch.kind, (supplied.get(batch.kind) ?? 0) + selection.units)
    }
    if (supplied.size !== required.length || required.some(value => supplied.get(value.kind) !== value.units))
      throw new LaboratoryRefusal('supply', `Total consumables for ${laboratorySampleIds(command).length} input samples must be ${JSON.stringify(required)}; supplied totals are ${JSON.stringify([...supplied].map(([kind, units]) => ({ kind, units })))}. Choose compatible batch IDs and submit the required total units.`)
  }

  /** Validate input without accepting work or advancing time.
   * @param projectId Owning project identity.
   * @param input Command JSON from the provider.
   * @returns Parsed command after admission checks.
   */
  prepare(projectId: string, input: Json | LaboratoryCommand): LaboratoryCommand {
    const command = laboratoryCommandSchema.parse(input)
    this.validate(this.load(), projectId, command)
    return command
  }

  /** Accept idempotent work; conflicting retries and admission refusals leave state untouched.
   * @param id Stable execution operation ID.
   * @param projectId Owning project identity.
   * @param identity Provider operation identity including artifact directory.
   * @param input Command JSON.
   * @returns Accepted or previously accepted operation.
   */
  submit(id: string, projectId: string, identity: string, input: Json | LaboratoryCommand): LaboratoryOperation {
    const command = laboratoryCommandSchema.parse(input)
    return this.update(state => {
      const existing = state.operations.find(operation => operation.id === id)
      if (existing) {
        if (existing.identity !== identity || existing.projectId !== projectId || canonicalJson(json(existing.command)) !== canonicalJson(json(command)))
          throw new LaboratoryRefusal('identity', 'Operation ID already belongs to different work')
        return existing
      }
      this.validate(state, projectId, command)
      if (command.action === 'aliquot' || command.action === 'process') {
        const reserved = new Set(state.samples.map(sample => sample.id))
        for (const operation of state.operations.filter(value => value.state === 'running' && ['aliquot', 'process'].includes(value.command.action)))
          for (const [index] of laboratorySampleIds(operation.command).entries()) reserved.add(laboratoryOutputIds(operation.id, index).sampleId)
        if (laboratorySampleIds(command).some((_sampleId, index) => reserved.has(laboratoryOutputIds(id, index).sampleId)))
          throw new LaboratoryRefusal('identity', 'Output sample ID already exists or is reserved')
      }
      if (command.action === 'order' && (state.batches.some(batch => batch.id === `batch:${id}`) || state.shipments.some(shipment => shipment.id === `batch:${id}`)))
        throw new LaboratoryRefusal('identity', 'Supply order output ID already exists')
      const operation: LaboratoryOperation = { id, projectId, identity, command, state: 'running', stage: 'loading',
        acceptedTick: state.tick, nextTick: state.tick + this.scenario.loadingTicks, consumedUl: 0, consumedWaterUl: 0, consumedBatches: [] }
      state.operations.push(operation)
      this.event(state.tick, 'operation-accepted', json(operation))
      return operation
    })
  }
  /** Persist an admission failure accepted by the execution engine, without physical effects.
   * @param id Stable execution operation ID.
   * @param projectId Owning project identity.
   * @param identity Provider identity including artifact directory.
   * @param input Parsed command JSON.
   * @param refusal Known admission refusal.
   * @returns Durable failed operation or matching prior outcome.
   */
  recordRefusal(id: string, projectId: string, identity: string, input: Json | LaboratoryCommand, refusal: LaboratoryRefusal): LaboratoryOperation {
    const command = laboratoryCommandSchema.parse(input)
    return this.update(state => {
      const existing = state.operations.find(value => value.id === id)
      if (existing) {
        if (existing.identity !== identity || existing.projectId !== projectId || canonicalJson(json(existing.command)) !== canonicalJson(json(command)))
          throw new LaboratoryRefusal('identity', 'Operation ID already belongs to different work')
        return existing
      }
      const operation: LaboratoryOperation = { id, projectId, identity, command, state: 'failed', stage: 'finished',
        acceptedTick: state.tick, nextTick: state.tick, completedTick: state.tick, consumedUl: 0, consumedWaterUl: 0, consumedBatches: [],
        detail: `${refusal.code}: ${refusal.message}` }
      state.operations.push(operation)
      this.event(state.tick, 'operation-refused', json(operation))
      return operation
    })
  }

  /** Bind the physical laboratory to one canonical execution domain.
   * @param directory Canonical execution directory, resolved by the provider.
   */
  bindDomain(directory: string): void {
    this.update(() => {
      const existing = this.db.prepare('SELECT directory FROM domain WHERE id=1').get()
      if (existing) {
        if (z.object({ directory: z.string() }).parse(existing).directory !== directory)
          throw new LaboratoryRefusal('identity', 'Laboratory is already bound to another execution domain')
      } else this.db.prepare('INSERT INTO domain VALUES(1,?)').run(directory)
    })
  }

  private finish(state: LaboratoryState, operation: LaboratoryOperation, failure?: string): void {
    operation.state = failure ? 'failed' : 'succeeded'
    operation.stage = 'finished'
    operation.completedTick = state.tick
    if (failure) operation.detail = failure
    this.event(state.tick, 'operation-finished', json(operation))
  }
  private transition(state: LaboratoryState, operation: LaboratoryOperation): void {
    const command = operation.command, device = deviceOf(state, command.deviceId)
    if (device.broken && command.action !== 'repair' && command.action !== 'configure') { this.finish(state, operation, 'Device fault; inspect retained stage effects'); return }
    if (command.action === 'process' && powerDemand(state) > state.facilities.powerCapacity) {
      this.finish(state, operation, 'Shared power failed; inspect retained stage effects'); return
    }
    const inputs = laboratorySampleIds(command).map(id => sampleOf(state, id))
    const sample = inputs[0]
    if (command.action !== 'transfer' && inputs.some(value => value.disposition !== 'available' || value.expiresAt < state.tick)) {
      this.finish(state, operation, 'Sample became unavailable; consumed volume is retained'); return
    }
    const method = command.action === 'process' ? state.methods.find(value => value.id === command.methodId)! : undefined
    const operatingTemperature = device.temperature ?? state.facilities.ambientTemperature
    if (method?.operatingRange && (operatingTemperature < method.operatingRange.minimumTemperature || operatingTemperature > method.operatingRange.maximumTemperature)) {
      this.finish(state, operation, 'Device temperature left the method operating range; inspect retained effects'); return
    }
    if (method?.requiresCalibration && (device.calibratedUntil ?? -1) < state.tick) {
      this.finish(state, operation, 'Calibration expired during work; consumed volume is retained'); return
    }
    if (operation.stage === 'loading') {
      if (command.action === 'process') {
        if (device.waterPerProcessUl && (!waterAvailable(state) || state.facilities.waterUl < device.waterPerProcessUl)) {
          this.finish(state, operation, 'Water unavailable before processing; no new effects'); return
        }
        if (powerDemand(state) > state.facilities.powerCapacity) {
          this.finish(state, operation, 'Shared power unavailable before processing; no new effects'); return
        }
        for (const selected of command.consumables ?? []) {
          const batch = state.batches.find(value => value.id === selected.batchId)!
          if (batch.disposition !== 'available' || batch.expiresAt < state.tick) {
            this.finish(state, operation, 'Consumable unavailable before processing; no new effects'); return
          }
        }
        state.facilities.waterUl -= device.waterPerProcessUl
        operation.consumedWaterUl = device.waterPerProcessUl
        for (const selected of command.consumables ?? []) {
          state.batches.find(value => value.id === selected.batchId)!.units -= selected.units
          operation.consumedBatches.push({ ...selected })
        }
      }
      if ((command.action === 'aliquot' || command.action === 'process') && sample) {
        for (const input of inputs) input.volumeUl -= command.volumeUl
        operation.consumedUl = command.volumeUl * inputs.length
        if (method?.dirtiesDevice) device.dirty = true
      }
      if (command.action === 'transfer' && sample) sample.location = device.id
      operation.stage = 'processing'
      operation.nextTick = state.tick + (method?.processingTicks ?? (sample ? this.scenario.handlingTicks : this.scenario.maintenanceTicks))
      this.event(state.tick, 'operation-processing', json(operation))
      return
    }
    switch (command.action) {
      case 'aliquot': case 'process': {
        operation.outputSampleIds = []
        operation.resultIds = []
        for (const [index, source] of inputs.entries()) {
          const output = laboratoryOutputIds(operation.id, index)
          const batchIds = [...new Set([...source.batchIds, ...operation.consumedBatches.map(value => value.batchId)])]
          state.samples.push({ ...source, id: output.sampleId, parentId: source.id, location: device.id,
            volumeUl: command.volumeUl, container: command.action === 'aliquot' ? command.container : source.container,
            state: method?.outputState ?? source.state, batchIds })
          operation.outputSampleIds.push(output.sampleId)
          if (method) {
            let root = source
            while (root.parentId) root = sampleOf(state, root.parentId)
            state.results.push({ id: output.resultId, operationId: operation.id, sampleId: source.id, rootSampleId: root.id,
              outputSampleId: output.sampleId, methodId: method.id, methodVersion: method.version, completedTick: state.tick, batchIds,
              ...(device.calibrationId ? { calibrationId: device.calibrationId } : {}) })
            operation.resultIds.push(output.resultId)
          }
        }
        operation.outputSampleId = operation.outputSampleIds[0]!
        if (operation.resultIds.length) operation.resultId = operation.resultIds[0]!

        break
      }
      case 'transfer': {
        const destination = deviceOf(state, command.destination)
        if (destination.broken) { this.finish(state, operation, 'Destination failed; sample retained on transport device'); return }
        sampleOf(state, command.sampleId).location = destination.id
        break
      }
      case 'configure':
        device.enabled = command.enabled
        if (command.targetTemperature !== undefined) device.targetTemperature = command.targetTemperature
        break
      case 'refill':
        if (state.facilities.waterUl + command.volumeUl > state.facilities.waterCapacityUl) { this.finish(state, operation, 'Tank filled before refill completion'); return }
        state.facilities.waterUl += command.volumeUl
        break
      case 'order': {
        const supply = this.scenario.supplyCatalog.find(value => value.kind === command.kind)!
        state.shipments.push({ id: `batch:${operation.id}`, kind: supply.kind, units: supply.unitsPerOrder, arrivesAt: state.tick + supply.deliveryTicks,
          shelfLifeTicks: supply.shelfLifeTicks, delivered: false })
        this.event(state.tick, 'supply-ordered', json(state.shipments.at(-1)))
        break
      }
      case 'clean': device.dirty = false; break
      case 'repair': device.broken = false; device.dirty = true; delete device.calibrationId; delete device.calibratedUntil; break
      case 'calibrate':
        if (device.dirty) { this.finish(state, operation, 'Clean device before calibration'); return }
        device.calibrationId = `calibration:${operation.id}`
        device.calibratedUntil = state.tick + this.scenario.calibrationLifetimeTicks
        break
    }
    this.finish(state, operation)
  }

  /** Commit the next physical event; faults and expiry precede simultaneous completion.
   * @returns New logical tick, or null when no physical events remain.
   */
  advance(): number | null {
    return this.update(state => {
      const stableTick = thermalEvent(state)
      const candidates = [...(stableTick === null ? [] : [stableTick]), ...state.shipments.filter(value => !value.delivered).map(value => value.arrivesAt), ...state.operations.filter(operation => operation.state === 'running').map(operation => operation.nextTick),
        ...this.scenario.revisions.filter(value => !state.appliedRevisions.includes(value.id)).map(value => value.tick),
        ...state.tasks.filter(task => task.releaseTick > state.tick).map(task => task.releaseTick),
        ...this.scenario.faults.filter(fault => !state.appliedFaults.includes(fault.id)).map(fault => fault.tick),
        ...state.samples.filter(sample => sample.disposition === 'available').map(sample => sample.expiresAt + 1)]
      if (!candidates.length) return null
      const nextTick = preservationEvent(state, Math.min(...candidates))
      const conditions = advanceConditions(state, nextTick)
      state.tick = nextTick
      for (const sampleId of conditions.quarantined) this.event(state.tick, 'sample-preservation-failed', { sampleId })
      for (const deviceId of conditions.stableDevices) this.event(state.tick, 'device-temperature-stable', { deviceId })
      for (const warning of conditions.warnings) this.event(state.tick, 'sample-temperature-changed', json(warning))
      for (const shipment of state.shipments.filter(value => !value.delivered && value.arrivesAt === state.tick)) {
        shipment.delivered = true
        state.batches.push({ id: shipment.id, kind: shipment.kind, units: shipment.units, expiresAt: state.tick + shipment.shelfLifeTicks, disposition: 'available' })
        this.event(state.tick, 'supply-arrived', json(shipment))
      }
      for (const fault of this.scenario.faults.filter(value => value.tick === state.tick && !state.appliedFaults.includes(value.id))) {
        deviceOf(state, fault.deviceId).broken = true
        state.appliedFaults.push(fault.id)
        this.event(state.tick, 'device-fault', { deviceId: fault.deviceId })
        for (const operation of state.operations.filter(value => value.state === 'running' && value.command.deviceId === fault.deviceId))
          this.finish(state, operation, 'Device fault; inspect retained stage effects')
      }
      for (const revision of this.scenario.revisions.filter(value => value.tick === state.tick && !state.appliedRevisions.includes(value.id))) {
        state.appliedRevisions.push(revision.id)
        if (revision.kind === 'power') { state.facilities.powerCapacity = revision.capacity; this.event(state.tick, 'power-capacity-changed', { capacity: revision.capacity }) }
        else if (revision.kind === 'recall') this.recall(state, revision.batchId, revision.reason)
        else {
          const method = this.scenario.methods.find(value => value.id === revision.methodId && value.version === revision.version)!
          state.methods = state.methods.filter(value => value.id !== method.id).concat(method)
          for (const task of state.tasks.filter(value => value.methodId === method.id)) task.methodVersion = method.version
          for (const operation of state.operations.filter(value => value.state === 'running' && value.command.action === 'process' && value.command.methodId === method.id))
            this.finish(state, operation, 'Method revised; inspect consumed sample and supplies before retrying')
          this.event(state.tick, 'method-revised', json(method))
        }
      }
      for (const task of state.tasks.filter(value => value.releaseTick === state.tick)) this.event(state.tick, 'task-released', json(task))
      const withdrawn = refreshDeliveries(state)
      if (withdrawn.length) this.event(state.tick, 'deliveries-withdrawn', { taskIds: withdrawn })
      for (const sample of state.samples.filter(value => value.disposition === 'available' && value.expiresAt < state.tick)) {
        sample.disposition = 'quarantined'
        this.event(state.tick, 'sample-expired', { sampleId: sample.id })
      }
      for (const operation of state.operations.filter(value => value.state === 'running' && value.nextTick === state.tick))
        this.transition(state, operation)
      return state.tick
    })
  }

  /** Cancel accepted work while retaining effects already committed by its loading stage.
   * @param id Accepted operation ID.
   * @returns Current operation, including consumed volume.
   */
  cancel(id: string): LaboratoryOperation {
    return this.update(state => {
      const operation = state.operations.find(value => value.id === id)
      if (!operation) throw new LaboratoryRefusal('identity', 'Unknown operation')
      if (operation.state === 'running') {
        operation.state = 'cancelled'; operation.stage = 'finished'; operation.completedTick = state.tick
        this.event(state.tick, 'operation-cancelled', json(operation))
      }
      return operation
    })
  }

  /** Revoke results by exact calibration identity without editing immutable measurement records.
   * @param calibrationId Calibration under review.
   * @param reason Recorded investigation finding.
   * @returns Result IDs newly revoked.
   */
  revokeCalibration(calibrationId: string, reason: string): string[] {
    z.string().min(1).parse(reason)
    return this.update(state => {
      for (const device of state.devices.filter(value => value.calibrationId === calibrationId)) {
        delete device.calibrationId; delete device.calibratedUntil
      }
      const results = state.results.filter(result => result.calibrationId === calibrationId && !state.revocations.some(value => value.resultId === result.id))
      for (const result of results) state.revocations.push({ resultId: result.id, reason, tick: state.tick })
      const withdrawn = refreshDeliveries(state)
      if (withdrawn.length) this.event(state.tick, 'deliveries-withdrawn', { taskIds: withdrawn })
      this.event(state.tick, 'calibration-results-revoked', { calibrationId, reason, resultIds: results.map(result => result.id) })
      return results.map(result => result.id)
    })
  }

  private recall(state: LaboratoryState, batchId: string, reason: string): string[] {
    const batch = state.batches.find(value => value.id === batchId)
    if (!batch) throw new LaboratoryRefusal('supply', 'Unknown consumable batch')
    batch.disposition = 'recalled'
    for (const operation of state.operations.filter(value => value.state === 'running' &&
      (value.command.action === 'process' && (value.command.consumables ?? []).some(item => item.batchId === batchId) ||
      laboratorySampleIds(value.command).some(id => sampleOf(state, id).batchIds.includes(batchId)))))
      this.finish(state, operation, 'Consumable batch recalled; inspect committed sample and supply effects')
    for (const sample of state.samples.filter(value => value.batchIds.includes(batchId))) sample.disposition = 'quarantined'
    const results = state.results.filter(result => result.batchIds.includes(batchId) && !state.revocations.some(value => value.resultId === result.id))
    for (const result of results) state.revocations.push({ resultId: result.id, reason, tick: state.tick })
    this.event(state.tick, 'batch-recalled', { batchId, reason, resultIds: results.map(result => result.id) })
    return results.map(result => result.id)
  }

  /** Recall a supply batch and all descendant measurements; original records remain readable.
   * @param batchId Exact consumable batch identity.
   * @param reason Investigation finding.
   * @returns Newly revoked measurement IDs.
   */
  recallBatch(batchId: string, reason: string): string[] {
    z.string().min(1).parse(reason)
    return this.update(state => {
      const results = this.recall(state, batchId, reason)
      const withdrawn = refreshDeliveries(state)
      if (withdrawn.length) this.event(state.tick, 'deliveries-withdrawn', { taskIds: withdrawn })
      return results
    })
  }

  /** Deliver exact measurement references after current project requirements and dependencies pass.
   * @param projectId Owning project identity.
   * @param taskId Released task ID.
   * @param resultIds Immutable measurement IDs.
   * @param referenceResultIds Actual measurements from prerequisite projects.
   * @returns Persisted delivery, or the existing matching valid delivery.
   */
  deliver(projectId: string, taskId: string, resultIds: string[], referenceResultIds: string[] = []) {
    z.array(z.string().min(1)).parse(resultIds)
    z.array(z.string().min(1)).parse(referenceResultIds)
    return this.update(state => {
      if (state.tasks.find(value => value.id === taskId)?.projectId !== projectId || !deliveryValid(state, taskId, resultIds, referenceResultIds))
        throw new LaboratoryRefusal('task', 'Delivery requires current methods, valid distinct roots and completed prerequisites')
      const existing = state.deliveries.find(value => value.taskId === taskId && value.valid)
      if (existing && canonicalJson([...existing.resultIds].sort()) === canonicalJson([...resultIds].sort()) &&
        canonicalJson([...(existing.referenceResultIds ?? [])].sort()) === canonicalJson([...referenceResultIds].sort())) return existing
      if (existing) existing.valid = false
      const delivery = { taskId, resultIds: [...resultIds], ...(state.externalReferences || referenceResultIds.length ? { referenceResultIds: [...referenceResultIds] } : {}), tick: state.tick, valid: true }
      state.deliveries.push(delivery)
      const withdrawn = refreshDeliveries(state)
      if (withdrawn.length) this.event(state.tick, 'deliveries-withdrawn', { taskIds: withdrawn })
      this.event(state.tick, 'task-delivered', json(delivery))
      return delivery
    })
  }

  /** Read current state; scenario faults are excluded and queries never advance time.
   * @returns Detached device snapshot.
   */
  observe(): LaboratoryState {
    const state = this.load()
    state.tasks = state.tasks.filter(task => task.releaseTick <= state.tick)
    return state
  }

  /** Read the latest committed device-event sequence without loading event payloads.
   * @returns Current event cursor, independent of logical time.
   */
  eventCursor(): number {
    if (this.closed) throw new Error('Laboratory is closed')
    return z.object({ cursor: z.number() }).parse(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS cursor FROM events').get()).cursor
  }

  /** Read accepted work by its stable execution identity.
   * @param id Execution operation ID.
   * @returns Detached physical operation, or undefined for unknown work.
   */
  operation(id: string): LaboratoryOperation | undefined { return this.load().operations.find(value => value.id === id) }

  /** Read ordered committed events.
   * @param after Last observed sequence.
   * @returns Parsed event payloads, excluding future scenario definitions.
   */
  events(after: number) {
    z.number().int().nonnegative().parse(after)
    return this.db.prepare('SELECT seq,tick,kind,payload FROM events WHERE seq>? ORDER BY seq').all(after).map(raw => {
      const row = eventSchema.parse(raw)
      return { ...row, payload: json(JSON.parse(row.payload)) }
    })
  }

  /** Close this connection; accepted device work persists for the owning clock to resume. */
  close(): void { if (!this.closed) { this.db.close(); this.closed = true } }
}
