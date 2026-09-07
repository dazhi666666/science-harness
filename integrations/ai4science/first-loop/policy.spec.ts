import { expect, it } from 'vitest'
import { assertDecisionMatches, assertReportGate, decisionSchema } from './policy.ts'
it('rejects altered follow-up parameters and missing prior-evidence rationale',()=>{
 const d={branch:'A',operations:[{condition:-1,count:8}]}
 expect(()=>assertDecisionMatches(d,'B',d.operations)).toThrow()
 expect(()=>assertDecisionMatches(d,'A',[{condition:1,count:8}])).toThrow()
 expect(()=>decisionSchema.parse({...d,analysisIds:[],rationale:'because',discrimination:''})).toThrow()
 expect(()=>assertDecisionMatches(d,'A',d.operations)).not.toThrow()
})
it('cannot publish a report without actual follow-up observations and a processed exchange',()=>{
 const complete={participants:5,initialBranches:['A','B'],researchAnalysisBranches:['A','B'],exchanges:2,repliesProcessed:1,completedFollowups:1,finalAnalysisCoversFollowup:true}
 expect(()=>assertReportGate(complete)).not.toThrow()
 for(const patch of [{participants:4},{initialBranches:['A']},{researchAnalysisBranches:['B']},{exchanges:0},{repliesProcessed:0},{completedFollowups:0},{finalAnalysisCoversFollowup:false}]) expect(()=>assertReportGate({...complete,...patch})).toThrow()
})
