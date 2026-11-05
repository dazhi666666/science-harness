/** Read-only measurements distinguish resource intervals, repeated effects and model attempts. */
import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

function python(script: string) {
  const result = spawnSync('python3', ['-c', script], { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8' })
  expect(result.status, result.stdout + result.stderr).toBe(0)
}

it('counts distinct operations and clips running work to the observed tick', () => {
  python(`
from observations import resource_observation
jobs=[{'startedTick':0,'completedTick':4,'resources':['robot','pump']},
      {'startedTick':2,'completedTick':6,'resources':['assay']},
      {'startedTick':5,'completedTick':5,'resources':['robot']}]
r=resource_observation({'tick':8,'jobs':jobs})
assert r['anyOperationBusyTicks']==6 and r['twoOrMoreOperationsBusyTicks']==2
assert r['peakConcurrentOperations']==2 and r['byResource']['robot']['busyTicks']==4
assert r['byResource']['pump']['busyTicks']==4
jobs.append({'startedTick':1,'completedTick':3,'resources':['robot']})
assert resource_observation({'tick':8,'jobs':jobs})['byResource']['robot']['overlappingExclusiveOperationTicks']==2
r=resource_observation({'tick':3,'jobs':[{'startedTick':0,'resources':['robot']},{'startedTick':2,'resources':['assay']}]})
assert r['anyOperationBusyTicks']==3 and r['twoOrMoreOperationsBusyTicks']==1
`)
})

it('separates repeated successful effects, corrected arguments and invalid JSON', () => {
  python(`
from observations import repeat_observation
ops={'a':{'state':'succeeded','input':{'action':'assay','sampleId':'s'}},
     'b':{'state':'succeeded','input':{'action':'assay','sampleId':'s'}},
     'c':{'state':'failed','input':{'action':'assay','sampleId':'s'}},
     'd':{'state':'succeeded','input':{'action':'analyze','taskId':'t'}},
     'e':{'state':'succeeded','input':{'action':'analyze','taskId':'t'}}}
rows=[{'type':'tool/call','data':{'name':'greenhouse_assay','arguments':a}} for a in
      ['{"requestKey":"r","sampleId":"s"}','{"sampleId":"s","requestKey":"r"}',
       '{"requestKey":"r","sampleId":"different"}','{']]
r=repeat_observation(ops,{'actor':rows})
assert r['additionalSameSampleAssays']==1 and r['additionalSameTaskAnalyses']==1
assert r['identicalActionToolCallRepeats']==1 and r['requestKeysUsedWithDifferentArguments']==1
assert r['invalidJsonToolArguments']==1
`)
})
