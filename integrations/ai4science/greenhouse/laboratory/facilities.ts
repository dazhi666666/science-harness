/** Logical facility conditions and cumulative specimen exposure, without host-clock input. */
import { laboratorySampleIds } from './commands.ts'
import type { LaboratoryState } from './schema.ts'
type Device = LaboratoryState['devices'][number]

/** Count powered thermal controls and active device operations once per device.
 * @param state Current device and operation snapshot.
 * @returns Total declared electrical demand.
 */
export function powerDemand(state: LaboratoryState): number {
  return state.devices.filter(device => !device.broken && device.enabled &&
    (device.conditions || state.operations.some(operation => operation.state === 'running' && operation.command.deviceId === device.id)))
    .reduce((sum, device) => sum + device.powerDraw, 0)
}

/** Check the shared water store and every configured water module.
 * @param state Current device snapshot.
 * @returns Whether water-dependent processing may start.
 */
export function waterAvailable(state: LaboratoryState): boolean {
  return state.facilities.waterUl > 0 && state.devices.filter(device => device.kind === 'water-module')
    .every(device => !device.broken && device.enabled && !device.dirty)
}
function temperature(device: Device, powered: boolean, elapsed: number, ambient: number): number {
  const conditions = device.conditions
  if (!conditions) return device.temperature ?? ambient
  const start = device.temperature ?? conditions.initialTemperature
  const controlled = powered && device.enabled && !device.broken
  const target = controlled ? device.targetTemperature ?? conditions.targetTemperature : conditions.ambientTemperature
  const rate = controlled ? conditions.controlPerTick : conditions.driftPerTick
  return start + Math.sign(target - start) * Math.min(Math.abs(target - start), rate * elapsed)
}
function unsafeCount(device: Device, powered: boolean, elapsed: number, minimum: number, maximum: number, ambient: number): number {
  // Temperature is monotone over an event interval. Count the integer observation ticks by binary search.
  const first = (predicate: (value: number) => boolean) => {
    let lower = 1, upper = elapsed + 1
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2)
      if (predicate(temperature(device, powered, middle, ambient))) upper = middle
      else lower = middle + 1
    }
    return lower
  }
  if (temperature(device, powered, elapsed, ambient) >= temperature(device, powered, 0, ambient))
    return first(value => value >= minimum) - 1 + elapsed - first(value => value > maximum) + 1
  return first(value => value <= maximum) - 1 + elapsed - first(value => value < minimum) + 1
}

/** Find when a changing thermal device reaches its target or ambient temperature.
 * @param state Current facility snapshot.
 * @returns Next stable-temperature tick, or null if all temperatures are stable.
 */
export function thermalEvent(state: LaboratoryState): number | null {
  const powered = powerDemand(state) <= state.facilities.powerCapacity
  const candidates = state.devices.flatMap(device => {
    if (!device.conditions) return []
    const controlled = powered && device.enabled && !device.broken
    const target = controlled ? device.targetTemperature ?? device.conditions.targetTemperature : device.conditions.ambientTemperature
    const start = device.temperature ?? device.conditions.initialTemperature
    if (target === start) return []
    const rate = controlled ? device.conditions.controlPerTick : device.conditions.driftPerTick
    return [state.tick + Math.ceil(Math.abs(target - start) / rate)]
  })
  return candidates.length ? Math.min(...candidates) : null
}

/** Find the next cumulative preservation failure within a physical event interval.
 * @param state State at the start of the interval.
 * @param horizonTick Proposed next physical event tick.
 * @returns The earlier exposure-limit event, or the proposed tick.
 */
