import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'
import { GatewayTunnel, serveSurface } from '@k1412/dsh-gateway-transport'
import { NodeSurface } from '../src/surface.ts'

const decoder = new TextDecoder()
afterEach(() => { vi.useRealTimers() })
function fixture(label = 'a') {
  let graph: WebBootGraph = { rev: `${label}-initial`, entries: [], batches: [] }
  const graphListeners = new Set<() => void>()
  const rebuildListeners = new Set<(id: string, rev: string) => void>()
  const modules = {
    graph: () => graph,
    onGraphChanged(listener: () => void) { graphListeners.add(listener); return () => { graphListeners.delete(listener) } },
    onRebuilt(listener: (id: string, rev: string) => void) { rebuildListeners.add(listener); return () => { rebuildListeners.delete(listener) } },
    fetchBundle: vi.fn(async () => new Response('Bundle fallback must not receive events', { status: 404 })),
  }
  const surface = new NodeSurface({ distIndex: '/unused/index.html', renderIndex: html => html,
    runtime: { clientModules: modules, connection: { createSharedFetchHandler: () => ({ fetch: async () => new Response('unused') }) },
      typertGateway: { wireStream: { open: async () => { throw new Error('unused') }, failure: error => ({ code: 'test', message: String(error), details: {} }) } } } })
  return { surface, modules, graphListeners, rebuildListeners,
    graph(rev: string) { graph = { ...graph, rev }; for (const listener of graphListeners) listener() },
    rebuilt(id: string, rev: string) { for (const listener of rebuildListeners) listener(id, rev) },
  }
}
async function connection(f: ReturnType<typeof fixture>, signal?: AbortSignal) {
  const response = await f.surface.handle(new Request('https://native/plugins/events', signal ? { signal } : {}))
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('x-accel-buffering')).toBe('no')
  const reader = response.body!.getReader()
  const read = async () => decoder.decode((await reader.read()).value)
  const frame = async () => JSON.parse((await read()).slice('data: '.length))
  expect(await read()).toBe(': connected\n\n')
  return { reader, read, frame }
}

describe('native plugin graph SSE', () => {
  it('sends the current official graph and unchanged rebuilt/graph frames for independent nodes', async () => {
    const a = fixture('a'); const b = fixture('b')
    const [streamA, streamB] = await Promise.all([connection(a), connection(b)])
    expect(await streamA.frame()).toEqual({ type: 'graph', graph: a.modules.graph() })
    expect(await streamB.frame()).toEqual({ type: 'graph', graph: b.modules.graph() })
    a.rebuilt('@custom/a', '123456abcdef'); a.graph('a-updated')
    b.graph('b-updated')
    expect(await streamA.frame()).toEqual({ type: 'rebuilt', id: '@custom/a', rev: '123456abcdef' })
    expect(await streamA.frame()).toEqual({ type: 'graph', graph: a.modules.graph() })
    expect(await streamB.frame()).toEqual({ type: 'graph', graph: b.modules.graph() })
    await streamA.reader.cancel()
    expect(a.graphListeners.size + a.rebuildListeners.size).toBe(0)
    expect(b.graphListeners.size + b.rebuildListeners.size).toBe(2)
    b.rebuilt('@custom/b', 'abcdef123456')
    expect(await streamB.frame()).toEqual({ type: 'rebuilt', id: '@custom/b', rev: 'abcdef123456' })
    await streamB.reader.cancel()
    expect(b.graphListeners.size + b.rebuildListeners.size).toBe(0)
    expect(a.modules.fetchBundle).not.toHaveBeenCalled()
  })

  it('subscribes before the initial graph snapshot and sends a fresh graph on reconnect', async () => {
    const f = fixture()
    const subscribe = f.modules.onRebuilt
    f.modules.onRebuilt = listener => { f.graph('changed-during-subscription'); return subscribe(listener) }
    const response = await f.surface.handle(new Request('https://native/plugins/events'))
    const reader = response.body!.getReader()
    expect(decoder.decode((await reader.read()).value)).toContain('changed-during-subscription')
    expect(decoder.decode((await reader.read()).value)).toBe(': connected\n\n')
    expect(decoder.decode((await reader.read()).value)).toContain('changed-during-subscription')
    await reader.cancel()
    f.modules.onRebuilt = subscribe
    f.graph('changed-while-disconnected')
    const reopened = await connection(f)
    expect(await reopened.frame()).toEqual({ type: 'graph', graph: f.modules.graph() })
    await reopened.reader.cancel()
  })

  it('releases subscriptions and heartbeat timers on abort, cancel and an already aborted request', async () => {
    vi.useFakeTimers()
    const f = fixture(); const abort = new AbortController()
    const stream = await connection(f, abort.signal)
    await stream.frame()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await stream.read()).toBe(': heartbeat\n\n')
    abort.abort(new Error('Browser closed'))
    await expect(stream.reader.read()).rejects.toThrow('Browser closed')
    expect(f.graphListeners.size + f.rebuildListeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    const closed = await f.surface.handle(new Request('https://native/plugins/events', { signal: abort.signal }))
    await expect(closed.text()).rejects.toThrow('Browser closed')
    expect(f.graphListeners.size + f.rebuildListeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not subscribe for HEAD or unsupported methods and bounds a stalled consumer', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const head = await f.surface.handle(new Request('https://native/plugins/events', { method: 'HEAD' }))
    expect(head.status).toBe(200); expect(await head.text()).toBe('')
    const post = await f.surface.handle(new Request('https://native/plugins/events', { method: 'POST' }))
    expect(post.status).toBe(405); expect(post.headers.get('allow')).toBe('GET, HEAD')
    expect(f.graphListeners.size + f.rebuildListeners.size).toBe(0)
    const response = await f.surface.handle(new Request('https://native/plugins/events'))
    for (let i = 0; i < 100; i++) f.rebuilt('@fixture/plugin', 'x'.repeat(16_384))
    await expect(response.text()).rejects.toThrow('consumer fell behind')
    expect(f.graphListeners.size + f.rebuildListeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels registry listeners when the real carrier disconnects', async () => {
    const f = fixture()
    const server = createServer(); const sockets = new WebSocketServer({ server })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const accepted = once(sockets, 'connection')
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`)
    await once(socket, 'open')
    const [remote] = await accepted
    const tunnel = new GatewayTunnel(remote)
    const carrier = serveSurface(socket, f.surface)
    try {
      const response = await tunnel.fetch(new Request('https://native/plugins/events'))
      const reader = response.body!.getReader()
      expect(decoder.decode((await reader.read()).value)).toBe(': connected\n\n')
      expect(f.graphListeners.size + f.rebuildListeners.size).toBe(2)
      tunnel.close()
      await vi.waitFor(() => expect(f.graphListeners.size + f.rebuildListeners.size).toBe(0))
      expect(carrier.health.inflightRequests).toBe(0)
      await reader.cancel().catch(() => {})
    } finally {
      tunnel.close(); carrier.close()
      for (const ws of sockets.clients) ws.terminate()
      sockets.close(); await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
