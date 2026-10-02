import { createServer, request as httpRequest, type Server } from 'node:http'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'
import { createGateway } from '../src/server.ts'
import { GatewayStore } from '../src/store.ts'
import { NETWORK_VERSIONS } from '../../gateway-network/src/versions.ts'
import { serveSurface } from '../../gateway-transport/src/index.ts'
import { NodeSurface } from '../../gateway-node/src/surface.ts'

export async function listen(server: Server, port = 0): Promise<number> {
  server.listen(port, '127.0.0.1'); await once(server, 'listening')
  return (server.address() as { port: number }).port
}
async function availablePort() {
  const s = createServer(); const port = await listen(s)
  await new Promise<void>(resolve => s.close(() => resolve())); return port
}
export async function until(predicate: () => boolean, timeout = 2500) {
  const end = Date.now() + timeout
  while (!predicate()) { if (Date.now() > end) throw new Error('Fixture condition did not settle'); await new Promise(resolve => setTimeout(resolve, 10)) }
}
export interface FixtureNode {
  id: string; label: string; credential: string; clientId: string; inviteToken: string
  socket: WebSocket; carrier: ReturnType<typeof serveSurface>; surface: NodeSurface
  writes: number; cancelled: number; uploads: number; headers: Headers | undefined
  cookie: string; disposeRuntime: () => Promise<void>
}
export async function createFixture(options: { password?: boolean; originSecret?: string; nativeRoot?: string; requestTimeoutMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-qa-'))
  const publicPort = await availablePort()
  const publicUrl = `http://hub.localhost:${publicPort}`
  const nodeOrigin = (id: string) => `http://${id}.hub.localhost:${publicPort}`
  const password = randomBytes(24).toString('base64url')
  await mkdir(join(dir, 'downloads')); await mkdir(join(dir, 'web'))
  await writeFile(join(dir, 'downloads/gateway-node.tgz'), 'fixture-package')
  await writeFile(join(dir, 'install.sh'), '#!/bin/sh\nexit 0\n')
  await writeFile(join(dir, 'web/index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Native carrier fixture</title><style>body{margin:24px;font:16px sans-serif}main{max-width:900px;margin:auto}button{min-height:44px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><main><h1>Native carrier fixture</h1><p id="owner">OWNER</p><button id="request">Read owning Runtime</button><pre id="result"></pre><script>document.querySelector("#request").onclick=async()=>{try{const r=await fetch("/api/identity");document.querySelector("#result").textContent=await r.text()}catch{document.querySelector("#result").textContent="settled failure"}}</script></main></body></html>')
  const statePath = join(dir, 'state.sqlite')
  const old = new GatewayStore(statePath, () => Date.now() - 16 * 60_000)
  const expiredInvite = old.invite('tailcat', 'ws://fixture.invalid', 'Expired').token; old.close()
  const networks = {
    status: async () => ({ tailscale: { installed: true, state: 'ready' as const, mode: 'host' as const }, tailcat: { installed: true, state: 'ready' as const }, versions: NETWORK_VERSIONS }),
    endpoint: () => 'ws://fixture.invalid', loginTailscale: async () => ({}),
  }
  const start = () => createGateway({ publicUrl, statePath, downloadsDirectory: join(dir, 'downloads'), installerPath: join(dir, 'install.sh'),
    networks, nodeOrigin, requestTimeoutMs: options.requestTimeoutMs ?? 1500,
    ...(options.password ? { adminPassword: password } : { authenticateOperator: async (req) => req.headers['x-fixture-operator'] === 'yes' }),
    ...(options.originSecret ? { originSecret: options.originSecret } : {}),
  })
  let gateway = start(); await listen(gateway.publicServer, publicPort)
  let privatePort = await listen(gateway.privateServer)
  const nodes: FixtureNode[] = []
  const request = async (path: string, init: RequestInit & { node?: FixtureNode; operator?: boolean } = {}) => {
    const { node, operator, ...rest } = init
    const headers = new Headers(rest.headers)
    headers.set('host', new URL(node ? nodeOrigin(node.id) : publicUrl).host)
    if (node && !headers.has('cookie')) headers.set('cookie', node.cookie)
    if (operator) headers.set('x-fixture-operator', 'yes')
    if (options.originSecret && !headers.has('x-dsh-origin-secret')) headers.set('x-dsh-origin-secret', options.originSecret)
    return new Promise<Response>((resolve, reject) => {
      const req = httpRequest({ agent: false, hostname: '127.0.0.1', port: publicPort, path, method: rest.method ?? 'GET', headers: Object.fromEntries(headers), signal: rest.signal ?? AbortSignal.timeout(5000) }, res => {
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(key, item)
        resolve(new Response(rest.method === 'HEAD' || [204, 205, 304].includes(res.statusCode!) ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, { status: res.statusCode ?? 502, headers: responseHeaders }))
      })
      req.on('error', reject)
      if (rest.body instanceof ReadableStream) Readable.fromWeb(rest.body as import('node:stream/web').ReadableStream).pipe(req)
      else req.end(rest.body instanceof URLSearchParams ? rest.body.toString() : rest.body)
    })
  }
  const enroll = (input: unknown) => fetch(`http://127.0.0.1:${privatePort}/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(3000) })
  async function connect(node: FixtureNode) {
    const socket = new WebSocket(`ws://127.0.0.1:${privatePort}/connect?nodeId=${node.id}`, { headers: { authorization: `Bearer ${node.credential}`, 'x-dsh-runtime': `runtime-${node.label}` } })
    socket.on('error', () => {})
    await once(socket, 'open'); node.socket = socket
    node.carrier = serveSurface(socket, node.surface)
    await until(() => gateway.peers.has(node.id))
  }
  async function addNode(label: string) {
    const invitation = gateway.store.invite('tailcat', 'ws://fixture.invalid', label)
    const input = { inviteToken: invitation.token, clientId: randomBytes(12).toString('hex'), credential: randomBytes(32).toString('base64url'), name: label, dshVersion: 'fixture', runtimeId: `runtime-${label}` }
    const reply = await enroll(input)
    if (reply.status !== 200) throw new Error('Fixture enrollment failed')
    const { nodeId } = await reply.json() as { nodeId: string }
    const node = { id: nodeId, label, ...input, writes: 0, cancelled: 0, uploads: 0, headers: undefined, cookie: '', disposeRuntime: async () => {} } as unknown as FixtureNode
    const handler = async (req: Request): Promise<Response> => {
      node.headers = req.headers
      const path = new URL(req.url).pathname
      if (path === '/api/identity') return Response.json({ node: label, runtime: input.runtimeId, query: new URL(req.url).search })
      if (path === '/api/fail') throw new Error('Intentional fixture failure')
      if (path === '/api/write') { node.writes++; return Response.json({ writes: node.writes, node: label }) }
      if (path === '/api/hang' || path === '/api/write-hang') {
        if (path === '/api/write-hang') node.writes++
        return new Promise((_resolve, reject) => req.signal.addEventListener('abort', () => { node.cancelled++; reject(req.signal.reason) }, { once: true }))
      }
      if (path === '/api/upload') {
        node.uploads++
        req.signal.addEventListener('abort', () => { node.cancelled++ }, { once: true })
        return new Response(req.body, { headers: { 'content-type': 'application/octet-stream', 'x-runtime-owner': label } })
      }
      if (path === '/api/download') {
        let count = 0
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) { await new Promise(resolve => setTimeout(resolve, 5)); if (!req.signal.aborted) controller.enqueue(new Uint8Array(8192).fill(count++ % 256)) },
          cancel() { node.cancelled++ },
        })
        return new Response(body, { headers: { 'content-type': 'application/octet-stream' } })
      }
      return new Response('Fixture route absent', { status: 404 })
    }
    let connection = { createSharedFetchHandler: () => ({ fetch: handler }) }
    if (options.nativeRoot) {
      const require = createRequire(join(options.nativeRoot, 'package.json'))
      const load = (name: string) => import(pathToFileURL(require.resolve(name)).href)
      const [{ Context }, { HostConnectionService }] = await Promise.all([load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-client-connection')])
      const ctx = new Context(); const native = new HostConnectionService(ctx, [], {})
      for (const path of ['identity', 'fail', 'write', 'hang', 'write-hang', 'upload', 'download']) native.fetch.register({ path: `/api/${path}`, methods: ['GET', 'POST'], requestBody: 'streaming', fetch: handler })
      connection = native; node.disposeRuntime = () => ctx.fiber.dispose()
    }
    node.surface = new NodeSurface({ distIndex: join(dir, 'web/index.html'), renderIndex: html => html.replace('OWNER', label), runtime: {
      connection, clientModules: { fetchBundle: async () => new Response(`export default ${JSON.stringify(label)}`, { headers: { 'content-type': 'text/javascript' } }) },
      typertGateway: { wireStream: {
        open: async (endpoint, _payload, uplink, _peer, signal) => {
          if (endpoint === 'fixture/fail') throw new Error('Fixture native method failed')
          return (async function* () { signal.addEventListener('abort', () => { node.cancelled++ }, { once: true }); for await (const value of uplink) yield { node: label, value } })()
        }, failure: () => ({ code: 'fixture/failure', message: 'Fixture native method failed', details: {} }),
      } },
    } })
    node.cookie = `dsh_gateway_session=${gateway.store.session(node.id)}`
    nodes.push(node); await connect(node); return node
  }
  return {
    get gateway() { return gateway }, get privatePort() { return privatePort }, publicPort, publicUrl, nodeOrigin, password, expiredInvite, dir, nodes,
    expiredTicket(nodeId: string) { const clock = new GatewayStore(statePath, () => Date.now() - 120_000); try { return clock.ticket(nodeId) } finally { clock.close() } },
    request, enroll, addNode, connect,
    async disconnect(node: FixtureNode) { node.carrier.close(); await until(() => !gateway.peers.has(node.id)) },
    async restart() { await gateway.close(); gateway = start(); await listen(gateway.publicServer, publicPort); privatePort = await listen(gateway.privateServer) },
    async close() { await gateway.close(); await Promise.all(nodes.map(node => node.disposeRuntime())); await rm(dir, { recursive: true, force: true }) },
  }
}

/** Raw streaming upload allows cancellation before HTTP upload completion. */
export function uploadRequest(f: Awaited<ReturnType<typeof createFixture>>, node: FixtureNode) {
  const request = httpRequest({ hostname: '127.0.0.1', port: f.publicPort, path: '/api/upload', method: 'POST', headers: { host: new URL(f.nodeOrigin(node.id)).host, origin: f.nodeOrigin(node.id), cookie: node.cookie, 'content-type': 'application/octet-stream' } })
  request.on('error', () => {}); request.on('response', response => response.resume())
  return request
}
