/** Physical network loss rejects requests without an uncaught synchronous socket error. */
import { afterEach, expect, it, vi } from 'vitest'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { getGlobalDispatcher } from 'undici'
import { boot, type Probe } from '../platform/organization-fixture.ts'
import * as Direct from './direct-transport.ts'

vi.mock('node:os', async original => {
  const actual = await original<typeof import('node:os')>()
  return { ...actual, networkInterfaces: vi.fn(actual.networkInterfaces) }
})
const actualInterfaces = (await vi.importActual<typeof import('node:os')>('node:os')).networkInterfaces
const probes: Probe[] = []
afterEach(async () => {
  try { for (const probe of probes.splice(0)) await probe.close() }
  finally { vi.mocked(networkInterfaces).mockImplementation(actualInterfaces) }
})
const address = (value: string): NetworkInterfaceInfo => ({ address: value, family: 'IPv4',
  netmask: '255.255.255.0', mac: '00:00:00:00:00:00', internal: false, cidr: value + '/24' })

it('contains a real bind failure, refreshes the interface address and restores dispatcher ownership', async () => {
  const p = await boot('greenhouse-interface-change', true, async () => ({ withoutScience: true }))
  probes.push(p)
  const previous = getGlobalDispatcher()
  let accepted = 0
  const server = createServer(socket => { accepted++; socket.destroy() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  p.ctx.effect(() => () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const listener = server.address()
  if (!listener || typeof listener === 'string') throw new Error('Expected an allocated TCP listener')
  const origin = `https://localhost:${listener.port}`
  vi.mocked(networkInterfaces).mockReturnValue({ test: [address('203.0.113.77')] })
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try { await p.ctx.plugin(Direct, { origin, interface: 'test', address: '127.0.0.1' }) }
  finally { log.mockRestore() }
  await expect(fetch(origin)).rejects.toMatchObject({ cause: { code: 'EADDRNOTAVAIL' } })
  vi.mocked(networkInterfaces).mockReturnValue({})
  await expect(fetch(origin)).rejects.toMatchObject({ cause: { code: 'ENETUNREACH' } })
  vi.mocked(networkInterfaces).mockReturnValue({ test: [address('127.0.0.1')] })
  await expect(fetch(origin)).rejects.toThrow()
  expect(accepted).toBe(1)
  await p.close()
  probes.splice(probes.indexOf(p), 1)
  expect(getGlobalDispatcher()).toBe(previous)
})
