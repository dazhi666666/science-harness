/** Shared installer produces equivalent native model policies and snapshots for both laboratory modes. */
import { afterEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it('records the same 256K model, native compression, key pool and runtime sources for Single and Multi', () => {
  const root = mkdtempSync(join(tmpdir(), 'laboratory-install-')); roots.push(root)
  const records = []
  for (const mode of ['single-agent', 'multi-agent']) {
    const directory = join(root, mode), home = join(root, `home-${mode}`)
    const args = ['integrations/ai4science/greenhouse/install-multi.py', '--environment', 'laboratory', '--home', home, '--directory', directory,
      '--mode', mode, '--source', 'real-model', '--base-url', 'https://discovery-api.intern-ai.org.cn/v1', '--seed', '3',
      '--api-key-env', 'TEST_LAB_KEY', '--extra-key-env', 'TEST_LAB_KEY_2', '--extra-key-env', 'TEST_LAB_KEY_3']
    const installed = spawnSync('python3', args, { encoding: 'utf8' })
    expect(installed.status, installed.stderr).toBe(0)
    const profile = JSON.parse(installed.stdout).profile
    const rows = JSON.parse(readFileSync(join(home, 'profiles', profile, 'cordis.patch.yml'), 'utf8'))[0].insert
    const agent = rows.find((row: { id: string }) => row.id === 'laboratory-agents')
    expect(agent.name).toMatch(/laboratory\/agents.ts$/)
    expect(agent.config).toMatchObject({ project: 'joint-laboratory', seed: 3, mode, providerPool: ['intern-greenhouse', 'intern-greenhouse-2', 'intern-greenhouse-3'] })
    expect(agent.config).not.toHaveProperty('scenarioFile')
    expect(rows.find((row: { id: string }) => row.id === 'subagents').config.scienceResultProject).toBe('joint-laboratory')
    expect(rows.find((row: { id: string }) => row.id === 'compaction-basic').config).toMatchObject({ thresholdRatio: 0.8, auto: true })
    const providers = rows.find((row: { id: string }) => row.id === 'llm-pi-ai').config.providers
    expect(Object.values(providers).every(provider => (provider as { models: { contextWindow: number }[] }).models[0]!.contextWindow === 256000)).toBe(true)
    const record = JSON.parse(readFileSync(join(directory, 'installation.json'), 'utf8'))
    const source = readFileSync(join(directory, 'source-snapshot', 'laboratory', 'agents.ts'))
    expect(record.sourceHashes['laboratory/agents.ts']).toBe(createHash('sha256').update(source).digest('hex'))
    records.push(record)
    mkdirSync(join(directory, 'device'), { recursive: true }); writeFileSync(join(directory, 'device', 'laboratory.sqlite'), 'retained-evidence')
    const refused = spawnSync('python3', args, { encoding: 'utf8' })
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('choose a new directory')
  }
  expect(records[0].sourceHashes).toEqual(records[1].sourceHashes)
  expect(records[0].modelPolicy).toEqual(records[1].modelPolicy)
  expect(records[0].clockPolicy).toEqual(records[1].clockPolicy)
})
