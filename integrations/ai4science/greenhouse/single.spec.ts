/** The single-Agent baseline shares actual greenhouse tools and asynchronous capabilities with the native team. */
import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { boot, execute, Gate, type Probe } from '../platform/organization-fixture.ts'
import { mountMultiAgent } from './agents.ts'
import { scenarioSchema } from './schema.ts'
import { createSinglePolicy } from './fixtures/single-policy.ts'

const probes: Probe[] = []
afterEach(async () => { for (const p of probes.splice(0)) await p.close() })
async function setup(label: string, runningPolicy: boolean, clockMode: 'timer' | 'event-driven' = 'timer') {
  const p = await boot(label, true, async () => ({ withoutScience: true })); probes.push(p)
  const scenario = scenarioSchema.parse(JSON.parse(readFileSync(new URL('./fixtures/baseline.scenario.json', import.meta.url), 'utf8')))
  scenario.tickMs = runningPolicy ? 10 : 100000
  const scenarioFile = join(p.root, 'scenario.json'); writeFileSync(scenarioFile, JSON.stringify(scenario))
  if (runningPolicy) {
    const policy = createSinglePolicy()
    p.model.queue('lead', ...Array.from({ length: 250 }, () => policy))
  } else p.model.queue('lead', new Gate().step())
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const run = await mountMultiAgent(p.ctx, { directory: join(p.root, 'run'), scenarioFile, project: 'cross-branch-project',
      port: 0, refreshMs: 100, providerCallTimeoutMs: 1000, mode: 'single-agent', clockMode, source: 'scripted',
      model: { provider: 'teams-probe', model: 'script' } })
    return { p, run }
  } finally { log.mockRestore() }
}

it.each(['timer', 'event-driven'] as const)('completes the identical three experiments with one member under %s and passes evidence verification', async clockMode => {
  const { p, run } = await setup('greenhouse-single-baseline-' + clockMode, true, clockMode)
  await vi.waitFor(() => expect(run.team.snapshot().tasks.map(task => task.status)).toEqual(['done', 'done', 'done']), { timeout: 15000 })
  expect(run.team.snapshot().members.map(member => member.name)).toEqual(['lead'])
  expect(run.team.snapshot().messages).toHaveLength(0)
  expect(run.runtime.world.observe().completedTasks.sort()).toEqual(['light-A', 'reference-C', 'water-B'])
  await p.ctx.sessionPersistence.flush()
  const verified = spawnSync('python3', [fileURLToPath(new URL('./verify.py', import.meta.url)), join(p.root, 'run'),
    '--sessions', join(p.root, 'sessions')], { encoding: 'utf8' })
  expect(verified.status, verified.stdout + verified.stderr).toBe(0)
  expect(JSON.parse(verified.stdout)).toMatchObject({ success: true, mode: 'single-agent', tasks: 3,
    operations: 17, modelSources: ['scripted'], architectureAdvantage: 'not-assessed' })
  const response = await fetch(`${run.runtime.mission.url}/mc/greenhouse`, {
    headers: { Authorization: `Bearer ${run.runtime.mission.token}` },
  })
  expect(await response.json()).toMatchObject({ mode: 'single-agent', experiment: { mode: 'single-agent', source: 'scripted' } })
  const denied = await execute(p, 'org_create', { role: 'chamber-A', task: 'Must not create a second member' }, run.root)
  expect(denied.isError).toBe(true)
  p.report.status = 'passed'
  p.report.scope = 'single-agent-scripted-baseline'
  p.report.verification = JSON.parse(verified.stdout)
  await p.close(); probes.splice(probes.indexOf(p), 1)
  const offline = spawnSync('python3', [fileURLToPath(new URL('./verify.py', import.meta.url)), join(p.root, 'run'),
    '--sessions', join(p.root, 'sessions'), '--offline'], { encoding: 'utf8' })
  expect(offline.status, offline.stdout + offline.stderr).toBe(0)
  const copy = join(p.root, 'clock-invariance-copy')
  cpSync(join(p.root, 'run'), copy, { recursive: true })
  cpSync(join(p.root, 'sessions'), join(copy, 'sessions'), { recursive: true })
  const invariance = spawnSync('python3', ['-c', `
import sys,json,pathlib,sqlite3
sys.path.insert(0,sys.argv[1])
from compare import collect
original=collect(sys.argv[2],offline=True,sessions=sys.argv[3])
copy=pathlib.Path(sys.argv[4])
db=sqlite3.connect(copy/'execution/execution.sqlite')
with db:
 db.execute("UPDATE events SET at='host-clock-is-not-a-reference'")
 db.execute("UPDATE operations SET created_at='host-clock-is-not-a-reference',updated_at='host-clock-is-not-a-reference'")
db.close()
db=sqlite3.connect(copy/'device/greenhouse.sqlite')
with db:
 config=json.loads(db.execute('SELECT config FROM world WHERE id=1').fetchone()[0])
 config['tickMs']=1
 db.execute('UPDATE world SET config=? WHERE id=1',(json.dumps(config),))
db.close()
for file in (copy/'sessions').rglob('session.v4.jsonl'):
 rows=[json.loads(line) for line in file.open()]
 for event in rows:
  if 'time' in event:event['time']=0
 file.write_text(''.join(json.dumps(event)+'\\n' for event in rows))
changed=collect(copy,offline=True)
keys=['verification','taskCompletionTick','taskLatencyTicks','allTaskCompletionTick','perRoute','compactionEvents','actualRequestRetries','sharedToolHash','scenarioHash','observations']
assert all(original[key]==changed[key] for key in keys)
assert original['timeReference']==changed['timeReference']=='simulation-ticks'
assert 'wallClock' not in original and 'wallClock' not in changed
assert original['allTaskCompletionTick'] is not None
print(json.dumps({'clockIndependent':True,'completedTasks':changed['verification']['completedTasks'],'taskLatencyTicks':changed['taskLatencyTicks']}))
`, fileURLToPath(new URL('.', import.meta.url)), join(p.root, 'run'), join(p.root, 'sessions'), copy], { encoding: 'utf8' })
  expect(invariance.status, invariance.stdout + invariance.stderr).toBe(0)
  expect(JSON.parse(invariance.stdout)).toMatchObject({ clockIndependent: true, completedTasks: 3 })
})

