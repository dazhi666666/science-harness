/** Pair-report policy checks use synthetic evaluator replies; physical evidence is tested in evaluate.spec.ts. */
import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'

function compare(options: { assisted?: boolean, terminal?: boolean, evidenceValid?: boolean, missingAssistancePolicy?: boolean }) {
  const script = `import json,pathlib,sys,tempfile
sys.path.insert(0,'integrations/ai4science/greenhouse/laboratory')
import compare as comparison
options=json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='laboratory-pair-policy-') as temporary:
    paths=[(pathlib.Path(temporary)/name).resolve() for name in ['single','multi']]
    replies={}
    transport={'interface':'en0'}
    record={'sourceHashes':{'agents.ts':'a'*64},'clockPolicy':{'mode':'event-driven'},'transportPolicy':transport,
            'modelPolicy':[{'providers':{'intern':{'models':[{'id':'intern-s2','contextWindow':256000}]}}},{'auto':True,'thresholdRatio':0.8}]}
    for index,path in enumerate(paths):
        path.mkdir()
        for name,value in [('installation.json',record),('scenario.json',{'externalReferences':True}),
                           ('evaluation-protocol.json',{'version':1}),('assistance-protocol.json',{'version':1}),
                           ('network-audit-fixture.json',{'status':'verified','transportPolicy':transport,'connections':[{'interface':'en0'}]})]:
            if name!='assistance-protocol.json' or index==0 or not options.get('missingAssistancePolicy'):
                (path/name).write_text(json.dumps(value))
        assisted=bool(index and options.get('assisted'))
        replies[str(path)]={'mode':['single-agent','multi-agent'][index],'source':'real-model',
            'success':not index,'evidenceValid':options.get('evidenceValid',True),'operatorSubmittedOperations':int(assisted),
            'assistance':{'used':assisted,'interventionCount':int(assisted)},'taskLatencyTicks':{},
            'evaluatorSourceHashes':{'evaluate.py':'b'*64},'completionRate':1 if not index else 0.25,
            'outcome':{'terminal':options.get('terminal',True),'status':'completed' if not index else 'irrecoverable-material-loss','method':'fixture-material-reachability'}}
    comparison.evaluate=lambda path,offline=False:replies[str(path)]
    print(json.dumps(comparison.compare(*paths)))`
  const result = spawnSync('python3', ['-c', script], { input: JSON.stringify(options), encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout)
}

it('accepts an independently verified terminal failure while retaining its incomplete task rate', () => {
  expect(compare({})).toMatchObject({ comparisonReady: true, assistedEvidenceReady: false,
    single: { completionRate: 1 }, multi: { success: false, completionRate: 0.25, outcome: { status: 'irrecoverable-material-loss' } } })
})

it('keeps manual intervention evidence separate and requires the same recorded assistance policy', () => {
  expect(compare({ assisted: true })).toMatchObject({ comparisonReady: false, assistedEvidenceReady: true,
    multi: { assistance: { interventionCount: 1 } }, matchingChecks: { no_operator_actions: false } })
  expect(compare({ assisted: true, missingAssistancePolicy: true })).toMatchObject({ comparisonReady: false, assistedEvidenceReady: false,
    matchingChecks: { identical_assistance_policy: false } })
})

it('rejects unfinished or invalid evidence even when the remaining pairing policies match', () => {
  for (const options of [{ terminal: false }, { evidenceValid: false }])
    expect(compare(options)).toMatchObject({ comparisonReady: false, assistedEvidenceReady: false, matchingChecks: { both_independently_verified: false } })
})
