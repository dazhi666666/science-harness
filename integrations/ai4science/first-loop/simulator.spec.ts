import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SimulatedInstrument, type RunRequest } from './simulator.ts'

const roots: string[] = []
const instruments: SimulatedInstrument[] = []
function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return { requestKey: 'initial-1', branch: 'A', phase: 'initial', operations: [{ condition: -1, count: 3 }, { condition: 1, count: 3 }], ...overrides }
}
async function create(options: { budget?: number; readingDelayMs?: number; seed?: number } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ai4science-instrument-'))
  roots.push(root)
  const instrument = new SimulatedInstrument({ root, seed: 1234, readingDelayMs: 0, ...options })
  instruments.push(instrument)
  await instrument.initialize()
  return { root, instrument }
}
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(instruments.splice(0).map(instrument => instrument.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('single shared simulated instrument execution boundaries', () => {
  it('returns accepted before acquisition and deduplicates lost-response replay without another charge or reading', async () => {
    const { instrument, root } = await create()
    const first = await instrument.submit('midbrain-A', request())
    expect(instrument.queryRun(first.runId!).status).toBe('accepted')
    expect(instrument.readings([first.runId!])).toEqual([])
    expect(instrument.budgetStatus()).toMatchObject({ acquired: 0, reserved: 6, remaining: 90 })
    const replayDuring = await instrument.submit('midbrain-A', request())
    expect(replayDuring).toEqual({ ...first, duplicate: true })
    await instrument.waitRun(first.runId!)
    const values = instrument.readings([first.runId!])
    const replayAfter = await instrument.submit('midbrain-A', request())
    expect(replayAfter).toEqual(replayDuring)
    expect(instrument.readings([first.runId!])).toEqual(values)
    expect(instrument.budgetStatus()).toMatchObject({ acquired: 6, reserved: 0, remaining: 90, activeRunId: null })
    const ledger = readFileSync(path.join(root, 'instrument/events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(ledger.filter(event => event.type === 'accepted')).toHaveLength(1)
    expect(ledger.filter(event => event.type === 'reading-acquired')).toHaveLength(6)
    expect(JSON.parse(readFileSync(path.join(root, `instrument/raw/${first.runId}.json`), 'utf8'))).toEqual(values)
    expect(readFileSync(path.join(root, `instrument/raw/${first.runId}.csv`), 'utf8').trim().split('\n')).toHaveLength(7)
    expect(JSON.parse(readFileSync(path.join(root, 'instrument/budget.json'), 'utf8')).activeRunId).toBeNull()
    await expect(instrument.submit('midbrain-A', request({ operations: [{ condition: 0, count: 3 }] }))).rejects.toThrow('different inputs')
  })

  it('holds one exclusive run, rejects a concurrent owner as busy, then continues global acquisition order', async () => {
    const { instrument, root } = await create()
    const [a, b] = await Promise.all([
      instrument.submit('midbrain-A', request()),
      instrument.submit('midbrain-B', request({ branch: 'B' })),
    ])
    expect(a.status).toBe('accepted')
    expect(b).toEqual({ status: 'busy' })
    await instrument.waitAvailable()
    const next = await instrument.submit('midbrain-B', request({ branch: 'B' }))
    await instrument.waitRun(next.runId!)
    expect(instrument.readings([a.runId!, next.runId!]).map(reading => reading.order)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1))
    const ledger = readFileSync(path.join(root, 'instrument/events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(ledger.findIndex(event => event.type === 'completed' && event.data.runId === a.runId)).toBeLessThan(ledger.findIndex(event => event.type === 'started' && event.data.runId === next.runId))
  })

  it('rejects invalid condition, count, reservation length and unlinked followup before effects', async () => {
    const { instrument } = await create()
    for (const operations of [[{ condition: 1.1, count: 1 }], [{ condition: NaN, count: 1 }], [{ condition: 0, count: 9 }], [{ condition: 0, count: 1.5 }], [], Array.from({ length: 4 }, () => ({ condition: 0, count: 1 }))]) {
      await expect(instrument.submit('midbrain-A', request({ operations }))).rejects.toThrow()
    }
    await expect(instrument.submit('midbrain-A', request({ phase: 'followup' }))).rejects.toThrow('decisionId')
    expect(instrument.listRuns()).toEqual([])
    expect(instrument.budgetStatus()).toMatchObject({ acquired: 0, reserved: 0, remaining: 96 })
  })

  it('reserves the full run and rejects an over-budget run before dispatch', async () => {
    const { instrument } = await create({ budget: 8 })
    const first = await instrument.submit('midbrain-A', request())
    await instrument.waitRun(first.runId!)
    await expect(instrument.submit('midbrain-A', request({ requestKey: 'second' }))).rejects.toThrow('budget exceeded')
    const second = await instrument.submit('midbrain-B', request({ branch: 'B', operations: [{ condition: 0, count: 2 }] }))
    await instrument.waitRun(second.runId!)
    expect(instrument.budgetStatus()).toMatchObject({ acquired: 8, reserved: 0, remaining: 0 })
    expect(instrument.listRuns()).toHaveLength(2)
  })

  it('aborts only the wait and close reconciles acquisition before returning', async () => {
    const { instrument } = await create({ readingDelayMs: 3 })
    const accepted = await instrument.submit('midbrain-A', request())
    const controller = new AbortController()
    const waiting = instrument.waitRun(accepted.runId!, controller.signal)
    controller.abort(new Error('caller stopped waiting'))
    await expect(waiting).rejects.toThrow('caller stopped waiting')
    const closing = instrument.close()
    await expect(instrument.submit('midbrain-B', request())).rejects.toThrow('closing')
    await closing
    expect(instrument.queryRun(accepted.runId!).status).toBe('completed')
    expect(instrument.readings([accepted.runId!])).toHaveLength(6)
  })

  it('retains acquired readings and reservation after publication failure, then refuses new work', async () => {
    vi.useFakeTimers()
    const { instrument, root } = await create({ readingDelayMs: 10 })
    const accepted = await instrument.submit('midbrain-A', request())
    await vi.advanceTimersByTimeAsync(11)
    expect(instrument.readings([accepted.runId!])).toHaveLength(1)
    rmSync(path.join(root, 'instrument/raw'), { recursive: true })
    await vi.runAllTimersAsync()
    await expect(instrument.waitRun(accepted.runId!)).rejects.toThrow('failed')
    expect(instrument.queryRun(accepted.runId!)).toMatchObject({ status: 'failed', acquiredReadings: 2 })
    expect(instrument.budgetStatus()).toMatchObject({ acquired: 2, reserved: 4, remaining: 90, stopped: true, activeRunId: accepted.runId })
    const ledger = readFileSync(path.join(root, 'instrument/events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(ledger.filter(event => event.type === 'reading-acquired')).toHaveLength(2)
    expect(ledger.some(event => event.type === 'completed')).toBe(false)
    expect(JSON.parse(readFileSync(path.join(root, `instrument/runs/${accepted.runId}.json`), 'utf8')).status).toBe('failed')
    await expect(instrument.submit('midbrain-B', request())).rejects.toThrow('stopped')
    await expect(instrument.waitAvailable()).rejects.toThrow('stopped')
  })

  it('refuses both second controller and restart rather than implying supported recovery', async () => {
    const { instrument, root } = await create()
    const second = new SimulatedInstrument({ root })
    await expect(second.initialize()).rejects.toThrow('second controller and recovery are unsupported')
    await instrument.close()
    const restart = new SimulatedInstrument({ root })
    await expect(restart.initialize()).rejects.toThrow('second controller and recovery are unsupported')
  })

  it('reproduces values with the same evaluator seed and sequence without exposing generator parameters in queries', async () => {
    const first = await create({ seed: 9182 })
    const second = await create({ seed: 9182 })
    const a = await first.instrument.submit('midbrain-A', request())
    const b = await second.instrument.submit('midbrain-A', request())
    await Promise.all([first.instrument.waitRun(a.runId!), second.instrument.waitRun(b.runId!)])
    expect(first.instrument.readings([a.runId!]).map(reading => reading.value)).toEqual(second.instrument.readings([b.runId!]).map(reading => reading.value))
    expect(JSON.stringify({ runs: first.instrument.listRuns(), budget: first.instrument.budgetStatus(), readings: first.instrument.readings([a.runId!]) })).not.toMatch(/conditionSlope|driftPerReading|seed|generator/)
    const record = first.instrument.queryRun(a.runId!)
    record.operationIds.length = 0
    expect(first.instrument.queryRun(a.runId!).operationIds).toHaveLength(2)
  })
})
