/** Small execution gates for this one five-agent study, not a workflow compiler. */
import { z } from 'zod'
export const operationsSchema = z.array(z.object({ condition: z.number().min(-1).max(1), count: z.number().int().min(1).max(8) }).strict()).min(1).max(3)
export const decisionSchema = z.object({ branch: z.enum(['A','B']), analysisIds: z.array(z.string()).min(1), operations: operationsSchema, rationale: z.string().min(40), discrimination: z.string().min(20) }).strict()
export function assertDecisionMatches(decision: { branch: string; operations: { condition:number; count:number }[] }, branch: string, operations: { condition:number; count:number }[]) {
  if (decision.branch !== branch || JSON.stringify(decision.operations) !== JSON.stringify(operations)) throw new Error('Follow-up must execute the lead-approved branch, conditions and counts exactly')
}
export interface ReportFacts { participants: number; initialBranches: string[]; researchAnalysisBranches: string[]; exchanges: number; repliesProcessed: number; completedFollowups: number; finalAnalysisCoversFollowup: boolean }
export function missingReportFacts(state: ReportFacts): string[] {
 const missing:string[]=[]
 if(state.participants!==5)missing.push('Exactly five host participants are required')
 for(const b of ['A','B']) {
  if(!state.initialBranches.includes(b))missing.push(`Branch ${b} initial run has not completed`)
  if(!state.researchAnalysisBranches.includes(b))missing.push(`Research ${b} has not saved an analysis`)
 }
 if(state.exchanges<2)missing.push(`Only ${state.exchanges}/2 required initial reference sends are recorded. EACH midbrain must send its OWN completed initial run reference to its peer. A reply does not replace the second reference. Ask the missing worker through its own research parent; the lead/research agents must not impersonate midbrains.`)
 if(state.repliesProcessed<1)missing.push('No correlated peer reply has been processed')
 if(state.completedFollowups<1)missing.push('No lead-approved follow-up run has completed')
 if(!state.finalAnalysisCoversFollowup)missing.push('No saved analysis includes the completed follow-up observations')
 return missing
}
export function assertReportGate(state: ReportFacts) {
 const missing=missingReportFacts(state)
 if(missing.length)throw new Error('Report not ready: '+missing.join('; '))
}
