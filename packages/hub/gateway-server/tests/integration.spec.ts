import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { createFixture, until, uploadRequest, type FixtureNode } from './fixture.ts'

type Fixture = Awaited<ReturnType<typeof createFixture>>
const fixtures: Fixture[] = []
async function setup(options: Parameters<typeof createFixture>[0] = {}) { const f = await createFixture(options); fixtures.push(f); return f }
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.close())) })
function enrollment(n: FixtureNode) { return { inviteToken: n.inviteToken, clientId: n.clientId, credential: n.credential, name: n.label, runtimeId: `runtime-${n.label}` } }
async function rejectedSocket(url: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url, { headers, handshakeTimeout: 1500 })
    socket.on('unexpected-response', (_req, res) => { const status = res.statusCode!; res.resume(); socket.terminate(); resolve(status) })
    socket.on('open', () => { socket.close(); reject(new Error('Unauthorized socket accepted')) })
    socket.on('error', () => {})
  })
}
async function browserSocket(f: Fixture, n: FixtureNode) {
  const socket = new WebSocket(`ws://127.0.0.1:${f.publicPort}/api/remote.mux`, { headers: { host: new URL(f.nodeOrigin(n.id)).host, origin: f.nodeOrigin(n.id), cookie: n.cookie } })
  socket.on('error', () => {}); await once(socket, 'open'); return socket
}

