import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRuntimeSurface, type RuntimeContext } from '../src/runtime.ts'

// Optional real upstream contract gate. Run with DSH_NATIVE_ROOT pointing at an
// installed DSH 0.1.7-rc.2 package tree; the normal unit suite stays self-contained.
const root = process.env.DSH_NATIVE_ROOT
describe.skipIf(!root)('published DSH native carrier integration', () => {
  it('serves the installed official shell and native JSON/multipart/streaming fetch responses', async () => {
    const require = createRequire(join(root!, 'package.json'))
    const load = async (name: string) => import(pathToFileURL(require.resolve(name)).href)
    const [{ Context }, { HostConnectionService }] = await Promise.all([
      load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-client-connection'),
    ])
    const ctx = new Context()
    const connection = new HostConnectionService(ctx, [], {})
    const bytes = new Uint8Array([0, 255, 128, 14, 66, 0])
    connection.rpc.intercept('/api', (endpoint: string) => endpoint.startsWith('fixture/'), async (endpoint: string, payload: unknown) => endpoint === 'fixture/attachment'
      ? { ok: true, value: { file: null }, attachments: [{ path: ['file'], bytes }] }
      : { ok: true, value: payload })
    connection.fetch.register({ path: '/api/fixture/binary', methods: ['POST'], requestBody: 'streaming', fetch: async (request: Request) => new Response(request.body, { headers: { 'content-type': 'application/octet-stream' } }) })
    const runtime = {
      connection,
      clientModules: { graph: () => ({ rev: 'native-test', entries: [], batches: [] }), onGraphChanged: () => () => {}, onRebuilt: () => () => {}, fetchBundle: async () => new Response('not found', { status: 404 }) },
      typertGateway: { wireStream: { open: async () => { throw new Error('not used') }, failure: (error: unknown) => ({ code: 'internal', message: String(error), details: {} }) } },
      emit: (name: string, rows: unknown[]) => ctx.emit(name, rows),
    }
    try {
      const { surface, dshVersion } = await createRuntimeSurface(runtime as RuntimeContext, pathToFileURL(join(root!, 'package.json')).href)
      expect(dshVersion).toBe('0.1.7-rc.2')
      const page = await surface.handle(new Request('https://node.test/'))
      const html = await page.text()
      expect(html).toContain('__DSH_BOOT_READY__')
      expect(html).toContain('__DSH_BOOT__')
      const assetPath = html.match(/src="\.\/(assets\/[^"]+\.js)"/)?.[1]
      expect(assetPath).toBeTruthy()
      const asset = await surface.handle(new Request(`https://node.test/${assetPath}`))
      expect(asset.status).toBe(200)
      expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(10000)
      const payload = { args: { request: { requestId: 'native', submittedAttachments: [], prompt: 'hello' } } }
      const response = await surface.handle(new Request('https://node.test/api/fixture/exact', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'call-1', method: 'fixture/exact', payload }) }))
      expect(await response.json()).toEqual({ type: 'server-response', rpcId: 'call-1', result: { ok: true, value: payload } })
      const binary = await surface.handle(new Request('https://node.test/api/fixture/binary', { method: 'POST', body: bytes }))
      expect(new Uint8Array(await binary.arrayBuffer())).toEqual(bytes)
      const multipart = await surface.handle(new Request('https://node.test/api/fixture/attachment', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'call-2', method: 'fixture/attachment', payload: {} }) }))
      expect(multipart.headers.get('content-type')).toContain('multipart/form-data; boundary=')
      const parts = await multipart.formData()
      expect(JSON.parse(String(parts.get('metadata'))).attachments).toEqual([{ path: ['file'], codec: 'bytes', part: 'bytes-0' }])
      expect(new Uint8Array(await (parts.get('bytes-0') as File).arrayBuffer())).toEqual(bytes)
    } finally { await ctx.fiber.dispose() }
  })
})
