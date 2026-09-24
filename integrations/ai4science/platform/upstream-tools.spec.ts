/** Upstream preparation must isolate changes and leave the caller's main branch untouched. */
import { it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

it('binds a read-only upstream and prepares its changes in a separate uncommitted worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'science-upstream-workflow-'))
  const host = join(root, 'host.git'), upstream = join(root, 'source'), consumer = join(root, 'consumer')
  const git = (cwd:string,...args:string[]) => execFileSync('git', args, {cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
  try {
    git(root,'init','--bare','--initial-branch=master',host)
    git(root,'clone',host,upstream)
    git(upstream,'config','user.name','Workflow test');git(upstream,'config','user.email','test@example.invalid')
    writeFileSync(join(upstream,'host.txt'),'baseline\n');git(upstream,'add','.');git(upstream,'commit','-m','baseline');git(upstream,'push','origin','master')
    const baseline=git(upstream,'rev-parse','HEAD')
    git(root,'clone',host,consumer);git(consumer,'switch','-c','main');git(consumer,'config','user.name','Workflow test');git(consumer,'config','user.email','test@example.invalid')
    const scripts=join(consumer,'integrations/ai4science/platform');mkdirSync(scripts,{recursive:true})
    copyFileSync(fileURLToPath(new URL('./upstream.py',import.meta.url)),join(scripts,'upstream.py'))
    writeFileSync(join(consumer,'UPSTREAM.json'),JSON.stringify({upstreamRepository:host,upstreamBranch:'master',upstreamCommit:baseline}))
    git(consumer,'add','.');git(consumer,'commit','-m','consumer');const original=git(consumer,'rev-parse','HEAD')
    writeFileSync(join(upstream,'host.txt'),'updated\n');git(upstream,'add','.');git(upstream,'commit','-m','host update');git(upstream,'push','origin','master')
    const latest=git(upstream,'rev-parse','HEAD')
    const command=(...args:string[])=>JSON.parse(execFileSync('python3',[join(scripts,'upstream.py'),...args],{cwd:consumer,encoding:'utf8'}))
    expect(command('check')).toMatchObject({pinned:baseline,latest,newCommits:1,upstreamPushDisabled:true})
    const worktree=join(root,'integration');const prepared=command('prepare','--directory',worktree)
    expect(prepared.mergeExitCode).toBe(0);expect(prepared.conflicts).toEqual([])
    expect(git(consumer,'rev-parse','HEAD')).toBe(original)
    expect(git(worktree,'rev-parse','MERGE_HEAD')).toBe(latest)
    expect(git(consumer,'remote','get-url','--push','upstream')).toBe('DISABLED')
  } finally { rmSync(root,{recursive:true,force:true}) }
})
