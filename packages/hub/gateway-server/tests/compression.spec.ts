import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { createFixture, until } from './fixture.ts'

type Fixture = Awaited<ReturnType<typeof createFixture>>
const fixtures: Fixture[] = []
async function setup() { const fixture = await createFixture({ requestTimeoutMs: 5000 }); fixtures.push(fixture); return fixture }
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.close())) })
const bundle = '/plugins/@fixture/ui/client.js'
const revision = '123456abcdef'
const combo = `/plugins/??@fixture/ui/client.js,@fixture/shared/client.js&rev=${revision}`
const immutable = 'public, max-age=31536000, immutable'
const code = Buffer.from('export const message = "原生脚本保持字节一致";\n'.repeat(16_384))
const headers = { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': immutable }
const decoded = async (response: Response) => {
  const bytes = Buffer.from(await response.arrayBuffer())
  return response.headers.get('content-encoding') === 'gzip' ? gunzipSync(bytes) : bytes
}

describe('native static code compression and private browser caching', () => {
  it('streams byte-exact gzip JS/CSS and actual rc.2 combo URLs independently for two nodes', async () => {
    const f = await setup()
    await mkdir(join(f.dir, 'web/assets'))
    const css = Buffer.from('.native { color: rebeccapurple; }\n'.repeat(8192))
    await writeFile(join(f.dir, 'web/assets/index-Q6zc2uHV.js'), code)
    await writeFile(join(f.dir, 'web/assets/index-DUvMhLle.css'), css)
    const nodes = await Promise.all(['A', 'B'].map(label => f.addNode(label, async () => new Response(Buffer.concat([Buffer.from(label), code]), {
      headers: { ...headers, vary: 'Origin', 'content-length': String(code.length + 1), etag: '"native-validator"', 'last-modified': 'Mon, 01 Jun 2026 00:00:00 GMT',
        'content-md5': 'native-md5', digest: 'sha-256=native', 'content-digest': 'sha-256=:native:', 'repr-digest': 'sha-256=:native:', 'accept-ranges': 'bytes' },
    }))))
    await Promise.all(nodes.flatMap(node => [
      [bundle + `?rev=${revision}`, Buffer.concat([Buffer.from(node.label), code])],
      [combo, Buffer.concat([Buffer.from(node.label), code])],
      ['/assets/index-Q6zc2uHV.js', code], ['/assets/index-DUvMhLle.css', css],
    ].map(async ([path, expected]) => {
      const response = await f.request(path as string, { node, headers: { 'accept-encoding': 'br, gzip;q=0.8' } })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-encoding')).toBe('gzip')
      expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
      expect(response.headers.get('vary')).toContain('Accept-Encoding')
      for (const name of ['content-length', 'etag', 'last-modified', 'content-md5', 'digest', 'content-digest', 'repr-digest', 'accept-ranges']) expect(response.headers.has(name)).toBe(false)
      const compressed = Buffer.from(await response.arrayBuffer())
      expect(gunzipSync(compressed).equals(expected as Buffer)).toBe(true)
      expect(compressed.length).toBeLessThan((expected as Buffer).length / 10)
    })))
    await until(() => [...f.gateway.peers.values()].every(peer => peer.tunnel.health.inflightRequests === 0))
    expect(nodes.every(node => node.carrier.health.connected)).toBe(true)
  })

  it('requires explicit acceptable gzip, preserves Vary and returns GET-equivalent HEAD metadata without a body', async () => {
    const f = await setup()
    const node = await f.addNode('A', async request => new Response(request.method === 'HEAD' ? null : code, {
      headers: { ...headers, 'content-length': String(code.length), vary: new URL(request.url).searchParams.has('wildcard') ? '*' : 'Origin, accept-encoding' },
    }))
    for (const accept of [undefined, '', 'br', '*', 'gzip;q=0', 'br, gzip;q=0.000', 'gzip;q=0, *;q=1', 'gzip;q=invalid', 'gzip;q=1.1', 'gzip;q=0, gzip;q=1']) {
      const response = await f.request(bundle, { node, headers: accept === undefined ? {} : { 'accept-encoding': accept } })
      expect(response.headers.has('content-encoding'), `Unexpected gzip for ${accept}`).toBe(false)
      expect(response.headers.get('vary')).toBe('Origin, accept-encoding')
      expect(response.headers.get('content-length')).toBe(String(code.length))
      expect((await decoded(response)).equals(code)).toBe(true)
    }
    for (const method of ['GET', 'HEAD']) {
      const response = await f.request(`${bundle}?rev=${revision}`, { node, method, headers: { 'accept-encoding': 'GZip ; q=0.5' } })
      expect(response.headers.get('content-encoding')).toBe('gzip')
      expect(response.headers.has('content-length')).toBe(false)
      expect(response.headers.get('vary')).toBe('Origin, accept-encoding')
      if (method === 'HEAD') expect((await response.arrayBuffer()).byteLength).toBe(0)
      else expect((await decoded(response)).equals(code)).toBe(true)
    }
    const wildcard = await f.request(`${bundle}?wildcard`, { node, headers: { 'accept-encoding': 'gzip' } })
    expect(wildcard.headers.get('vary')).toBe('*')
    await wildcard.arrayBuffer()
  })

  it('does not compress ranges, encoded bodies, failures, downloads, API or event streams', async () => {
    const f = await setup()
    const compressed = gzipSync(code)
    const node = await f.addNode('A', async request => {
      const variant = new URL(request.url).searchParams.get('variant')
      if (variant === 'encoded') return new Response(compressed, { headers: { ...headers, 'content-encoding': 'gzip', 'content-length': String(compressed.length) } })
      if (variant === 'partial') return new Response(code.subarray(0, 32), { status: 206, headers: { ...headers, 'content-range': `bytes 0-31/${code.length}` } })
      if (variant === 'failed') return new Response('Unavailable', { status: 503, headers })
      if (variant === 'download') return new Response(code, { headers: { ...headers, 'content-disposition': 'attachment; filename="code.js"' } })
      if (variant === 'events') return new Response('data: native\n\n', { headers: { 'content-type': 'text/event-stream' } })
      if (variant === 'empty') return new Response(null, { headers })
      if (variant === 'no-transform') return new Response(code, { headers: { ...headers, 'cache-control': 'private, immutable, no-transform' } })
      return new Response(code, { headers })
    })
    for (const variant of ['encoded', 'partial', 'failed', 'download', 'events', 'empty', 'no-transform', 'range-ignored']) {
      const response = await f.request(`${bundle}?variant=${variant}`, { node, headers: { 'accept-encoding': 'gzip', ...(variant === 'range-ignored' ? { range: 'bytes=0-31' } : {}) } })
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      if (variant === 'encoded') {
        expect(response.headers.get('content-encoding')).toBe('gzip')
        expect(response.headers.get('content-length')).toBe(String(compressed.length))
        expect(Buffer.from(await response.arrayBuffer()).equals(compressed)).toBe(true)
      } else {
        expect(response.headers.has('content-encoding')).toBe(false)
        await response.arrayBuffer()
      }
    }
    for (const path of ['/', '/api/identity']) {
      const response = await f.request(path, { node, headers: { 'accept-encoding': 'gzip' } })
      expect(response.headers.has('content-encoding')).toBe(false)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      await response.arrayBuffer()
    }
    const file = await f.request('/api/download', { node, headers: { 'accept-encoding': 'gzip' } })
    expect(file.headers.has('content-encoding')).toBe(false)
    await file.body?.cancel()
  })

  it('caches only native immutable versioned successes, with revision changes and origins remaining isolated', async () => {
    const f = await setup()
    await mkdir(join(f.dir, 'web/assets'))
    await writeFile(join(f.dir, 'web/assets/plain.js'), code)
    const nodes = await Promise.all(['A', 'B'].map(label => f.addNode(label, async request => {
      const rev = new URL(request.url).searchParams.get('rev')
      return new Response(`${label}:${rev}`, { status: rev === 'ffffffffffff' ? 503 : 200,
        headers: { ...headers, 'cache-control': rev === '000000000000' ? 'no-store' : rev === '111111111111' ? 'no-store, immutable' : immutable } })
    })))
    for (const node of nodes) {
      for (const rev of ['123456abcdef', 'abcdef123456']) {
        const response = await f.request(`${bundle}?rev=${rev}`, { node, headers: { 'accept-encoding': 'gzip' } })
        expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
        expect((await decoded(response)).toString()).toBe(`${node.label}:${rev}`)
      }
      for (const path of [bundle, `${bundle}?rev=wrong`, `${bundle}?rev=123`, `${bundle}?rev=${revision}&rev=abcdef123456`, `${bundle}?rev=ffffffffffff`, `${bundle}?rev=000000000000`, `${bundle}?rev=111111111111`, '/assets/plain.js']) {
        const response = await f.request(path, { node, headers: { 'accept-encoding': 'gzip' } })
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        await response.arrayBuffer()
      }
    }
    const unauthorized = await f.request(`${bundle}?rev=${revision}`, { node: nodes[0], headers: { cookie: '' } })
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers.get('cache-control')).toBe('no-store')
    expect(unauthorized.headers.has('content-encoding')).toBe(false)
    await unauthorized.arrayBuffer()
  })

  it('cancels gzip source resources on browser abort while another node continues serving', async () => {
    const f = await setup()
    let cancelled = 0; let aborted = 0; let produced = 0
    const a = await f.addNode('A', async request => {
      request.signal.addEventListener('abort', () => { aborted++ }, { once: true })
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, 5))
          if (!request.signal.aborted) { produced++; controller.enqueue(randomBytes(32_768)) }
        }, cancel() { cancelled++ },
      }), { headers })
    })
    const b = await f.addNode('B', async () => new Response('node-b', { headers }))
    const downloading = await f.request(bundle, { node: a, headers: { 'accept-encoding': 'gzip' } })
    expect(downloading.headers.get('content-encoding')).toBe('gzip')
    const reader = downloading.body?.getReader()
    expect((await reader?.read())?.value?.byteLength).toBeGreaterThan(0)
    await reader?.cancel()
    await until(() => cancelled > 0 && aborted > 0 && a.carrier.health.inflightRequests === 0)
    const stoppedAt = produced
    const other = await f.request(bundle, { node: b, headers: { 'accept-encoding': 'gzip' } })
    expect((await decoded(other)).toString()).toBe('node-b')
    await until(() => [...f.gateway.peers.values()].every(peer => peer.tunnel.health.inflightRequests === 0))
    expect(produced).toBe(stoppedAt)
    expect(a.carrier.health.connected && b.carrier.health.connected).toBe(true)
  })

  it('settles mid-stream native failures without leaving requests or breaking either node', async () => {
    const f = await setup()
    let chunks = 0
    const a = await f.addNode('A', async () => new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise(resolve => setTimeout(resolve, 20))
        if (chunks++ === 0) controller.enqueue(randomBytes(65_536))
        else controller.error(new Error('Native fixture stream failed'))
      },
    }), { headers }))
    const b = await f.addNode('B', async () => new Response('still-online', { headers }))
    await expect(f.request(bundle, { node: a, headers: { 'accept-encoding': 'gzip' } }).then(response => response.arrayBuffer())).rejects.toThrow()
    await until(() => a.carrier.health.inflightRequests === 0 && [...f.gateway.peers.values()].every(peer => peer.tunnel.health.inflightRequests === 0))
    expect(a.carrier.health.connected && b.carrier.health.connected).toBe(true)
    expect((await decoded(await f.request(bundle, { node: b, headers: { 'accept-encoding': 'gzip' } }))).toString()).toBe('still-online')
    expect((await f.request('/api/identity', { node: a })).status).toBe(200)
  })
})
