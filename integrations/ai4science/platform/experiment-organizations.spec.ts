/** Same domain request through two configured native Agent trees; model scripts derive decisions from real tool feedback. */
import { it, expect, vi } from 'vitest'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { toolCallResponse, textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { boot, lead, execute, toolValue } from './organization-fixture.ts'
import { HARNESS_BASELINE } from './version.ts'
import * as Sampling from './scenes/sampling.ts'

function assignment(options: GenerateOptions): { experimentId: string; notify: string } {
  const marker = options.messages
    .flatMap((m) => m.content)
    .find((b) => b.type === 'text' && /^ACTOR [\w-]+\n/.test(b.text))
  if (marker?.type !== 'text') throw new Error('Missing actual delegated assignment')
  return JSON.parse(marker.text.split('\n').slice(1).join('\n'))
}
for (const shape of ['compact', 'hierarchical'] as const)
  it(`${shape} organization completes the same evidence-backed sampling experiment without changing core or recipe`, async () => {
    const p = await boot(`experiment-${shape}`, true, async (root) => {
      const config = JSON.parse(
        await readFile(new URL(`./examples/sampling.${shape}.organization.json`, import.meta.url), 'utf8'),
      )
      await writeFile(join(root, 'org.json'), JSON.stringify(config))
      await writeFile(
        join(root, 'deployment.json'),
        JSON.stringify({
          apiVersion: 1,
          enabled: true,
          baseline: HARNESS_BASELINE,
          directory: join(root, 'execution'),
          pollIntervalMs: 5,
          providerCallTimeoutMs: 3000,
          management: {
            actorId: 'operator',
            projects: ['cross-branch-project'],
            allowedProviders: ['instrument'],
          },
          providers: [
            {
              module: fileURLToPath(new URL('./providers/instrument.ts', import.meta.url)),
              config: {
                id: 'instrument',
                directory: join(root, 'device'),
                resource: 'instrument',
                tickMs: 1,
                reference: 10,
                slope: 0.27,
                drift: 0.012,
                noise: 0.18,
                seed: 9,
              },
            },
          ],
        }),
      )
      return {
        withoutScience: true,
        modules: {
          sampling: {
            ...Sampling,
            async apply(ctx: Context) {
              await Sampling.apply(ctx, {
                deploymentFile: join(root, 'deployment.json'),
                organizationFile: join(root, 'org.json'),
                task: 'Obtain complete observations through configured participants',
                budget: 100,
                roleProviders: {
                  controller: ['instrument'],
                  worker: ['instrument'],
                  ...(shape === 'hierarchical' ? { manager: ['instrument'] } : {}),
                },
              })
            },
          },
        },
      }
    })
    try {
      const root = await lead(p, `controller-${shape}`)
      const created = await execute(
        p,
        'experiment_create',
        { request_key: 'same-recipe', request_json: JSON.stringify(Sampling.samplingRequest('instrument')) },
        root.agent,
      )
      expect(created.isError).toBe(false)
      const experiment = (created.value as { id: string }).id
      let complete = false
      p.model.queue(
        'worker',
        (options) =>
          toolCallResponse('measure', 'experiment_act', {
            experiment_id: assignment(options).experimentId,
            decision_json: JSON.stringify({
              actionId: 'measure',
              requestKey: 'initial',
              rationale: 'Acquire the approved initial observations.',
            }),
          }),
        (options) =>
          toolCallResponse('wait-initial', 'experiment_wait', {
            experiment_id: assignment(options).experimentId,
            after_seq: 0,
            until: 'decision',
            timeout_ms: 10000,
          }),
        (options) =>
          toolCallResponse('quality-initial', 'sampling_assess', {
            experiment_id: assignment(options).experimentId,
          }),
        (options) => {
          const quality = toolValue(options, 'quality-initial') as { status: string; artifactId: string }
          expect(quality.status).toBe('insufficient')
          return toolCallResponse('supplement', 'experiment_act', {
            experiment_id: assignment(options).experimentId,
            decision_json: JSON.stringify({
              actionId: 'supplement',
              requestKey: 'additional',
              rationale: 'The actual completeness check found four observations below the required six.',
              evidenceArtifactIds: [quality.artifactId],
            }),
          })
        },
        (options) =>
          toolCallResponse('wait-extra', 'experiment_wait', {
            experiment_id: assignment(options).experimentId,
            after_seq: 0,
            until: 'decision',
            timeout_ms: 10000,
          }),
        (options) =>
          toolCallResponse('quality-final', 'sampling_assess', {
            experiment_id: assignment(options).experimentId,
          }),
        (options) => {
          expect(toolValue(options, 'quality-final')).toMatchObject({ status: 'sufficient', observed: 6 })
          complete = true
          return toolCallResponse('notify', 'org_message', {
            target_id: assignment(options).notify,
            text: JSON.stringify({ experimentId: assignment(options).experimentId, ready: true }),
          })
        },
        textResponse('Sampling decision and execution complete.'),
      )
      if (shape === 'hierarchical')
        p.model.queue(
          'manager',
          toolCallResponse('self', 'org_discover', {}),
          (options) => {
            const self = (toolValue(options, 'self') as { id: string; role: string }[]).find(
              (p) => p.role === 'manager',
            )!
            return toolCallResponse('create-worker', 'org_create', {
              role: 'worker',
              task: 'ACTOR worker\n' + JSON.stringify({ ...assignment(options), notify: self.id }),
            })
          },
          textResponse('Worker delegated; awaiting its notice.'),
          (options) =>
            toolCallResponse('forward', 'org_message', {
              target_id: assignment(options).notify,
              text: JSON.stringify({ experimentId: assignment(options).experimentId, ready: true }),
            }),
          textResponse('Controller notified.'),
        )
      const node = await execute(
        p,
        'org_create',
        {
          role: shape === 'compact' ? 'worker' : 'manager',
          task:
            `ACTOR ${shape === 'compact' ? 'worker' : 'manager'}\n` +
            JSON.stringify({ experimentId: experiment, notify: root.agent.id }),
        },
        root.agent,
      )
      expect(node.isError).toBe(false)
      await vi.waitFor(() => expect(complete).toBe(true), { timeout: 15000 })
      await vi.waitFor(
        () =>
          expect(
            root.agent.session
              .snapshotEvents()
              .some(
                (e) =>
                  e.type === 'user/message' &&
                  e.data.content.some((b) => b.type === 'text' && b.text.includes('\"ready\":true')),
              ),
          ).toBe(true),
        { timeout: 15000 },
      )
      const finished = await execute(p, 'sampling_finish', { experiment_id: experiment }, root.agent)
      expect(finished.isError).toBe(false)
      const view = finished.value as {
        state: string
        operations: { id: string; actorId: string }[]
        decisions: { evidenceArtifactIds: string[] }[]
        budgetUsed: number
        completion: { artifactIds: string[] }
      }
      expect(view.state).toBe('completed')
      expect(view.operations).toHaveLength(2)
      expect(view.budgetUsed).toBe(6)
      expect(view.decisions[1]!.evidenceArtifactIds).toHaveLength(1)
      const stored = await p.ctx.sessionPersistence.open(SessionId(view.operations[0]!.actorId), 'read')
      try {
        expect(stored.header.parentSession).toBe(
          shape === 'compact'
            ? root.agent.id
            : (node.value as { participant: { id: string } }).participant.id,
        )
      } finally {
        await stored.close()
      }
      const db = new DatabaseSync(join(p.root, 'device/instrument.sqlite'))
      expect(db.prepare('SELECT COUNT(*) n FROM starts').get()?.n).toBe(2)
      expect(db.prepare('SELECT COUNT(*) n FROM samples').get()?.n).toBe(6)
      db.close()
      const disk = new DatabaseSync(join(p.root, 'execution/execution.sqlite'))
      expect(disk.prepare('SELECT COUNT(*) n FROM experiments').get()?.n).toBe(1)
      disk.close()
      const config = JSON.parse(await readFile(join(p.root, 'org.json'), 'utf8'))
      expect(config.maxDepth).toBe(shape === 'compact' ? 1 : 2)
      const stale = await execute(
        p,
        'experiment_act',
        { experiment_id: experiment, decision_json: '{}' },
        Object.create(root.agent),
      )
      expect(stale.isError).toBe(true)
      p.report.status = 'passed'
      p.report.organization = shape
      p.report.experiment = view
      p.report.modelEvaluation = false
    } finally {
      await p.close()
    }
  })
