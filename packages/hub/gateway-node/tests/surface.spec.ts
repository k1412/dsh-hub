import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeSurface, type NativeRuntime } from '../src/surface.ts'
import { NativeMux, type NativeWireStream } from '../src/stream.ts'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

const nativeWire = (): NativeWireStream => ({
  open: async (_endpoint, _payload, uplink) => uplink,
  failure: (error) => ({ code: 'gateway/test-failure', message: String(error), details: {} }),
})

async function fixture(label = 'node-a') {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-native-')); dirs.push(directory)
  const dist = join(directory, 'dist'); await mkdir(join(dist, 'assets'), { recursive: true })
  await writeFile(join(dist, 'index.html'), '<!doctype html><html><head><title>DSH</title><link rel="manifest" href="./manifest.webmanifest"></head><body><script src="./assets/app.js"></script></body></html>')
  await writeFile(join(dist, 'assets/app.js'), `globalThis.nativeNode=${JSON.stringify(label)}`)
  const fetchApi = vi.fn(async (request: Request) => new Response(request.body, { headers: { 'content-type': 'application/octet-stream' } }))
  const fetchBundle = vi.fn(async () => new Response(`register(${JSON.stringify(label)})`, { headers: { 'content-type': 'text/javascript' } }))
  const runtime: NativeRuntime = {
    connection: { createSharedFetchHandler: () => ({ fetch: fetchApi }) },
    clientModules: { fetchBundle }, typertGateway: { wireStream: nativeWire() },
  }
  const surface = new NodeSurface({ runtime, distIndex: join(dist, 'index.html'), renderIndex: (html) => html.replace('<head>', `<head><script>globalThis.__DSH_BOOT__=${JSON.stringify(label)}</script>`) })
  return { surface, runtime, fetchApi, fetchBundle, directory, dist }
}

describe('one installed native frontend and API surface', () => {
  it('renders the owning runtime boot graph and streams its exact installed assets', async () => {
    const { surface } = await fixture()
    const response = await surface.handle(new Request('https://node.test/'))
    expect(response.headers.get('cache-control')).toBe('no-store')
    const html = await response.text()
    expect(html).toContain('<base href="./"><script>globalThis.__DSH_BOOT__="node-a"')
    expect(html).toContain('<link rel="manifest" href="./manifest.webmanifest" crossorigin="use-credentials">')
    const asset = await surface.handle(new Request('https://node.test/assets/app.js'))
    expect(await asset.text()).toBe('globalThis.nativeNode="node-a"')
    const head = await surface.handle(new Request('https://node.test/assets/app.js', { method: 'HEAD' }))
    expect(await head.text()).toBe('')
    expect(head.headers.get('content-length')).toBe('30')
  })

  it('passes current RPC fields, attachment bytes, query and cancellation directly to native handlers', async () => {
    const { surface, fetchApi } = await fixture()
    const abort = new AbortController()
    const bytes = new Uint8Array([0, 255, 17, 128, 0, 242])
    const request = new Request('https://node.test/api/file/upload?sessionId=original', { method: 'POST', body: bytes, signal: abort.signal })
    const response = await surface.handle(request)
    expect(fetchApi).toHaveBeenCalledWith(request)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    abort.abort(); expect(fetchApi.mock.calls[0]![0].signal.aborted).toBe(true)
    const body = { type: 'client-request', rpcId: 'untouched', method: 'session/prompt', payload: { request: { requestId: 'native', submittedAttachments: [], prompt: 'hello' } } }
    const rpc = await surface.handle(new Request('https://node.test/api/session/prompt', { method: 'POST', body: JSON.stringify(body) }))
    expect(await rpc.json()).toEqual(body)
  })

  it('keeps simultaneous nodes and native plugin resources independent', async () => {
    const a = await fixture('node-a'); const b = await fixture('node-b')
    const path = 'https://node.test/plugins/@custom/plugin/client.js?rev=dynamic'
    const [bundleA, bundleB] = await Promise.all([a.surface.handle(new Request(path)), b.surface.handle(new Request(path))])
    expect(await bundleA.text()).toBe('register("node-a")')
    expect(await bundleB.text()).toBe('register("node-b")')
    expect(a.fetchBundle.mock.calls[0]![0].url).toBe(path)
  })

  it('never falls back to SPA HTML for absent scripts or API endpoints and refuses escaping files', async () => {
    const { surface, directory, dist } = await fixture()
    expect((await surface.handle(new Request('https://node.test/missing.js'))).status).toBe(404)
    expect((await surface.handle(new Request('https://node.test/api'))).status).toBe(404)
    await writeFile(join(directory, 'secret'), 'must stay private')
    await symlink(join(directory, 'secret'), join(dist, 'escape'))
    expect((await surface.handle(new Request('https://node.test/escape'))).status).toBe(403)
    expect((await surface.handle(new Request('https://node.test/%2e%2e%2fsecret'))).status).toBe(403)
    expect((await surface.handle(new Request('https://node.test/', { method: 'POST' }))).status).toBe(405)
  })
})

