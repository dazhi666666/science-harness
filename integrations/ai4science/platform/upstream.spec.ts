/** Upgrade evidence uses the host's real adjacent-generation migration and native continuation path. */
import { it, expect, vi } from 'vitest'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { boot, Gate, lead, signal, text } from './organization-fixture.ts'

it('cold-resumes a V2 child through the current host, preserves predecessor bytes and does not restore grants', async () => {
  const p = await boot('upstream-v2-migration')
  const id = SessionId('legacy-science-worker')
  const directory = join(p.root, 'sessions', '_no-cwd', id)
  const source = [
    { type: 'session', version: 2, id, createdAt: 1000, parentSession: 'legacy-science-parent', isSeeded: false, origin: 'subagent', delegationDepth: 1 },
    { type: 'subagent/descriptor', seq: 0, time: 1001, data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'legacy child', agentProvider: 'teams-probe', agentModel: 'script' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n'
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'session.v2.jsonl'), source)
    const parent = await lead(p, 'legacy-science-parent')
    const gate = new Gate(); p.model.queue('legacy-worker', gate.step('Continued after native V2 migration.'))
    await p.ctx.subagents.sendMessage(parent.agent, id, text('ACTOR legacy-worker'), { signal: signal() })
    await vi.waitFor(() => expect(p.model.requests.some(r => r.actor === 'legacy-worker')).toBe(true))
    const child = p.ctx.agents.get(id)!
    expect(child.session.header.parentSession).toBe(parent.agent.id)
    await expect(p.ctx.subagents.scienceResults!.send(child, SessionId('ungranted-peer'), {kind:'reference',resultId:'ungranted-result'}, signal())).rejects.toMatchObject({code:'SCIENCE_NO_GRANT'})
    gate.release()
    await vi.waitFor(() => expect(p.ctx.agents.get(id)).toBeUndefined())
    expect(await readFile(join(directory, 'session.v2.jsonl'), 'utf8')).toBe(source)
    const current = (await readFile(join(directory, 'session.v3.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(current[0]).toMatchObject({ version:3, id, parentSession:parent.agent.id })
    expect(current.some(e => e.type === 'user/message' && e.data.content.some((b:{text?:string}) => b.text === 'ACTOR legacy-worker'))).toBe(true)
    p.report.status='passed';p.report.migration={from:2,to:3,predecessorBytesUnchanged:true,oldGrantsRestored:false}
  } finally { await p.close() }
})
