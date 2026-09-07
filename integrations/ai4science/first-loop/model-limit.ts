/** Serialize complete external model streams, not Agent lifetimes or scientific decisions. */
export function serialModelStreams() {
 let tail=Promise.resolve()
 return async function*<T>(signal:AbortSignal|undefined, next:()=>AsyncIterable<T>):AsyncIterable<T> {
  const previous=tail
  const done=Promise.withResolvers<void>()
  tail=done.promise
  try {await previous;signal?.throwIfAborted();yield* next()}
  finally {done.resolve()}
 }
}
