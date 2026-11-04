/** Persistent synthetic greenhouse state. Reads never advance time or complete operations. */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson, type Json } from '../platform/sdk.ts'
import { chamberSchema, commandSchema, scenarioSchema, stateSchema, type Command, type Job, type Scenario, type State } from './schema.ts'

const chambers = chamberSchema.options
const rowSchema = z.object({ config: z.string(), state: z.string() })
const eventSchema = z.object({ seq: z.number(), tick: z.number(), kind: z.string(), payload: z.string() })

/** A known refusal before any device effects; storage and identity failures use different errors. */
export class GreenhouseActionRejected extends Error {}

/** Resources are held only by accepted running actions; the execution engine also enforces these names. */
export function commandResources(command: Command): string[] {
  switch (command.action) {
    case 'light': return [`greenhouse:light:${command.chamber}`]
    case 'temperature': return [`greenhouse:temperature:${command.chamber}`]
    case 'water': return ['greenhouse:water', `greenhouse:pump:${command.chamber}`]
    case 'sample': case 'inspect': case 'calibrate': return ['greenhouse:robot']
    case 'assay': return ['greenhouse:assay']
    case 'analyze': return ['greenhouse:compute']
  }
}

/** A world may have several readers/providers, but only its clock owns tick advancement. */
export class GreenhouseWorld {
  readonly directory: string
  readonly scenario: Scenario
  readonly scenarioHash: string
  private readonly db: DatabaseSync
  private closed = false

