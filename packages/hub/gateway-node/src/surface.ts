import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, extname, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { NativeMux, type NativeWireStream } from './stream.ts'
import { pluginEvents, type PluginEventSource } from './plugin-events.ts'

/** Existing Runtime capabilities; no listener or second Runtime is constructed. */
export interface NativeRuntime {
  connection: { createSharedFetchHandler(channel: '/api'): { fetch(request: Request): Promise<Response> } }
  clientModules: { fetchBundle(request: Request): Promise<Response> } & Partial<PluginEventSource>
  typertGateway: { wireStream: NativeWireStream }
}

export interface SurfaceOptions {
  runtime: NativeRuntime
  /** The installed, matching @deepseek-ai/dsh-web-frontend/dist/index.html. */
  distIndex: string
  /** Official Runtime renderer, including its live module graph and index contributions. */
  renderIndex(html: string): string | Promise<string>
}

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.map': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
}

/**
 * A trusted-carrier surface over one existing Runtime. The tunnel must authenticate
 * the Hub before calling it; browser authority/cookies never substitute for pairing.
 */
export class NodeSurface {
  private readonly api
  private readonly distRoot: string
  constructor(private readonly options: SurfaceOptions) {
    this.api = options.runtime.connection.createSharedFetchHandler('/api')
    this.distRoot = dirname(resolve(options.distIndex))
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    // Only upstream's registered API and published frontend resources are exposed.
    if (url.pathname.startsWith('/api/')) return this.api.fetch(request)
    if (url.pathname === '/api') return new Response('Not found', { status: 404 })
    if (url.pathname === '/plugins/events') {
      const modules = this.options.runtime.clientModules
      if (!modules.graph || !modules.onGraphChanged || !modules.onRebuilt) return new Response('Native plugin events are unavailable', { status: 501 })
      return pluginEvents(request, modules as PluginEventSource)
    }
    if (url.pathname.startsWith('/plugins/')) return this.options.runtime.clientModules.fetchBundle(request)
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
    let decoded: string
    try { decoded = decodeURIComponent(url.pathname) } catch { return new Response('Bad path', { status: 400 }) }
    if (decoded.includes('\0') || decoded.includes('\\')) return new Response('Bad path', { status: 400 })
    const target = resolve(this.distRoot, `.${decoded}`)
    if (target !== this.distRoot && !target.startsWith(`${this.distRoot}${sep}`)) return new Response('Forbidden', { status: 403 })
    try {
      const isIndex = target === this.distRoot || target === resolve(this.options.distIndex)
      const file = isIndex ? resolve(this.options.distIndex) : target
      const canonical = await realpath(file)
      const canonicalRoot = await realpath(this.distRoot)
      if (!canonical.startsWith(`${canonicalRoot}${sep}`)) return new Response('Forbidden', { status: 403 })
      if (isIndex) {
        const raw = await readFile(file, 'utf8')
        const rendered = await this.options.renderIndex(raw)
        const html = rendered.replace(/<head(?:\s[^>]*)?>/i, (open) => `${open}<base href="./">`)
          .replace(/<link\b(?=[^>]*\brel=["']manifest["'])([^>]*)>/gi, (tag) => /\bcrossorigin\s*=/.test(tag)
            ? tag.replace(/\bcrossorigin\s*=\s*(?:"[^"]*"|'[^']*')/i, 'crossorigin="use-credentials"')
            : tag.replace(/\s*\/?>$/, ' crossorigin="use-credentials">'))
        return new Response(request.method === 'HEAD' ? null : html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
      }
      const info = await stat(canonical)
      if (!info.isFile()) return new Response('Not found', { status: 404 })
      const body = request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(canonical)) as ReadableStream<Uint8Array>
      return new Response(body, { headers: {
        'content-type': mime[extname(file)] ?? 'application/octet-stream',
        'content-length': String(info.size),
        'cache-control': /\/assets\//.test(decoded) ? 'private, max-age=31536000, immutable' : 'private, no-cache',
      } })
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return new Response('Not found', { status: 404 })
      throw error
    }
  }

  /** One native browser mux connection; payloads remain upstream-owned. */
  openMux(send: (text: string) => Promise<void> | void, signal: AbortSignal): NativeMux {
    return new NativeMux(this.options.runtime.typertGateway.wireStream, send, signal)
  }
}
