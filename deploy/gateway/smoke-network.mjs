#!/usr/bin/env node
/** Real overlay performance and recovery checks; uses no DSH/Hub production state. */
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const flags = new Map()
for (let i = 2; i < process.argv.length; i += 2) flags.set(process.argv[i], process.argv[i + 1])
const selectedMode = flags.get('--mode') ?? 'all'
if (!['all', 'tailcat', 'tailscale'].includes(selectedMode)) throw new Error('--mode must be all, tailcat or tailscale')
function integer(flag, fallback, minimum, maximum) {
  const value = Number(flags.get(flag) ?? fallback)
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${flag}`)
  return value
}
const configuration = {
  requestsPerNode: integer('--requests', 40, 1, 10_000),
  concurrencyPerNode: integer('--concurrency', 4, 1, 64),
  reconnectCycles: integer('--reconnects', 3, 0, 50),
  hubRestartCycles: integer('--hub-restarts', 1, 0, 20),
  payloadBytes: integer('--payload-bytes', 16_384, 1, 4 * 1024 * 1024),
  timeoutMs: integer('--timeout-ms', 15_000, 100, 60_000),
}
const binDirectory = flags.get('--bin-directory') ?? process.env.DSH_GATEWAY_NETWORK_BIN
const tailscaleSocket = flags.get('--tailscale-socket') ?? process.env.DSH_GATEWAY_TAILSCALE_SOCKET
const stateDirectory = await mkdtemp(join(tmpdir(), 'gateway-overlay-smoke-'))
const bundled = join(stateDirectory, 'network.mjs')
const entry = fileURLToPath(new URL('../../packages/hub/gateway-network/src/index.ts', import.meta.url))
await build({ entryPoints: [entry], bundle: true, platform: 'node', target: 'node22', format: 'esm', outfile: bundled })
const { GatewayNetworkManager, connectNodeNetwork, NETWORK_VERSIONS } = await import(pathToFileURL(bundled).href)

const checksum = bytes => createHash('sha256').update(bytes).digest('hex')
const percentile = (samples, fraction) => {
  if (samples.length === 0) return null
  const sorted = samples.toSorted((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] * 100) / 100
}
const report = { schema: 1, time: new Date().toISOString(), versions: NETWORK_VERSIONS,
  scope: 'real-overlay-local-host',
  limitations: [
    'Two isolated node connection identities share one physical test host; this is not a two-machine DSH workflow test.',
    'Tailscale reuses the logged-in host daemon and targets its own Tailnet IP; results do not measure a WAN path.',
    'Latency includes the selected CLI adapter and HTTP exchange; model generation is not measured.',
  ], configuration, modes: {} }

let accepted = 0
const upstream = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/probe') { response.writeHead(404).end(); return }
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > configuration.payloadBytes + 1) { response.writeHead(413).end(); return }
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks)
  accepted++
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ node: request.headers['x-smoke-node'], sequence: request.headers['x-smoke-sequence'],
    sha256: checksum(bytes), bytes: bytes.length, accepted }))
})
await new Promise((done, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', done) })
const privatePort = upstream.address().port
const managerOptions = { stateDirectory: join(stateDirectory, 'hub'), privatePort, overlayPort: privatePort,
  tailscaleMode: 'host', ...(binDirectory ? { binDirectory } : {}), ...(tailscaleSocket ? { tailscaleSocket } : {}) }
let manager = new GatewayNetworkManager(managerOptions)
const openTunnels = new Set()
let failed = false
try {
  await manager.start()
  for (const mode of selectedMode === 'all' ? ['tailcat', 'tailscale'] : [selectedMode]) {
    const statistics = { topology: mode === 'tailcat' ? 'two-clients-one-host-real-tailcat' : 'host-self-tailnet-via-tailscale-nc',
      attempts: 0, successes: 0, failures: 0, failureRate: 0, p50Ms: null, p95Ms: null,
      successfulNodeReconnects: 0, expectedNodeReconnects: configuration.reconnectCycles * 2,
      successfulHubRestarts: 0, expectedHubRestarts: configuration.hubRestartCycles,
      connectP50Ms: null, connectP95Ms: null, recoveryP50Ms: null, recoveryP95Ms: null,
      probeServerStatePreserved: false, status: 'starting' }
    report.modes[mode] = statistics
    const samples = []
    const steadySamples = []
    const coldSamples = []
    const connectSamples = []
    const recoverySamples = []
    const tunnels = [undefined, undefined]
    let sequence = 0
    const payloads = [Buffer.alloc(configuration.payloadBytes, 65), Buffer.alloc(configuration.payloadBytes, 66)]
    const closeNodes = async () => {
      await Promise.all(tunnels.map(async (tunnel, index) => {
        if (tunnel) { openTunnels.delete(tunnel); await tunnel.close() }
        tunnels[index] = undefined
      }))
    }
    const connectNode = async index => {
      const start = performance.now()
      const endpoint = await manager.endpoint(mode)
      const tunnel = await connectNodeNetwork({ mode, endpoint, stateDirectory: join(stateDirectory, `node-${mode}-${index}`),
        ...(binDirectory ? { binDirectory } : {}), ...(tailscaleSocket ? { tailscaleSocket } : {}), allowManagedTailscale: false })
      connectSamples.push(performance.now() - start)
      tunnels[index] = tunnel
      openTunnels.add(tunnel)
    }
    const probe = async (index, phase = 'steady') => {
      const current = String(++sequence)
      const start = performance.now()
      statistics.attempts++
      try {
        const response = await fetch(`${tunnels[index].url}/probe`, { method: 'POST', body: payloads[index],
          headers: { 'x-smoke-node': String(index), 'x-smoke-sequence': current }, signal: AbortSignal.timeout(configuration.timeoutMs) })
        if (!response.ok) throw new Error('probe-http')
        const result = await response.json()
        if (result.node !== String(index) || result.sequence !== current || result.sha256 !== checksum(payloads[index]) ||
          result.bytes !== configuration.payloadBytes) throw new Error('probe-corruption')
        statistics.successes++
        samples.push(performance.now() - start)
        if (phase === 'steady') steadySamples.push(performance.now() - start)
        if (phase === 'cold') coldSamples.push(performance.now() - start)
        return true
      } catch { statistics.failures++; return false }
    }
    try {
      const deadline = Date.now() + 30_000
      do {
        const status = await manager.status()
        if (status[mode].state === 'ready') break
        if (mode === 'tailscale' || status[mode].state === 'unavailable') throw new Error(`${mode}-not-ready`)
        await new Promise(done => setTimeout(done, 250))
      } while (Date.now() < deadline)
      await Promise.all([connectNode(0), connectNode(1)])
      const baseline = accepted
      const cold = await Promise.all([probe(0, 'cold'), probe(1, 'cold')])
      statistics.successfulInitialHandshakes = cold.filter(Boolean).length
      if (!cold.every(Boolean)) throw new Error('initial-handshake-failed')
      await Promise.all([0, 1].map(async index => {
        let next = 0
        await Promise.all(Array.from({ length: configuration.concurrencyPerNode }, async () => {
          while (next++ < configuration.requestsPerNode) await probe(index)
        }))
      }))
      for (let cycle = 0; cycle < configuration.reconnectCycles; cycle++) {
        const start = performance.now()
        await closeNodes()
        await Promise.all([connectNode(0), connectNode(1)])
        const results = await Promise.all([probe(0, 'recovery'), probe(1, 'recovery')])
        statistics.successfulNodeReconnects += results.filter(Boolean).length
        if (results.every(Boolean)) recoverySamples.push(performance.now() - start)
      }
      for (let cycle = 0; cycle < configuration.hubRestartCycles; cycle++) {
        const start = performance.now()
        await closeNodes()
        await manager.close()
        manager = new GatewayNetworkManager(managerOptions)
        await manager.start()
        const deadline = Date.now() + 30_000
        while ((await manager.status())[mode].state !== 'ready') {
          if (Date.now() > deadline) throw new Error('hub-recovery-timeout')
          await new Promise(done => setTimeout(done, 250))
        }
        await Promise.all([connectNode(0), connectNode(1)])
        const results = await Promise.all([probe(0, 'recovery'), probe(1, 'recovery')])
        if (results.every(Boolean)) { statistics.successfulHubRestarts++; recoverySamples.push(performance.now() - start) }
      }
      statistics.probeServerStatePreserved = accepted >= baseline + statistics.successes
      statistics.status = statistics.failures === 0 && statistics.successfulNodeReconnects === statistics.expectedNodeReconnects &&
        statistics.successfulHubRestarts === statistics.expectedHubRestarts && statistics.probeServerStatePreserved ? 'passed' : 'failed'
    } catch (error) {
      statistics.status = 'failed'
      statistics.setupError = error.message.includes('Tailscale') || error.message === 'tailscale-not-ready'
        ? 'The existing host Tailscale daemon is not ready; no login or configuration was changed.'
        : 'Overlay initialization or recovery failed; no other network path was tried.'
    } finally {
      await closeNodes()
      statistics.failureRate = statistics.attempts === 0 ? null : statistics.failures / statistics.attempts
      statistics.p50Ms = percentile(samples, 0.5)
      statistics.p95Ms = percentile(samples, 0.95)
      statistics.steadyP50Ms = percentile(steadySamples, 0.5)
      statistics.steadyP95Ms = percentile(steadySamples, 0.95)
      statistics.initialHandshakeP50Ms = percentile(coldSamples, 0.5)
      statistics.initialHandshakeP95Ms = percentile(coldSamples, 0.95)
      statistics.connectP50Ms = percentile(connectSamples, 0.5)
      statistics.connectP95Ms = percentile(connectSamples, 0.95)
      statistics.recoveryP50Ms = percentile(recoverySamples, 0.5)
      statistics.recoveryP95Ms = percentile(recoverySamples, 0.95)
      if (statistics.status !== 'passed') failed = true
      process.stderr.write(`${mode}: ${statistics.status}, ${statistics.successes}/${statistics.attempts} requests, p95 ${statistics.p95Ms} ms\n`)
    }
  }
} finally {
  await Promise.all([...openTunnels].map(tunnel => tunnel.close()))
  await manager.close()
  upstream.closeAllConnections()
  await new Promise(done => upstream.close(done))
  await rm(stateDirectory, { recursive: true, force: true })
}
const destination = flags.get('--report')
if (destination) { const path = resolve(destination); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(report, null, 2) + '\n') }
process.stdout.write(JSON.stringify(report, null, 2) + '\n')
if (failed) process.exitCode = 1
