import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { type Socket } from 'node:net'
import { chromium } from 'playwright'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { createFixture, until, type FixtureNode } from './fixture.ts'

type Fixture = Awaited<ReturnType<typeof createFixture>>
const fixtures: Fixture[] = []
const sockets: (WebSocket | Socket)[] = []
afterEach(async () => {
  sockets.splice(0).forEach(socket => socket instanceof WebSocket ? socket.terminate() : socket.destroy())
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
})

async function setup() {
  const fixture = await createFixture(); fixtures.push(fixture)
  const nodes = await Promise.all([fixture.addNode('A'), fixture.addNode('B')])
  return { fixture, nodes }
}
function browserHeaders(fixture: Fixture, node: FixtureNode) {
  return { host: new URL(fixture.nodeOrigin(node.id)).host, origin: fixture.nodeOrigin(node.id), cookie: node.cookie }
}
async function browserSocket(fixture: Fixture, node: FixtureNode) {
  const socket = new WebSocket(`ws://127.0.0.1:${fixture.publicPort}/api/remote.mux`, { headers: browserHeaders(fixture, node) })
  sockets.push(socket); socket.on('error', () => {})
  await once(socket, 'open'); return socket
}

/** A real WebSocket upgrade whose TCP client reads frames but never sends a close acknowledgement. */
async function unresponsiveBrowser(fixture: Fixture, node: FixtureNode) {
  const socket = await new Promise<Socket>((ok, fail) => {
    const req = request({ hostname: '127.0.0.1', port: fixture.publicPort, path: '/api/remote.mux', headers: {
      ...browserHeaders(fixture, node), connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-key': randomBytes(16).toString('base64'), 'sec-websocket-version': '13',
    } })
    req.once('error', fail)
    req.once('response', response => { response.resume(); fail(new Error(`Upgrade rejected: ${response.statusCode}`)) })
    req.once('upgrade', (_response, upgraded) => ok(upgraded as Socket))
    req.end()
  })
  sockets.push(socket)
  const closed = once(socket, 'close')
  const frame = new Promise<{ code: number; reason: string }>((ok, fail) => {
    let buffered = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length < 2) return
      const length = buffered[1] ?? 0
      if (buffered[0] !== 0x88 || length > 125) { fail(new Error('Expected one unmasked close frame')); return }
      if (buffered.length < length + 2) return
      ok({ code: buffered.readUInt16BE(2), reason: buffered.subarray(4, length + 2).toString() })
    })
  })
  return { socket, closed, frame }
}

async function upgradeStatus(url: string, headers: Record<string, string>): Promise<number | undefined> {
  return new Promise((ok, fail) => {
    const socket = new WebSocket(url, { headers, handshakeTimeout: 1000 })
    sockets.push(socket); socket.on('error', () => {})
    socket.once('unexpected-response', (_request, response) => { response.resume(); socket.terminate(); ok(response.statusCode) })
    socket.once('open', () => { socket.terminate(); fail(new Error('Accepted upgrade during shutdown')) })
  })
}

describe('Gateway planned WebSocket shutdown over actual sockets', () => {
  it.skipIf(process.env.GATEWAY_BROWSER_TEST !== '1')('delivers clean restart events to two real browser pages', async () => {
    const { fixture, nodes } = await setup()
    const browser = await chromium.launch({ headless: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP *.localhost 127.0.0.1'] })
    try {
      const context = await browser.newContext()
      await context.addCookies(nodes.map(node => ({ name: 'dsh_gateway_session', value: node.cookie.slice('dsh_gateway_session='.length), url: fixture.nodeOrigin(node.id) })))
      const pages = await Promise.all(nodes.map(async node => {
        const page = await context.newPage(); await page.goto(fixture.nodeOrigin(node.id)); return page
      }))
      const closes = pages.map(page => page.evaluate(() => new Promise<{ code: number; reason: string; wasClean: boolean }>(ok => {
        const socket = new globalThis.WebSocket(`ws://${location.host}/api/remote.mux`)
        socket.onclose = event => ok({ code: event.code, reason: event.reason, wasClean: event.wasClean })
      })).catch(error => ({ error: String(error) })))
      await until(() => [...fixture.gateway.peers.values()].every(peer => peer.tunnel.health.openMuxes === 1))
      await fixture.gateway.close()
      expect(await Promise.all(closes)).toEqual(nodes.map(() => ({ code: 1012, reason: 'Hub restarting', wasClean: true })))
    } finally { await browser.close() }
  })

  it('sends restart code 1012 to idle native browser muxes on both nodes', async () => {
    const { fixture, nodes } = await setup()
    const clients = await Promise.all(nodes.map(node => browserSocket(fixture, node)))
    await until(() => [...fixture.gateway.peers.values()].every(peer => peer.tunnel.health.openMuxes === 1))
    const closes = clients.map(client => once(client, 'close'))
    const began = performance.now()
    await fixture.gateway.close()
    const results = await Promise.all(closes)
    expect(results.map(([code, reason]) => ({ code, reason: String(reason) })))
      .toEqual(nodes.map(() => ({ code: 1012, reason: 'Hub restarting' })))
    expect(performance.now() - began).toBeLessThan(2500)
    expect(fixture.gateway.peers.size).toBe(0)
    expect(fixture.gateway.publicServer.listening).toBe(false)
    expect(fixture.gateway.privateServer.listening).toBe(false)
    await until(() => nodes.every(node => node.socket.readyState === WebSocket.CLOSED))
    expect(nodes.every(node => node.writes === 0)).toBe(true)
  })

  it('bounds an unacknowledged browser close and rejects new browser and node upgrades while draining', async () => {
    const { fixture, nodes } = await setup()
    const [a, b] = nodes
    if (!a || !b) throw new Error('Missing fixture nodes')
    const unresponsive = await unresponsiveBrowser(fixture, a)
    const healthy = await browserSocket(fixture, b)
    const healthyClose = once(healthy, 'close')
    const began = performance.now()
    let finished = false
    const closing = fixture.gateway.close().then(() => { finished = true })
    expect(await unresponsive.frame).toEqual({ code: 1012, reason: 'Hub restarting' })
    const [code, reason] = await healthyClose
    expect({ code, reason: String(reason) }).toEqual({ code: 1012, reason: 'Hub restarting' })
    expect(finished).toBe(false)
    expect(nodes.every(node => node.socket.readyState === WebSocket.OPEN)).toBe(true)
    expect(await upgradeStatus(`ws://127.0.0.1:${fixture.publicPort}/api/remote.mux`, browserHeaders(fixture, a))).toBe(503)
    expect(await upgradeStatus(`ws://127.0.0.1:${fixture.privatePort}/connect?nodeId=${a.id}`, {
      authorization: `Bearer ${a.credential}`, 'x-dsh-runtime': `runtime-${a.label}`,
    })).toBe(503)
    await closing
    await unresponsive.closed
    expect(performance.now() - began).toBeGreaterThanOrEqual(900)
    expect(performance.now() - began).toBeLessThan(2500)
    expect(unresponsive.socket.destroyed).toBe(true)
    expect(fixture.gateway.peers.size).toBe(0)
    expect(fixture.gateway.publicServer.listening).toBe(false)
    expect(fixture.gateway.privateServer.listening).toBe(false)
    await until(() => nodes.every(node => node.socket.readyState === WebSocket.CLOSED))
  })
})
