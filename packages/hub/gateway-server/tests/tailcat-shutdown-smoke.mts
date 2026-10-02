/** Real Tailcat + production connector comparison; isolated state, no production mutations. */
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { GatewayNetworkManager } from '@k1412/dsh-gateway-network'
import { NodeSurface, startNodeConnector } from '@k1412/dsh-gateway-node'
import { createGateway } from '../src/server.ts'

const bins = process.env.DSH_GATEWAY_NETWORK_BIN
if (!bins) throw new Error('Set DSH_GATEWAY_NETWORK_BIN to real Tailcat/Tailscale binaries')
const work = await mkdtemp(join(tmpdir(), 'gateway-shutdown-smoke-'))
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const waitUntil = async (condition: () => boolean, timeout: number) => {
  const deadline = Date.now() + timeout
  while (!condition() && Date.now() < deadline) await pause(50)
  assert(condition(), 'Lifecycle test did not settle before its bounded deadline')
}
const listen = (server: Server, port = 0) => new Promise<number>((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve((server.address() as { port: number }).port) })
})
const results: Array<Record<string, unknown>> = []
for (const order of (process.env.DSH_SHUTDOWN_ORDER ? [process.env.DSH_SHUTDOWN_ORDER] : ['network-first', 'gateway-first'])) {
  assert(['network-first', 'gateway-first'].includes(order))
  const state = join(work, order)
  let privatePort = 0
  let publicPort = 0
  let manager = new GatewayNetworkManager({ stateDirectory: join(state, 'network'), binDirectory: bins })
  const options = { publicUrl: 'http://hub.test', statePath: join(state, 'state.sqlite'), downloadsDirectory: state, installerPath: '/unused',
    networks: { status: () => manager.status(), endpoint: (mode: 'tailscale' | 'tailcat') => manager.endpoint(mode), loginTailscale: () => manager.loginTailscale() },
    authenticateOperator: async () => true }
  let gateway = createGateway(options)
  privatePort = await listen(gateway.privateServer)
  publicPort = await listen(gateway.publicServer)
  const networkOptions = { stateDirectory: join(state, 'network'), binDirectory: bins, privatePort, overlayPort: privatePort, tailscaleMode: 'host' as const }
  manager = new GatewayNetworkManager(networkOptions)
  const statuses: Array<{ state: string; at: number }> = []
  let connector: ReturnType<typeof startNodeConnector> | undefined
  let probeCount = 0
  let generation = 0
  try {
    await manager.start()
    const endpoint = await manager.endpoint('tailcat')
    const invitation = gateway.store.invite('tailcat', endpoint, 'shutdown smoke')
    const credential = randomBytes(32).toString('base64url')
    const clientId = randomUUID()
    const node = gateway.store.enroll({ inviteToken: invitation.token, clientId, credential, name: 'shutdown smoke', dshVersion: 'fixture', runtimeId: 'default' })
    const surface = new NodeSurface({ distIndex: '/unused', renderIndex: html => html, runtime: {
      connection: { createSharedFetchHandler: () => ({ fetch: async () => { probeCount++; return Response.json({ nodeId: node.id, generation, probeCount }) } }) },
      clientModules: { fetchBundle: async () => new Response('unused') },
      typertGateway: { wireStream: { open: async () => { throw new Error('unused') }, failure: error => ({ code: 'test', message: String(error), details: {} }) } },
    } })
    connector = startNodeConnector({ config: { protocol: 1, nodeId: node.id, clientId, credential, name: 'shutdown smoke', mode: 'tailcat', endpoint,
      stateDir: join(state, 'node'), hubUrl: 'http://hub.test', binDirectory: bins }, metadata: { protocol: 1, name: 'shutdown smoke', runtimeId: 'default', dshVersion: 'fixture' },
      surface, onStatus: status => statuses.push({ state: status.state, at: performance.now() }) })
    await waitUntil(() => gateway.peers.has(node.id) && statuses.at(-1)?.state === 'connected', 30_000)
    const initial = await gateway.peers.get(node.id)!.tunnel.fetch(new Request('http://native/api/probe'))
    assert.deepEqual(await initial.json(), { nodeId: node.id, generation: 0, probeCount: 1 })
    const start = performance.now()
    process.stderr.write(`${order}: connected, beginning planned shutdown\n`)
    if (order === 'network-first') { await manager.close(); await gateway.close() }
    else { await gateway.close(); await manager.close() }
    const shutdownMs = performance.now() - start
    gateway = createGateway(options)
    await listen(gateway.privateServer, privatePort); await listen(gateway.publicServer, publicPort)
    manager = new GatewayNetworkManager(networkOptions)
    await manager.start()
    assert.equal(await manager.endpoint('tailcat'), endpoint, 'Hub transport identity must survive its restart')
    generation++
    await waitUntil(() => gateway.peers.has(node.id) && statuses.some(status => status.state === 'connected' && status.at > start), 80_000)
    const recovered = await gateway.peers.get(node.id)!.tunnel.fetch(new Request('http://native/api/probe'))
    assert.deepEqual(await recovered.json(), { nodeId: node.id, generation: 1, probeCount: 2 })
    const result = { order, shutdownMs: Math.round(shutdownMs),
      detectionMs: Math.round((statuses.find(status => status.state === 'disconnected' && status.at > start)?.at ?? NaN) - start),
      recoveryMs: Math.round(performance.now() - start), nodeIdentityPreserved: true, probeCount, businessReplay: false }
    results.push(result)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (order === 'gateway-first') {
      assert(result.detectionMs < 5000, 'Planned shutdown should not wait for the failure heartbeat')
      assert(result.recoveryMs < 25_000, 'Real Tailcat reconnection should settle within the bounded recovery budget')
    }
  } finally {
    await connector?.close()
    await gateway.close()
    await manager.close()
    assert.equal(gateway.peers.size, 0)
    assert.equal(gateway.privateServer.listening, false)
    assert.equal(gateway.publicServer.listening, false)
    await waitUntil(() => !process.getActiveResourcesInfo().includes('ProcessWrap'), 3000)
  }
}
await writeFile(join(work, 'report.json'), JSON.stringify({ realTailcat: true, productionConnector: true, results }, null, 2))
process.stdout.write(`Report: ${join(work, 'report.json')}\n`)
