/** Fixed CPU workload; parent IPC loss stops this worker. No model, shell, network or configurable executable. */
import { createHash } from 'node:crypto'
let active = false
process.on('disconnect', () => process.exit(2))
process.on('message', ({ text, iterations, chunkSize }) => {
  if (active) return
  active = true
  let done = 0,
    digest = text
  process.send({ kind: 'started' })
  const chunk = () => {
    const end = Math.min(iterations, done + chunkSize)
    for (; done < end; done++) digest = createHash('sha256').update(digest).digest('hex')
    process.send({ kind: 'checkpoint', done, digest }, (error) => {
      if (error) process.exit(2)
      else if (done === iterations) process.exit(0)
      else setImmediate(chunk)
    })
  }
  chunk()
})
