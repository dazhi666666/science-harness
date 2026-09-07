import { expect,it } from 'vitest'
import { serialModelStreams } from './model-limit.ts'
it('holds the provider slot for the whole stream and skips cancelled queued callers',async()=>{
 const serial=serialModelStreams();const log:string[]=[]
 async function* stream(id:string){log.push('start-'+id);yield id;log.push('end-'+id)}
 const first=serial(undefined,()=>stream('one'))[Symbol.asyncIterator]()
 expect(await first.next()).toEqual({value:'one',done:false})
 const controller=new AbortController()
 const second=serial(controller.signal,()=>stream('two'))[Symbol.asyncIterator]()
 const waiting=second.next();const rejected=expect(waiting).rejects.toThrow('cancelled')
 controller.abort(new Error('cancelled'))
 expect(log).toEqual(['start-one'])
 expect(await first.next()).toEqual({value:undefined,done:true})
 await rejected
 const third=serial(undefined,()=>stream('three'))[Symbol.asyncIterator]()
 expect(await third.next()).toEqual({value:'three',done:false});await third.next()
 expect(log).toEqual(['start-one','end-one','start-three','end-three'])
})