it('lets the single Agent submit independent operations concurrently and receives chamber-targeted environment notices itself', async () => {
  const { p, run } = await setup('greenhouse-single-capabilities', false)
  const [watering, lighting] = await Promise.all([
    execute(p, 'greenhouse_water', { chamber: 'B', litres: 2, requestKey: 'single-parallel-water' }, run.root),
    execute(p, 'greenhouse_light', { chamber: 'A', level: 0.7, requestKey: 'single-parallel-light' }, run.root),
  ])
  expect(watering.isError).toBe(false)
  expect(lighting.isError).toBe(false)
  expect(run.runtime.world.audit().jobs.filter(job => job.state === 'running')).toHaveLength(2)
  const event = { seq: 100, tick: 30, kind: 'environment-sensor', data: { chamber: 'B', message: 'Sensor anomaly' } }
  await run.team.notify('lead', [event], new AbortController().signal)
  expect(run.team.snapshot().messages.at(-1)).toMatchObject({ from: 'environment', to: 'lead', delivery: { status: 'accepted' } })
  for (let tick = 0; tick < 3; tick++) run.runtime.world.step()
  expect(run.runtime.world.audit().jobs.every(job => job.state === 'succeeded')).toBe(true)
  const sample = await execute(p, 'greenhouse_sample', { chamber: 'B', taskId: 'water-B', requestKey: 'recoverable-sample' }, run.root)
  if (sample.isError) throw new Error(sample.error.message)
  const sampleId = String((sample.value as { id: string }).id)
  for (let tick = 0; tick < 4; tick++) run.runtime.world.step()
  const assay = await execute(p, 'greenhouse_assay', { sampleId: `sample:${sampleId}`, requestKey: 'recoverable-assay' }, run.root)
  if (assay.isError) throw new Error(assay.error.message)
  for (let tick = 0; tick < 5; tick++) run.runtime.world.step()
  await execute(p, 'greenhouse_result', { operation_id: sampleId }, run.root)
  await execute(p, 'greenhouse_result', { operation_id: String((assay.value as { id: string }).id) }, run.root)
  const before = run.runtime.world.audit()
  const history = await execute(p, 'greenhouse_history', { task_id: 'water-B', chamber: 'B' }, run.root)
  if (history.isError) throw new Error(history.error.message)
  expect(history.value).toMatchObject({ total: 2, operations: expect.arrayContaining([
    expect.objectContaining({ id: sampleId, state: 'succeeded' }),
    expect.objectContaining({ input: { action: 'assay', sampleId: `sample:${sampleId}` } }),
  ]) })
  expect(JSON.stringify(history.value)).not.toContain('sensorBias')
  expect(run.runtime.world.audit()).toEqual(before)
})

it('reports a real model-adapter failure as attention-required without declaring experiment completion', async () => {
  const p = await boot('greenhouse-model-failure', true, async () => ({ withoutScience: true })); probes.push(p)
  const scenarioFile = join(p.root, 'scenario.json')
  writeFileSync(scenarioFile, readFileSync(new URL('./fixtures/baseline.scenario.json', import.meta.url)))
  p.model.queue('lead', () => { throw new Error('Synthetic transport failed for failure-path regression') })
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  let run: Awaited<ReturnType<typeof mountMultiAgent>>
  try { run = await mountMultiAgent(p.ctx, { directory: join(p.root, 'run'), scenarioFile, project: 'cross-branch-project',
    port: 0, refreshMs: 100, providerCallTimeoutMs: 1000, mode: 'single-agent', source: 'scripted',
    model: { provider: 'teams-probe', model: 'script' } }) }
  finally { log.mockRestore() }
  await vi.waitFor(async () => {
    const response = await fetch(`${run!.runtime.mission.url}/mc/greenhouse`, {
      headers: { Authorization: `Bearer ${run!.runtime.mission.token}` },
    })
    expect(await response.json()).toMatchObject({ experiment: { phase: 'attention-required',
      lastFailure: { actorId: run!.root.id, message: expect.stringContaining('Synthetic transport failed') } },
      world: { completedTasks: [] } })
  })
})

it('refuses a changed installed source before creating device state or making a model request', async () => {
  const p = await boot('greenhouse-stale-install', true, async () => ({ withoutScience: true })); probes.push(p)
  const directory = join(p.root, 'run'); mkdirSync(directory)
  const scenarioFile = join(p.root, 'scenario.json')
  writeFileSync(scenarioFile, readFileSync(new URL('./fixtures/baseline.scenario.json', import.meta.url)))
  writeFileSync(join(directory, 'installation.json'), JSON.stringify({ sourceHashes: { 'agents.ts': '0'.repeat(64) } }))
  await expect(mountMultiAgent(p.ctx, { mode: 'single-agent', directory, scenarioFile, project: 'cross-branch-project',
    port: 0, refreshMs: 100, providerCallTimeoutMs: 1000, source: 'scripted', model: { provider: 'teams-probe', model: 'script' } }))
    .rejects.toThrow('source changed after installation')
  expect(existsSync(join(directory, 'device'))).toBe(false)
  expect(p.model.requests).toHaveLength(0)
})