describe('native mux carrier', () => {
  it('preserves bidirectional native frames and independent simultaneous streams', async () => {
    const sent: unknown[] = []
    const abort = new AbortController()
    const wire = nativeWire(); const open = vi.spyOn(wire, 'open')
    const mux = new NativeMux(wire, (text) => { sent.push(JSON.parse(text)) }, abort.signal)
    mux.receive(JSON.stringify({ type: 'open', streamId: 'a', endpoint: 'terminal/run', payload: { request: { path: '/home/a' } } }))
    mux.receive(JSON.stringify({ type: 'open', streamId: 'b', endpoint: 'session/follow', payload: { agentId: 'same-original-id', request: { since: 10 } } }))
    mux.receive(JSON.stringify({ type: 'item', streamId: 'b', value: { unmodified: 'b' } }))
    mux.receive(JSON.stringify({ type: 'item', streamId: 'a', value: { unmodified: 'a' } }))
    mux.receive(JSON.stringify({ type: 'end', streamId: 'a' }))
    mux.receive(JSON.stringify({ type: 'end', streamId: 'b' }))
    await vi.waitFor(() => expect(sent).toHaveLength(4))
    expect(sent).toEqual(expect.arrayContaining([
      { type: 'item', streamId: 'a', value: { unmodified: 'a' } }, { type: 'item', streamId: 'b', value: { unmodified: 'b' } },
      { type: 'end', streamId: 'a' }, { type: 'end', streamId: 'b' },
    ]))
    expect(open.mock.calls[0]!.slice(0, 2)).toEqual(['terminal/run', { request: { path: '/home/a' } }])
    await mux.close()
  })

  it('cancels native methods when a browser cancels or the carrier disconnects', async () => {
    const abort = new AbortController(); const signals: AbortSignal[] = []; const stopped: string[] = []
    const wire: NativeWireStream = { ...nativeWire(), open: async (endpoint, _payload, _uplink, _peer, signal) => {
      signals.push(signal)
      return { async *[Symbol.asyncIterator]() { try { await new Promise<void>((resolve) => { signal.addEventListener('abort', () => resolve(), { once: true }) }); yield 'cancelled' } finally { stopped.push(endpoint) } } }
    } }
    const send = vi.fn(); const mux = new NativeMux(wire, send, abort.signal)
    mux.receive(JSON.stringify({ type: 'open', streamId: 'a', endpoint: '$events', payload: {} }))
    mux.receive(JSON.stringify({ type: 'open', streamId: 'b', endpoint: 'session/follow', payload: {} }))
    await Promise.resolve()
    mux.receive(JSON.stringify({ type: 'cancel', streamId: 'a' }))
    await vi.waitFor(() => expect(stopped).toContain('$events'))
    await mux.close()
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(stopped).toContain('session/follow')
    expect(send).not.toHaveBeenCalled()
  })

  it('returns upstream stream failures intact and refuses duplicate identities', async () => {
    const sent: unknown[] = []
    const wire: NativeWireStream = { ...nativeWire(), open: async () => { throw new Error('native failure') } }
    const mux = new NativeMux(wire, (text) => { sent.push(JSON.parse(text)) }, new AbortController().signal)
    const frame = JSON.stringify({ type: 'open', streamId: 'a', endpoint: 'custom/follow', payload: {} })
    mux.receive(frame)
    expect(() => mux.receive(frame)).toThrow('Duplicate')
    await vi.waitFor(() => expect(sent).toEqual([{ type: 'error', streamId: 'a', error: { code: 'gateway/test-failure', message: 'Error: native failure', details: {} } }]))
    await mux.close()
  })

  it('settles a stream with an error when its unconsumed uplink exceeds the bound', async () => {
    const sent: Array<{ type: string }> = []
    const wire: NativeWireStream = { ...nativeWire(), open: async (_endpoint, _payload, _uplink, _peer, signal) => ({
      async *[Symbol.asyncIterator]() { await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) }); yield 'discarded' },
    }) }
    const mux = new NativeMux(wire, (text) => { sent.push(JSON.parse(text)) }, new AbortController().signal)
    mux.receive(JSON.stringify({ type: 'open', streamId: 'a', endpoint: 'terminal/run', payload: {} }))
    mux.receive(JSON.stringify({ type: 'item', streamId: 'a', value: 'x'.repeat(256 * 1024) }))
    await vi.waitFor(() => expect(sent[0]?.type).toBe('error'))
    await mux.close()
  })
})
