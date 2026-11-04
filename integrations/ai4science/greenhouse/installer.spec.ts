/** Installed real-model profiles share credential and compaction policies without embedding credentials. */
import { afterEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

let directory: string | undefined
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }) })

it('installs both modes with the same three routes and an explicitly recorded compression stress policy', () => {
  directory = mkdtempSync(join(tmpdir(), 'greenhouse-install-'))
  const policy = join(directory, 'stress.json')
  writeFileSync(policy, JSON.stringify({ thresholdRatio: 0.02, retainTokens: 512 }))
  const records = []
  for (const mode of ['single-agent', 'multi-agent']) {
    const runtime = join(directory, mode), home = join(directory, 'home')
    const result = spawnSync('python3', [fileURLToPath(new URL('./install-multi.py', import.meta.url)),
      '--mode', mode, '--source', 'real-model', '--home', home, '--directory', runtime,
      '--base-url', 'https://discovery-api.intern-ai.org.cn/v1', '--api-key-env', 'TEST_KEY_ONE',
      '--extra-key-env', 'TEST_KEY_TWO', '--extra-key-env', 'TEST_KEY_THREE', '--compaction-policy', policy,
      '--comparison-file', join(directory, 'pair.json')], { encoding: 'utf8' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    const profile = JSON.parse(result.stdout).profile
    const rows = JSON.parse(readFileSync(join(home, 'profiles', profile, 'cordis.patch.yml'), 'utf8'))[0].insert
    expect(rows.some((row: { id: string }) => row.id === 'llm-retry')).toBe(true)
    const providers = rows.find((row: { id: string }) => row.id === 'llm-pi-ai').config.providers
    expect(Object.values(providers).map(provider => (provider as { apiKeyEnv: string }).apiKeyEnv)).toEqual(['TEST_KEY_ONE', 'TEST_KEY_TWO', 'TEST_KEY_THREE'])
    expect(Object.values(providers).every(provider => (provider as { retryPolicy: { mode: string } }).retryPolicy.mode === 'always')).toBe(true)
    expect(rows.find((row: { id: string }) => row.id === 'greenhouse-agents').config).toMatchObject({ clockMode: 'event-driven', idleReviewTicks: 30 })
    const compaction = rows.find((row: { id: string }) => row.id === 'compaction-basic').config
    expect(compaction).toMatchObject({ auto: true, thresholdRatio: 0.02, retainTokens: 512 })
    expect(compaction).not.toHaveProperty('retainRatio')
    const record = JSON.parse(readFileSync(join(runtime, 'installation.json'), 'utf8'))
    expect(record.sourceHashes['agents.ts']).toMatch(/^[a-f0-9]{64}$/)
    expect(createHash('sha256').update(readFileSync(join(runtime, 'source-snapshot', 'agents.ts'))).digest('hex')).toBe(record.sourceHashes['agents.ts'])
    records.push(record)
  }
  expect(records[0].sourceHashes).toEqual(records[1].sourceHashes)
  expect(records[0].modelPolicy).toEqual(records[1].modelPolicy)
  expect(records[0].clockPolicy).toEqual({ mode: 'event-driven', idleReviewTicks: 30 })
  expect(records[0].clockPolicy).toEqual(records[1].clockPolicy)
})
