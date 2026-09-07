/** Prevent post-report settlement notices from starting another model request in the one-shot study. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
export function installCompletionBoundary(ctx:Context, completed:()=>boolean, owns:(agent:Agent)=>boolean, declined:(agent:Agent,ids:MessageId[])=>void):void {
 ctx.on('agent/pre-step',async({agent,messages},next)=>{
  if(owns(agent)&&completed()) {declined(agent,messages.map(m=>m.id));return{kind:'enter',messages:[]}}
  return next()
 })
}
