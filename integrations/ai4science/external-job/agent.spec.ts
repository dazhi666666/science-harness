import { HARNESS_BASELINE } from '../platform/version.ts'
/** Native scripted Agent exercises the installed external Provider through existing platform tools. */
import { it, expect, vi } from 'vitest'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import { toolCallResponse, textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { boot, lead, toolValue } from '../platform/organization-fixture.ts'
import { mountPlatform } from '../platform/plugin.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { OperationRecord } from '../platform/sdk.ts'

it('a script Agent submits, waits, reads and concludes through the existing authorized platform path', async () => {
  const module = process.env.AI4S_EXTERNAL_MODULE
  if (!module) throw new Error('Installed external module required')
  const p = await boot('external-installed-agent', true, async (root) => {
    const organization = {
      project: 'cross-branch-project',
      rootRole: 'researcher',
      maxParticipants: 1,
      maxDepth: 0,
      roles: {
        researcher: {
          instructions: 'Deterministic external execution integration',
          model: { provider: 'teams-probe', model: 'script' },
          tools: ['execution_submit', 'execution_wait', 'execution_result', 'org_finish'],
          creates: {},
          maxInstances: 1,
        },
      },
      relations: [],
    }
    await writeFile(join(root, 'org.json'), JSON.stringify(organization))
    await writeFile(
      join(root, 'config.json'),
      JSON.stringify({
        apiVersion: 1,
        enabled: true,
        baseline: HARNESS_BASELINE,
        directory: join(root, 'execution'),
        pollIntervalMs: 10,
        providerCallTimeoutMs: 3000,
        management: { actorId: 'operator', projects: ['cross-branch-project'], allowedProviders: ['job'] },
        providers: [
          {
            module,
            config: {
              id: 'job',
              directory: join(root, 'device'),
              resource: 'cpu',
              chunkSize: 1000,
              pollMs: 20,
              startupTimeoutMs: 3000,
            },
          },
        ],
      }),
    )
    return {
      withoutScience: true,
      modules: {
        platform: {
          name: 'external-agent-composition',
          inject: ['agents', 'subagents', 'tools', 'systemPrompt'],
          async apply(ctx: Context) {
            await mountPlatform(ctx, {
              deploymentFile: join(root, 'config.json'),
              organizationFile: join(root, 'org.json'),
              task: 'Execute a fixed external computation',
              budget: 100000,
              roleProviders: { researcher: ['job'] },
            })
          },
        },
      },
    }
  })
  try {
    const root = await lead(p, 'external-root')
    let complete = false
    p.model.queue(
      'lead',
      toolCallResponse('external-submit', 'execution_submit', {
        provider_id: 'job',
        request_key: 'scripted',
        input_json: '{"text":"seed","iterations":10000}',
      }),
      (options) => {
        const op = toolValue(options, 'external-submit') as OperationRecord
        expect(op.state).toBe('accepted')
        return toolCallResponse('external-wait', 'execution_wait', { operation_id: op.id, timeout_ms: 10000 })
      },
      (options) => {
        const op = toolValue(options, 'external-wait') as OperationRecord
        expect(op.state).toBe('succeeded')
        return toolCallResponse('external-read', 'execution_result', { operation_id: op.id })
      },
      (options) => {
        const result = toolValue(options, 'external-read') as {
          operation: OperationRecord
          artifacts: { content: string }[]
        }
        expect(result.operation.artifacts).toHaveLength(3)
        complete = true
        return toolCallResponse('finish', 'org_finish', {})
      },
      textResponse('External result observed.'),
    )
    root.agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'Execute the deterministic sequence.' }],
        source: { kind: 'user' },
      }),
    )
    await vi.waitFor(() => expect(complete).toBe(true), { timeout: 15000 })
    await vi.waitFor(() => expect(root.agent.status).toBe('idle'))
    const db = new DatabaseSync(join(p.root, 'device/jobs.sqlite'))
    expect(db.prepare("SELECT COUNT(*) n FROM events WHERE kind='worker-started'").get()?.n).toBe(1)
    db.close()
    const metadata = JSON.parse(await readFile(join(p.root, 'config.json'), 'utf8'))
    expect(metadata.providers[0].module).toContain('node_modules')
    p.report.status = 'passed'
    p.report.installedProvider = module
    p.report.realModelRequests = 0
  } finally {
    await p.close()
  }
})
