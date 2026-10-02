import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayTunnel } from '@k1412/dsh-gateway-transport'
import { startNodeConnector, readConnectionConfig, type NodeConnectionConfig } from '../src/connector.ts'
import { NodeSurface } from '../src/surface.ts'

const mocked = vi.hoisted(() => ({ url: '', close: vi.fn(async () => {}), connect: vi.fn() }))
vi.mock('@k1412/dsh-gateway-network', () => ({
  connectNodeNetwork: async (options: unknown) => { mocked.connect(options); return { url: mocked.url, mode: 'tailscale', closed: false, close: mocked.close } },
}))

const disposers: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(disposers.splice(0).reverse().map((dispose) => dispose())); vi.clearAllMocks() })

const config: NodeConnectionConfig = { protocol: 1, nodeId: 'test-node', clientId: 'persistent-client', credential: 'x'.repeat(43),
  name: 'Native test', mode: 'tailscale', endpoint: 'http://100.70.0.1:8081', stateDir: '/tmp/gateway-test', hubUrl: 'https://hub.test' }

describe('paired outbound native connector', () => {
  it('stops retrying when the Hub refuses the persisted identity during the WebSocket handshake', async () => {
    const http = createServer((_request, response) => { response.writeHead(401); response.end('refused') })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    mocked.url = `http://127.0.0.1:${(http.address() as { port: number }).port}`
    disposers.push(async () => { await new Promise<void>((resolve) => http.close(() => resolve())) })
    const statuses: string[] = []
    const connector = startNodeConnector({ config, metadata: { name: 'Native test', runtimeId: 'default', dshVersion: '0.1.7-rc.2', protocol: 1 },
      surface: {} as NodeSurface, onStatus: (event) => { statuses.push(event.state) } })
    disposers.push(() => connector.close())
    await vi.waitFor(() => expect(statuses).toContain('revoked'))
    await connector.close()
    expect(statuses).toEqual(['connecting', 'revoked'])
    expect(mocked.connect).toHaveBeenCalledTimes(1)
  })
  it('authenticates once and carries a native HTTP body without opening a node Web listener', async () => {
    const http = createServer(); const wss = new WebSocketServer({ server: http })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    mocked.url = `http://127.0.0.1:${(http.address() as { port: number }).port}`
    disposers.push(async () => { for (const ws of wss.clients) ws.terminate(); await new Promise<void>((resolve) => wss.close(() => http.close(() => resolve()))) })
    const observed = vi.fn()
    let tunnel: GatewayTunnel | undefined
    wss.on('connection', (ws, request) => { observed(request.url, request.headers); tunnel = new GatewayTunnel(ws) })
    const native = vi.fn(async (request: Request) => new Response(request.body, { headers: { 'content-type': 'application/octet-stream' } }))
    const surface = new NodeSurface({ runtime: { connection: { createSharedFetchHandler: () => ({ fetch: native }) },
      clientModules: { fetchBundle: async () => new Response('unused') }, typertGateway: { wireStream: { open: async (_endpoint, _payload, uplink) => uplink, failure: (error) => ({ code: 'internal', message: String(error), details: {} }) } } },
      distIndex: '/unused/index.html', renderIndex: (html) => html })
    const statuses: string[] = []
    const connector = startNodeConnector({ config, metadata: { name: 'Native test', runtimeId: 'default', dshVersion: '0.1.7-rc.2', protocol: 1 }, surface, onStatus: (event) => { statuses.push(event.state) } })
    disposers.push(() => connector.close())
    await vi.waitFor(() => expect(statuses).toContain('connected'))
    expect(observed.mock.calls[0]![0]).toBe('/connect?nodeId=test-node')
    expect(observed.mock.calls[0]![1].authorization).toBe(`Bearer ${config.credential}`)
    expect(mocked.connect).toHaveBeenCalledWith(expect.objectContaining({ mode: 'tailscale', endpoint: config.endpoint }))
    const bytes = new Uint8Array([0, 128, 255, 0, 11])
    const response = await tunnel!.fetch(new Request('http://native/api/file/upload', { method: 'POST', body: bytes }))
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(native).toHaveBeenCalledTimes(1)
    await connector.close()
    expect(mocked.close).toHaveBeenCalledTimes(1)
  })

  it('requires an owner-only persisted connection file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-identity-'))
    disposers.push(() => rm(directory, { recursive: true, force: true }))
    const file = join(directory, 'connection.json')
    await writeFile(file, JSON.stringify(config), { mode: 0o600 })
    expect(await readConnectionConfig(file)).toEqual(config)
    await chmod(file, 0o644)
    await expect(readConnectionConfig(file)).rejects.toThrow('owner-only')
  })
})