export function preservationEvent(state: LaboratoryState, horizonTick: number): number {
  const powered = powerDemand(state) <= state.facilities.powerCapacity
  let horizon = horizonTick - state.tick
  for (const sample of state.samples) {
    if (!sample.preservation || sample.disposition !== 'available' || !sample.volumeUl && !state.operations.some(operation => operation.state === 'running' && operation.consumedUl > 0 && laboratorySampleIds(operation.command).includes(sample.id))) continue
    const device = state.devices.find(value => value.id === sample.location)!
    const remaining = sample.preservation.maximumExposureTicks - sample.exposureTicks
    const unsafe = (elapsed: number) => unsafeCount(device, powered, elapsed,
      sample.preservation!.minimumTemperature, sample.preservation!.maximumTemperature, state.facilities.ambientTemperature)
    const initial = temperature(device, powered, 0, state.facilities.ambientTemperature)
    const initiallySafe = initial >= sample.preservation.minimumTemperature && initial <= sample.preservation.maximumTemperature
    const changed = (elapsed: number) => initiallySafe ? unsafe(elapsed) > 0 : unsafe(elapsed) < elapsed
    if (changed(horizon)) {
      let lower = 1, upper = horizon
      while (lower < upper) {
        const middle = Math.floor((lower + upper) / 2)
        if (changed(middle)) upper = middle
        else lower = middle + 1
      }
      horizon = lower
    }
    if (unsafe(horizon) <= remaining) continue
    let lower = 1, upper = horizon
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2)
      if (unsafe(middle) > remaining) upper = middle
      else lower = middle + 1
    }
    horizon = lower
  }
  return state.tick + horizon
}

/** Commit continuous facility evolution over elapsed logical ticks.
 * @param state Mutable snapshot at the beginning of the interval.
 * @param nextTick Strictly later physical event tick.
 * @returns Newly quarantined samples and preservation-condition transitions.
 */
export function advanceConditions(state: LaboratoryState, nextTick: number): { quarantined: string[]; warnings: { sampleId: string; safe: boolean }[]; stableDevices: string[] } {
  const elapsed = nextTick - state.tick
  const powered = powerDemand(state) <= state.facilities.powerCapacity
  if (!powered) state.facilityMetrics.powerOverloadTicks += elapsed
  if (!waterAvailable(state)) state.facilityMetrics.waterUnavailableTicks += elapsed
  const quarantined: string[] = [], warnings: { sampleId: string; safe: boolean }[] = []
  for (const sample of state.samples) {
    if (!sample.preservation || sample.disposition !== 'available' || !sample.volumeUl && !state.operations.some(operation => operation.state === 'running' && operation.consumedUl > 0 && laboratorySampleIds(operation.command).includes(sample.id))) continue
    const device = state.devices.find(value => value.id === sample.location)!
    const unsafe = unsafeCount(device, powered, elapsed, sample.preservation.minimumTemperature, sample.preservation.maximumTemperature, state.facilities.ambientTemperature)
    const initial = temperature(device, powered, 0, state.facilities.ambientTemperature)
    const final = temperature(device, powered, elapsed, state.facilities.ambientTemperature)
    const initiallySafe = initial >= sample.preservation.minimumTemperature && initial <= sample.preservation.maximumTemperature
    const finallySafe = final >= sample.preservation.minimumTemperature && final <= sample.preservation.maximumTemperature
    if (initiallySafe !== finallySafe) warnings.push({ sampleId: sample.id, safe: finallySafe })
    sample.exposureTicks += unsafe
    state.facilityMetrics.unsafeSampleTicks += unsafe
    if (sample.exposureTicks > sample.preservation.maximumExposureTicks) {
      sample.disposition = 'quarantined'
      quarantined.push(sample.id)
    }
  }
  const stableDevices: string[] = []
  for (const device of state.devices) if (device.conditions) {
    const start = temperature(device, powered, 0, state.facilities.ambientTemperature)
    const final = temperature(device, powered, elapsed, state.facilities.ambientTemperature)
    const target = powered && device.enabled && !device.broken ? device.targetTemperature ?? device.conditions.targetTemperature : device.conditions.ambientTemperature
    if (start !== target && final === target) stableDevices.push(device.id)
    device.temperature = final
  }
  return { quarantined, warnings, stableDevices }
}
