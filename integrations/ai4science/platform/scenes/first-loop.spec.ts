/** Deterministic application migration check. It does not rate scientific reasoning or run a model. */
import { it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionEngine } from '../execution.ts'
import { createProvider } from '../providers/instrument.ts'
import { Artifacts } from '../artifacts.ts'
import { FirstLoopScenario } from './first-loop.ts'

it('first-loop stages use the public execution store and keep analysis/report policy outside core', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai4s-scene-'))
  const provider = createProvider({
    id: 'instrument',
    directory: join(directory, 'device'),
    resource: 'instrument',
    tickMs: 1,
    reference: 10,
    slope: 0.27,
    drift: 0.012,
    noise: 0.18,
    seed: 3,
  })
  const engine = new ExecutionEngine({
    directory: join(directory, 'domain'),
    providers: [provider],
    pollIntervalMs: 2,
    providerCallTimeoutMs: 1000,
  })
  await engine.open()
  try {
    engine.createProject('p', 40)
    const a = engine.issueContext('p', 'a', ['instrument']),
      b = engine.issueContext('p', 'b', ['instrument']),
      lead = engine.issueContext('p', 'lead', ['instrument'])
    const artifacts = new Artifacts(engine)
    const scene = new FirstLoopScenario(engine, artifacts, 'instrument')
    const first = []
    for (const [ctx, role, key, conditions] of [
      [
        a,
        'midbrain-a',
        'initial-a',
        [
          { value: -1, samples: 2 },
          { value: 1, samples: 2 },
        ],
      ],
      [
        b,
        'midbrain-b',
        'initial-b',
        [
          { value: 1, samples: 2 },
          { value: -1, samples: 2 },
        ],
      ],
    ] as const) {
      const op = await scene.submit(ctx, role, {
        requestKey: key,
        phase: 'initial',
        conditions: [...conditions],
      })
      await engine.wait(ctx, op.id, { timeoutMs: 1000 })
      first.push(op.id)
    }
    const analysis = scene.analyze(lead, {
      operationIds: first,
      method: 'condition-order-regression',
      rationale: 'Deterministic migration check of existing numerical tool',
    })
    const decision = scene.choose(lead, {
      branch: 'A',
      analysisIds: [analysis.id],
      conditions: [
        { value: -1, samples: 2 },
        { value: 1, samples: 2 },
      ],
      rationale: 'Deterministic test payload, not model research evaluation',
    })
    await expect(
      scene.submit(a, 'midbrain-a', {
        requestKey: 'bad',
        phase: 'followup',
        decisionId: decision.id,
        conditions: [{ value: 0, samples: 2 }],
      }),
    ).rejects.toThrow('differs')
    const follow = await scene.submit(a, 'midbrain-a', {
      requestKey: 'follow',
      phase: 'followup',
      decisionId: decision.id,
      conditions: [
        { value: -1, samples: 2 },
        { value: 1, samples: 2 },
      ],
    })
    await engine.wait(a, follow.id, { timeoutMs: 1000 })
    const final = scene.analyze(lead, {
      operationIds: [...first, follow.id],
      method: 'condition-order-regression',
      rationale: 'Verify existing analysis operates on provider outputs',
    })
    expect(() => scene.report(lead, { markdown: 'missing links', sources: [final.id] })).toThrow('link')
    const report = scene.report(lead, {
      markdown: `# Deterministic scenario wiring check\n\n[Analysis](${final.id})\n[Decision](${decision.id})\nNo model or scientific conclusion is evaluated.`,
      sources: [final.id, decision.id],
    })
    expect(artifacts.read(lead, report.id).artifact.sources).toEqual([final.id, decision.id])
    expect(engine.list(lead)).toHaveLength(3)
    const other = engine.issueContext('p', 'no-provider', [])
    expect(() => artifacts.read(other, report.id)).toThrow('inaccessible')
    const source = artifacts.list(lead).find((x) => x.id === analysis.id)!
    expect(source.sources).toHaveLength(2)
  } finally {
    await engine.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