  /** Open or initialize a world, rejecting configuration changes to existing state.
   * @param directory Private device directory, distinct for every comparison run.
   * @param scenario Validated experimental and environmental rules.
   */
  constructor(directory: string, scenario: Scenario) {
    this.directory = resolve(directory)
    this.scenario = scenarioSchema.parse(scenario)
    const config = canonicalJson(z.json().parse(JSON.parse(JSON.stringify(this.scenario))))
    this.scenarioHash = createHash('sha256').update(config).digest('hex')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(join(this.directory, 'greenhouse.sqlite'))
    try {
      const version = z.object({ user_version: z.number() }).parse(this.db.prepare('PRAGMA user_version').get()).user_version
      if (version !== 0 && version !== 1) throw new Error(`Unsupported greenhouse schema ${version}`)
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS world(id INTEGER PRIMARY KEY CHECK(id=1),config TEXT NOT NULL,state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS domain(id INTEGER PRIMARY KEY CHECK(id=1),directory TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,tick INTEGER NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL);
        PRAGMA user_version=1; BEGIN IMMEDIATE;`)
      const existing = this.db.prepare('SELECT config,state FROM world WHERE id=1').get()
      if (existing) {
        const row = rowSchema.parse(existing)
        if (row.config !== config) throw new Error('World configuration changed; use a new comparison directory')
        stateSchema.parse(JSON.parse(row.state))
      } else {
        const initial = this.scenario.initial
        const state: State = {
          tick: 0, chambers: {
            A: { ...initial.chambers.A, sensorBias: 0 }, B: { ...initial.chambers.B, sensorBias: 0 },
            C: { ...initial.chambers.C, sensorBias: 0 },
          }, waterLitres: initial.waterLitres, powerCapacity: initial.powerCapacity,
          tasks: this.scenario.tasks, completedTasks: [], appliedEvents: [], samples: [], assays: [], jobs: [],
          metrics: { temperatureViolationTicks: 0, moistureViolationTicks: 0, powerOverloadTicks: 0 },
        }
        this.db.prepare('INSERT INTO world VALUES(1,?,?)').run(config, JSON.stringify(state))
        this.event(0, 'world-created', { scenarioHash: this.scenarioHash })
      }
      this.db.exec('COMMIT')
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      this.db.close()
      throw error
    }
  }

  private load(): State {
    if (this.closed) throw new Error('World is closed')
    return stateSchema.parse(JSON.parse(rowSchema.parse(this.db.prepare('SELECT config,state FROM world WHERE id=1').get()).state))
  }
  private update<T>(body: (state: State) => T): T {
    if (this.closed) throw new Error('World is closed')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const state = this.load()
      const result = body(state)
      this.db.prepare('UPDATE world SET state=? WHERE id=1').run(JSON.stringify(stateSchema.parse(state)))
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
  private power(state: State): number {
    return chambers.reduce((sum, name) => sum + state.chambers[name].light * this.scenario.physics.powerPerLight, 0)
  }
  private powerRatio(state: State): number {
    const power = this.power(state)
    return power === 0 ? 1 : Math.min(1, state.powerCapacity / power)
  }
  private validateAction(state: State, command: Command): void {
    if (command.action === 'water') {
      if (command.litres > state.waterLitres) throw new GreenhouseActionRejected('Insufficient shared water')
    }
    if (command.action === 'light') {
      const requested = { A: state.chambers.A.light, B: state.chambers.B.light, C: state.chambers.C.light }
      for (const job of state.jobs)
        if (job.state === 'running' && job.command.action === 'light') requested[job.command.chamber] = job.command.level
      requested[command.chamber] = command.level
      const load = Object.values(requested).reduce((sum, level) => sum + level * this.scenario.physics.powerPerLight, 0)
      if (load > state.powerCapacity && load >= this.power(state))
        throw new GreenhouseActionRejected('Shared power capacity exceeded; reduce another chamber load first')
    }
    if (command.action === 'sample') {
      const task = state.tasks.find(task => task.id === command.taskId)
      if (!task || task.chamber !== command.chamber) throw new GreenhouseActionRejected(
        `Sample must belong to an available task in the same chamber. Experiment task IDs: ${state.tasks.filter(value => value.chamber === command.chamber).map(value => value.id).join(', ')}`)
      if (task.requiredLight !== undefined && state.chambers[command.chamber].light * this.powerRatio(state) !== task.requiredLight)
        throw new GreenhouseActionRejected('Task requires its declared effective light level before sampling')
      const releasedAt = this.scenario.events.find(event => event.kind === 'task' && event.task.id === task.id)?.tick ?? 0
      const watered = state.jobs.filter(job => job.state === 'succeeded' && (job.completedTick ?? -1) >= releasedAt && job.command.action === 'water' &&
        job.command.chamber === command.chamber).reduce((sum, job) => sum + (job.command.action === 'water' ? job.command.litres : 0), 0)
      if (task.requiredWaterLitres !== undefined && watered < task.requiredWaterLitres)
        throw new GreenhouseActionRejected('Task requires its declared completed watering before sampling')
    }
    if (command.action === 'assay' && !state.samples.some(sample => sample.id === command.sampleId))
      throw new GreenhouseActionRejected('Assay requires a real completed sample')
    if (command.action === 'analyze') {
      const task = state.tasks.find(task => task.id === command.taskId)
      if (!task) throw new GreenhouseActionRejected(`Unknown task. Use an experiment ID from greenhouse_observe.tasks: ${state.tasks.map(value => value.id).join(', ')}`)
      if (new Set(command.assayIds).size !== command.assayIds.length) throw new GreenhouseActionRejected('Repeated assays cannot count as new evidence')
      const assays = command.assayIds.map(id => {
        const assay = state.assays.find(assay => assay.id === id)
        if (!assay) throw new GreenhouseActionRejected(`Unknown assay: ${id}`)
        return assay
      })
      const own = assays.filter(assay => assay.taskId === task.id)
      if (new Set(own.map(assay => assay.sampleId)).size < task.requiredAssays)
        throw new GreenhouseActionRejected('Task needs more distinct sampled observations')
      const ticks = own.map(assay => assay.sampleTick)
      if (Math.max(...ticks) - Math.min(...ticks) < task.minimumSpacingTicks)
        throw new GreenhouseActionRejected('Task observation spacing is insufficient')
      if (task.referenceTaskId && !assays.some(assay => assay.taskId === task.referenceTaskId))
        throw new GreenhouseActionRejected(`Task requires an assay from ${task.referenceTaskId}`)
      if (assays.some(assay => assay.taskId !== task.id && assay.taskId !== task.referenceTaskId))
        throw new GreenhouseActionRejected('Unrelated assays cannot be assigned to this task')
    }
  }

  /** Validate admission without changing device state.
   * @param input Model/tool command JSON.
   * @returns Validated command; unavailable resources and invalid task evidence are refused.
   */
  prepare(input: Json): Command {
    const command = commandSchema.parse(input), state = this.load(), resources = commandResources(command)
    if (state.jobs.some(job => job.state === 'running' && job.resources.some(resource => resources.includes(resource))))
      throw new GreenhouseActionRejected('Resource busy; wait for the existing operation')
    this.validateAction(state, command)
    return command
  }

  /** Persist a known pre-effect refusal that happened after platform dispatch admission.
   * @param id Stable platform operation identity.
   * @param projectId Issuing project.
   * @param identity Canonical operation identity.
   * @param input Validated command JSON.
   * @param refusal Typed admission failure; unknown/storage failures must never use this path.
   * @returns A terminal failed journal entry with no device start or effects.
   */
  recordRefusal(id: string, projectId: string, identity: string, input: Json, refusal: GreenhouseActionRejected): Job {
    const command = commandSchema.parse(input)
    return this.update(state => {
      const existing = state.jobs.find(job => job.id === id)
      if (existing) {
        if (existing.identity !== identity || existing.projectId !== projectId) throw new Error('Operation identity changed')
        return existing
      }
      const job: Job = { id, projectId, identity, command, resources: commandResources(command), state: 'failed',
        startedTick: state.tick, dueTick: state.tick, completedTick: state.tick, detail: refusal.message }
      state.jobs.push(job)
      this.event(state.tick, 'operation-rejected', { id, detail: refusal.message })
      return job
    })
  }

  /** Accept an idempotent device operation; invalid/busy requests have no effects.
   * @param id Stable platform operation identity.
   * @param projectId Platform project issuing the operation.
   * @param identity Canonical platform input and output-directory identity.
   * @param input Command JSON, validated before admission.
   * @returns Existing or newly accepted journal entry.
   */
  submit(id: string, projectId: string, identity: string, input: Json): Job {
    const command = commandSchema.parse(input)
    return this.update(state => {
      const existing = state.jobs.find(job => job.id === id)
      if (existing) {
        if (existing.identity !== identity || existing.projectId !== projectId || canonicalJson(existing.command) !== canonicalJson(command))
          throw new Error('Operation identity reused with different input or owner')
        return existing
      }
      const resources = commandResources(command)
      if (state.jobs.some(job => job.state === 'running' && job.resources.some(resource => resources.includes(resource))))
        throw new GreenhouseActionRejected('Resource busy; wait for the existing operation')
      this.validateAction(state, command)
      const job: Job = { id, projectId, identity, command, resources, state: 'running', startedTick: state.tick,
        dueTick: state.tick + this.scenario.durations[command.action] }
      state.jobs.push(job)
      this.event(state.tick, 'operation-started', { id, projectId, command, resources })
      return job
    })
  }

  /** Bind accepted operations to one execution-domain root, including after restart.
   * @param directory Canonical parent of platform operation directories.
   */
  bindDomain(directory: string): void {
    this.update(() => {
      const row = this.db.prepare('SELECT directory FROM domain WHERE id=1').get()
      if (row && z.object({ directory: z.string() }).parse(row).directory !== directory)
        throw new Error('Greenhouse belongs to another execution domain')
      if (!row) this.db.prepare('INSERT INTO domain VALUES(1,?)').run(directory)
    })
  }

  /** Read an operation without advancing simulation time.
   * @param id Stable platform operation identity.
   * @returns The journal entry, or undefined when the operation is unknown.
   */
  operation(id: string): Job | undefined { return this.load().jobs.find(job => job.id === id) }

  /** Confirm cancellation of a simulated action whose effects occur only at completion.
   * @param id Stable platform operation identity.
   * @returns Cancelled or already settled operation; unknown IDs fail.
   */
  cancel(id: string): Job {
    return this.update(state => {
      const job = state.jobs.find(job => job.id === id)
      if (!job) throw new Error('Unknown operation')
      if (job.state === 'running') {
        job.state = 'cancelled'
        job.completedTick = state.tick
        this.event(state.tick, 'operation-cancelled', { id })
      }
      return job
    })
  }

  private finish(state: State, job: Job): void {
    const command = job.command
    switch (command.action) {
      case 'light': state.chambers[command.chamber].light = command.level; job.result = command; break
      case 'temperature': state.chambers[command.chamber].targetTemperature = command.target; job.result = command; break
      case 'water': {
        const chamber = state.chambers[command.chamber]
        state.waterLitres -= command.litres
        chamber.moisture = Math.min(100, chamber.moisture + command.litres * this.scenario.physics.moisturePerLitre)
        job.result = { ...command, remainingWaterLitres: state.waterLitres }
        break
      }
      case 'inspect': job.result = { chamber: command.chamber,
        moistureSensor: state.chambers[command.chamber].sensorBias === 0 ? 'healthy' : 'calibration-required',
        referenceMoisture: state.chambers[command.chamber].moisture }; break
      case 'calibrate': state.chambers[command.chamber].sensorBias = 0; job.result = { chamber: command.chamber, calibrated: true }; break
      case 'sample': {
        const chamber = state.chambers[command.chamber]
        const sample = { id: `sample:${job.id}`, taskId: command.taskId, chamber: command.chamber, tick: state.tick,
          temperature: chamber.temperature, moisture: chamber.moisture, light: chamber.light * this.powerRatio(state) }
        state.samples.push(sample)
        job.result = { sampleId: sample.id, taskId: sample.taskId, chamber: sample.chamber, tick: sample.tick }
        break
      }
      case 'assay': {
        const sample = state.samples.find(sample => sample.id === command.sampleId)!
        const assay = { id: `assay:${job.id}`, sampleId: sample.id, taskId: sample.taskId, chamber: sample.chamber,
          sampleTick: sample.tick, temperature: sample.temperature, moisture: sample.moisture, light: sample.light }
        state.assays.push(assay)
        job.result = assay
        break
      }
      case 'analyze': {
        const assays = state.assays.filter(assay => command.assayIds.includes(assay.id))
        const own = assays.filter(assay => assay.taskId === command.taskId)
        job.result = { taskId: command.taskId, assayIds: command.assayIds, observations: own.length,
          meanMoisture: own.reduce((sum, assay) => sum + assay.moisture, 0) / own.length,
          meanTemperature: own.reduce((sum, assay) => sum + assay.temperature, 0) / own.length,
          scientificConclusion: 'not-assessed' }
        if (!state.completedTasks.includes(command.taskId)) state.completedTasks.push(command.taskId)
        break
      }
    }
    job.state = 'succeeded'
    job.completedTick = state.tick
    this.event(state.tick, 'operation-completed', { id: job.id, action: command.action })
  }

  /** Advance exactly one logical tick. Only the owning clock or deterministic tests call this.
   * @returns The new logical tick number.
   */
  step(): number {
    return this.update(state => {
      const range = this.scenario.operatingRange
      const reading = (name: typeof chambers[number], signal: 'temperature' | 'moisture') => signal === 'temperature'
        ? state.chambers[name].temperature : Math.min(100, Math.max(0, state.chambers[name].moisture + state.chambers[name].sensorBias))
      const outside = (value: number, signal: 'temperature' | 'moisture') => signal === 'temperature'
        ? value < range.minimumTemperature || value > range.maximumTemperature
        : value < range.minimumMoisture || value > range.maximumMoisture
      const previous = chambers.flatMap(chamber => (['temperature', 'moisture'] as const)
        .map(signal => ({ chamber, signal, outside: outside(reading(chamber, signal), signal) })))
      state.tick++
      for (const event of this.scenario.events) {
        if (event.tick !== state.tick || state.appliedEvents.includes(event.id)) continue
        state.appliedEvents.push(event.id)
        switch (event.kind) {
          case 'power': state.powerCapacity = event.capacity; break
          case 'sensor': state.chambers[event.chamber].sensorBias = event.bias; break
          case 'task': state.tasks.push(event.task); break
        }
        const notice = event.kind === 'sensor'
          ? { id: event.id, chamber: event.chamber, message: 'Moisture sensor anomaly; inspect before relying on its reading.' }
          : event
        this.event(state.tick, `environment-${event.kind}`, z.json().parse(notice))
      }
      const physics = this.scenario.physics, ratio = this.powerRatio(state)
      for (const name of chambers) {
        const chamber = state.chambers[name]
        chamber.temperature += (physics.ambientTemperature - chamber.temperature) * physics.ambientRelaxation
          + (chamber.targetTemperature - chamber.temperature) * physics.temperatureControl * ratio
          + chamber.light * ratio * physics.lightHeating
        chamber.moisture = Math.max(0, chamber.moisture - physics.moistureLoss - chamber.light * ratio * physics.lightMoistureLoss)
      }
      for (const job of state.jobs) {
        if (job.state !== 'running' || job.dueTick > state.tick) continue
        try { this.validateAction(state, job.command) }
        catch (error) {
          job.state = 'failed'; job.completedTick = state.tick
          job.detail = error instanceof Error ? error.message : String(error)
          this.event(state.tick, 'operation-failed', { id: job.id, detail: job.detail })
          continue
        }
        this.finish(state, job)
      }
      for (const before of previous) {
        const value = reading(before.chamber, before.signal), nowOutside = outside(value, before.signal)
        if (before.outside !== nowOutside) this.event(state.tick, 'environment-range', {
          chamber: before.chamber, signal: before.signal, status: nowOutside ? 'outside' : 'normal', reading: value,
        })
      }
      for (const name of chambers) {
        const chamber = state.chambers[name]
        if (chamber.temperature < range.minimumTemperature || chamber.temperature > range.maximumTemperature)
          state.metrics.temperatureViolationTicks++
        if (chamber.moisture < range.minimumMoisture || chamber.moisture > range.maximumMoisture)
          state.metrics.moistureViolationTicks++
      }
      if (this.power(state) > state.powerCapacity) state.metrics.powerOverloadTicks++
      return state.tick
    })
  }

  /** Advance to the next committed event or virtual review point, without consulting a host clock.
   * @param reviewTicks Virtual review interval when no earlier job or scenario event occurs.
   * @returns The resulting simulation tick.
   */
  advanceToNextEvent(reviewTicks: number): number {
    const state = this.load(), cursor = this.eventCursor()
    const next = Math.min(state.tick + reviewTicks,
      ...state.jobs.filter(job => job.state === 'running').map(job => job.dueTick),
      ...this.scenario.events.filter(event => event.tick > state.tick && !state.appliedEvents.includes(event.id)).map(event => event.tick))
    let tick = state.tick
    while (tick < next) {
      tick = this.step()
      if (this.eventCursor() !== cursor) return tick
    }
    this.update(() => this.event(tick, 'clock-advanced', { fromTick: state.tick, tick }))
    return tick
  }

  /** Agent-visible measurements omit simulator truth and future events.
   * @returns Current sensor readings, available tasks, completed tasks and active actions.
   */
  observe() {
    const state = this.load(), ratio = this.powerRatio(state)
    return { eventCursor: this.eventCursor(), operatingRange: this.scenario.operatingRange, tick: state.tick, simulatedMinutes: state.tick * this.scenario.simulatedMinutesPerTick,
      chambers: chambers.map(name => {
        const chamber = state.chambers[name]
        return { chamber: name, temperature: chamber.temperature,
          moisture: Math.min(100, Math.max(0, chamber.moisture + chamber.sensorBias)),
          lightSetting: chamber.light, effectiveLight: chamber.light * ratio, targetTemperature: chamber.targetTemperature }
      }), powerPerLight: this.scenario.physics.powerPerLight, waterLitres: state.waterLitres, powerCapacity: state.powerCapacity, requestedPower: this.power(state),
      tasks: state.tasks, completedTasks: state.completedTasks,
      activeOperations: state.jobs.filter(job => job.state === 'running').map(job => ({ id: job.id, action: job.command.action,
        resources: job.resources, startedTick: job.startedTick, dueTick: job.dueTick })) }
  }

  /** Read the last committed device event sequence, independent of Session and execution-log sequences.
   * @returns Cursor accepted by device-event waiting, or zero before the first event.
   */
  eventCursor(): number {
    if (this.closed) throw new Error('World is closed')
    return z.object({ cursor: z.number().int().nonnegative() }).parse(
      this.db.prepare('SELECT COALESCE(MAX(seq),0) AS cursor FROM events').get()).cursor
  }

  /** Read newly committed world events; future event definitions and sensor bias are not exposed.
   * @param after Last consumed event sequence.
   * @returns Events after that cursor, in commit order.
   */
  events(after: number) {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Event cursor must be a nonnegative integer')
    if (this.closed) throw new Error('World is closed')
    return this.db.prepare('SELECT seq,tick,kind,payload FROM events WHERE seq>? ORDER BY seq').all(after).map(row => {
      const event = eventSchema.parse(row)
      return { seq: event.seq, tick: event.tick, kind: event.kind, data: z.json().parse(JSON.parse(event.payload)) }
    })
  }

  /** Evaluator-only state. Never register this method as an Agent tool.
   * @returns Complete persisted state for independent execution scoring.
   */
  audit(): State { return this.load() }

  /** Close this connection; does not cancel accepted actions or delete persisted state. */
  close(): void { if (!this.closed) { this.db.close(); this.closed = true } }
}