describe('Gateway actual HTTP/ws integration with independent Runtime surfaces', () => {
  it('enforces operator auth, CSRF, private pairing credentials and origin-scoped sessions', async () => {
    const f = await setup(); const [a, b] = await Promise.all([f.addNode('A'), f.addNode('B')])
    expect((await f.request('/api/nodes')).status).toBe(401)
    expect((await f.request('/api/nodes', { operator: true })).status).toBe(200)
    expect((await f.request('/invites', { operator: true, method: 'POST', headers: { origin: 'http://evil.invalid' }, body: 'name=unsafe&mode=tailcat' })).status).toBe(403)
    expect((await f.request('/api/identity', { node: a, headers: { cookie: b.cookie } })).status).toBe(401)
    expect((await f.request('/api/identity', { node: a, headers: { cookie: `dsh_gateway_session=${f.gateway.store.session(a.id, -1)}` } })).status).toBe(401)
    expect((await f.request('/api/write', { node: a, method: 'POST', headers: { origin: f.nodeOrigin(b.id) } })).status).toBe(403)
    expect(a.writes).toBe(0)
    expect(await rejectedSocket(`ws://127.0.0.1:${f.privatePort}/connect?nodeId=${a.id}`, { authorization: `Bearer ${b.credential}`, 'x-dsh-runtime': `runtime-${a.label}` })).toBe(401)
    expect(await rejectedSocket(`ws://127.0.0.1:${f.privatePort}/connect?nodeId=${a.id}`, { authorization: `Bearer ${a.credential}`, 'x-dsh-runtime': `runtime-${b.label}` })).toBe(401)
    expect(await rejectedSocket(`ws://127.0.0.1:${f.publicPort}/api/remote.mux`, { host: new URL(f.nodeOrigin(a.id)).host, origin: f.nodeOrigin(b.id), cookie: a.cookie })).toBe(401)
    const results = await Promise.all([a, b].map(async n => {
      const r = await f.request('/api/identity?sessionId=shared-id', { node: n, headers: { authorization: 'Bearer browser-only', 'cf-access-jwt-assertion': 'browser-only' } })
      expect(r.headers.get('cache-control')).toContain('no-store')
      expect(n.headers?.has('authorization')).toBe(false); expect(n.headers?.has('cookie')).toBe(false); expect(n.headers?.has('cf-access-jwt-assertion')).toBe(false)
      return r.json()
    }))
    expect(results).toEqual([{ node: 'A', runtime: 'runtime-A', query: '?sessionId=shared-id' }, { node: 'B', runtime: 'runtime-B', query: '?sessionId=shared-id' }])
  })

  it('handles password login and proxy secret without exposing either to node surfaces', async () => {
    const f = await setup({ password: true, originSecret: randomBytes(24).toString('hex') })
    expect((await f.request('/', { headers: { 'x-dsh-origin-secret': 'wrong' } })).status).toBe(403)
    expect((await f.request('/')).headers.get('location')).toBe('/login')
    expect((await f.request('/login', { method: 'POST', body: new URLSearchParams({ password: f.password }) })).status).toBe(403)
    expect((await f.request('/login', { method: 'POST', headers: { origin: f.publicUrl }, body: 'password=incorrect' })).status).toBe(401)
    const r = await f.request('/login', { method: 'POST', headers: { origin: f.publicUrl }, body: new URLSearchParams({ password: f.password }) })
    expect(r.status).toBe(303)
    const cookie = r.headers.get('set-cookie')!
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict'); expect(cookie).not.toContain('Domain=')
    expect((await f.request('/api/nodes', { headers: { cookie: cookie.split(';')[0]! } })).status).toBe(200)
    const a = await f.addNode('A'); await (await f.request('/api/identity', { node: a })).text()
    expect(a.headers?.has('x-dsh-origin-secret')).toBe(false)
  })

  it('rejects expired/foreign consumed invites, permits identity retry, consumes entry tickets and revokes a live node', async () => {
    const f = await setup(); const [a, b] = await Promise.all([f.addNode('A'), f.addNode('B')])
    expect((await f.enroll({ ...enrollment(a), inviteToken: f.expiredInvite, clientId: 'expired-client' })).status).toBe(400)
    expect((await f.enroll({ ...enrollment(a), clientId: 'different-client' })).status).toBe(400)
    expect(await (await f.enroll(enrollment(a))).json()).toMatchObject({ nodeId: a.id })
    expect((await f.request(`/api/enrollment/${a.inviteToken}`)).status).toBe(400)
    const entry = await f.request(`/open/${a.id}`, { operator: true })
    const url = new URL(entry.headers.get('location')!)
    const ticketPath = `${url.pathname}${url.search}`
    expect((await f.request(ticketPath, { node: b })).status).toBe(403)
    expect((await f.request(`/_hub/ticket?ticket=${f.expiredTicket(a.id)}`, { node: a })).status).toBe(403)
    const accepted = await f.request(ticketPath, { node: a })
    expect(accepted.status).toBe(303); expect(accepted.headers.get('set-cookie')).not.toContain('Domain=')
    expect((await f.request(ticketPath, { node: a })).status).toBe(403)
    const live = await browserSocket(f, a); const closed = once(live, 'close')
    expect((await f.request(`/nodes/${a.id}/revoke`, { operator: true, method: 'POST', headers: { origin: f.publicUrl } })).status).toBe(303)
    await closed
    expect((await f.request('/api/identity', { node: a })).status).toBe(410)
    expect((await f.enroll(enrollment(a))).status).toBe(400)
    expect(await rejectedSocket(`ws://127.0.0.1:${f.privatePort}/connect?nodeId=${a.id}`, { authorization: `Bearer ${a.credential}` })).toBe(401)
    expect(await (await f.request('/api/identity', { node: b })).json()).toMatchObject({ node: 'B' })
  })

  it('streams exact binary bytes and cancels upload/download while another node remains available', async () => {
    const f = await setup(); const [a, b] = await Promise.all([f.addNode('A'), f.addNode('B')])
    const bytes = randomBytes(768 * 1024 + 19)
    for (const n of [a, b]) {
      let offset = 0
      const body = new ReadableStream<Uint8Array>({ pull(c) { if (offset === bytes.length) c.close(); else { const end = Math.min(offset + 8191, bytes.length); c.enqueue(bytes.subarray(offset, end)); offset = end } } })
      const response = await f.request('/api/upload', { node: n, method: 'POST', headers: { origin: f.nodeOrigin(n.id) }, body, duplex: 'half' } as RequestInit & { node: FixtureNode })
      expect(response.headers.get('x-runtime-owner')).toBe(n.label)
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    }
    const prior = a.cancelled
    const download = await f.request('/api/download', { node: a }); const reader = download.body!.getReader()
    expect((await reader.read()).value?.byteLength).toBeGreaterThan(0); await reader.cancel()
    await until(() => a.cancelled > prior)
    const beforeUpload = a.cancelled; const uploads = a.uploads
    const upload = uploadRequest(f, a); upload.write(randomBytes(32 * 1024))
    await until(() => a.uploads > uploads); upload.destroy()
    await until(() => a.cancelled > beforeUpload)
    expect(await (await f.request('/api/identity', { node: b })).json()).toMatchObject({ node: 'B' })
    await until(() => [...f.gateway.peers.values()].every(p => p.tunnel.health.inflightRequests === 0))
  })

  it('settles native mux failures and keeps simultaneous streams owned by the correct node', async () => {
    const f = await setup(); const [a, b] = await Promise.all([f.addNode('A'), f.addNode('B')])
    const sockets = await Promise.all([a, b].map(n => browserSocket(f, n)))
    try {
      const replies = sockets.map(s => once(s, 'message'))
      for (const s of sockets) { s.send(JSON.stringify({ type: 'open', streamId: 'same-id', endpoint: 'fixture/echo', payload: { unchanged: true } })); s.send(JSON.stringify({ type: 'item', streamId: 'same-id', value: { binary: [0, 255] } })) }
      const frames = await Promise.all(replies)
      expect(frames.map(([bytes]) => JSON.parse(String(bytes)))).toEqual(['A', 'B'].map(node => ({ type: 'item', streamId: 'same-id', value: { node, value: { binary: [0, 255] } } })))
      const failure = once(sockets[0]!, 'message')
      sockets[0]!.send(JSON.stringify({ type: 'open', streamId: 'failure', endpoint: 'fixture/fail', payload: {} }))
      expect(JSON.parse(String((await failure)[0]))).toMatchObject({ type: 'error', streamId: 'failure', error: { code: 'fixture/failure' } })
      const closed = once(sockets[0]!, 'close'); await f.disconnect(a); await closed
      expect(sockets[1]!.readyState).toBe(WebSocket.OPEN)
    } finally { sockets.forEach(s => s.terminate()) }
  })

  it('settles timeout/disconnect and retains pairing/session across reconnect and restart without replaying writes', async () => {
    const f = await setup({ requestTimeoutMs: 200 }); const [a, b] = await Promise.all([f.addNode('A'), f.addNode('B')])
    const timeout = await f.request('/api/hang', { node: a }); expect(timeout.status).toBe(504); await timeout.text()
    const pending = f.request('/api/write-hang', { node: a, method: 'POST', headers: { origin: f.nodeOrigin(a.id) } })
    await until(() => a.writes === 1); await f.disconnect(a)
    expect((await pending).status).toBe(502)
    expect((await f.request('/api/identity', { node: a })).status).toBe(503)
    expect((await f.request('/api/identity', { node: b })).status).toBe(200)
    await f.connect(a)
    expect((await f.request('/api/identity', { node: a })).status).toBe(200)
    const operatorCookie = `dsh_gateway_session=${f.gateway.store.session('operator')}`
    await f.restart(); expect(f.gateway.store.nodes()).toHaveLength(2)
    expect((await f.request('/api/nodes', { headers: { cookie: operatorCookie } })).status).toBe(200)
    expect((await f.request('/api/identity', { node: a })).status).toBe(503)
    await Promise.all([f.connect(a), f.connect(b)])
    for (const node of [a, b]) expect(await (await f.request('/api/identity', { node })).json()).toMatchObject({ node: node.label })
    expect(await (await f.enroll(enrollment(a))).json()).toMatchObject({ nodeId: a.id })
    expect(a.writes).toBe(1); expect(b.writes).toBe(0)
    expect((await f.request('/api/write', { node: a, method: 'POST', headers: { origin: f.nodeOrigin(a.id) } })).status).toBe(200)
    expect(a.writes).toBe(2)
  })

  it('measures bounded repeated parallel page/API traffic with zero routing errors', async () => {
    const f = await setup(); const nodes = await Promise.all([f.addNode('A'), f.addNode('B')])
    const samples: number[] = []; let errors = 0
    const start = performance.now()
    await Promise.all(Array.from({ length: 8 }, async (_, worker) => {
      for (let i = 0; i < 20; i++) {
        const node = nodes[(worker + i) % 2]!; const page = i % 4 === 0; const began = performance.now()
        try { const r = await f.request(page ? '/' : '/api/identity', { node }); expect(r.status).toBe(200); if (page) expect(await r.text()).toContain(`id="owner">${node.label}`); else expect(await r.json()).toMatchObject({ node: node.label }); } catch { errors++ }
        samples.push(performance.now() - began)
      }
    }))
    samples.sort((a, b) => a - b)
    const result = { fixture: 'two NodeSurface runtimes over actual ws and HTTP', requests: samples.length, concurrency: 8, elapsedMs: performance.now() - start, p50Ms: samples[Math.floor(samples.length * .50)], p95Ms: samples[Math.floor(samples.length * .95)], errors, errorRate: errors / samples.length }
    if (process.env.GATEWAY_QA_REPORT_DIR) { await mkdir(process.env.GATEWAY_QA_REPORT_DIR, { recursive: true }); await writeFile(`${process.env.GATEWAY_QA_REPORT_DIR}/server-performance.json`, JSON.stringify(result, null, 2)) }
    expect(errors).toBe(0); expect(result.p95Ms).toBeLessThan(2000); expect(result.elapsedMs).toBeLessThan(15000)
    await until(() => [...f.gateway.peers.values()].every(p => p.tunnel.health.inflightRequests === 0))
  }, 20000)
})

describe.skipIf(!process.env.DSH_NATIVE_ROOT)('published rc.2 native Connection through actual Gateway', () => {
  it('streams published native fetch upload/download for two Runtime instances and cancels cleanly', async () => {
    const f = await setup({ nativeRoot: process.env.DSH_NATIVE_ROOT }); const nodes = await Promise.all([f.addNode('native-A'), f.addNode('native-B')])
    await Promise.all(nodes.map(async node => {
      const bytes = randomBytes(256 * 1024 + 7)
      const response = await f.request('/api/upload', { node, method: 'POST', headers: { origin: f.nodeOrigin(node.id), 'content-type': 'application/octet-stream' }, body: bytes })
      expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
      const before = node.cancelled; const download = await f.request('/api/download', { node }); const reader = download.body!.getReader()
      expect((await reader.read()).value?.byteLength).toBeGreaterThan(0); await reader.cancel(); await until(() => node.cancelled > before)
      const uploads = node.uploads; const cancelled = node.cancelled; const upload = uploadRequest(f, node); upload.write(bytes.subarray(0, 32768))
      await until(() => node.uploads > uploads); upload.destroy(); await until(() => node.cancelled > cancelled)
    }))
  })
})
