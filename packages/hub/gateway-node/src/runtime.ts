import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NodeSurface, type NativeRuntime } from './surface.ts'

interface Injection { kind: string; name?: string; [key: string]: unknown }

/** A structural view avoids loading another copy of the Runtime's Cordis service classes. */
export interface RuntimeContext extends NativeRuntime {
  clientModules: NativeRuntime['clientModules'] & { graph(): unknown }
  webServer?: { renderIndex(html: string): string }
  get?(name: string): unknown
  emit(name: string, rows: Injection[]): unknown
}

export interface RuntimeSurface { surface: NodeSurface; dshVersion: string }

/** Locate all browser assets through the installed Runtime package resolution. */
export async function createRuntimeSurface(ctx: RuntimeContext, resolutionAnchor = import.meta.url): Promise<RuntimeSurface> {
  if (typeof ctx.connection?.createSharedFetchHandler !== 'function'
    || typeof ctx.clientModules?.fetchBundle !== 'function'
    || typeof ctx.typertGateway?.wireStream?.open !== 'function') {
    throw new Error('This node requires DSH with native Connection, ClientModules and Gateway carrier APIs (tested with 0.1.7-rc.2)')
  }
  const require = createRequire(resolutionAnchor)
  const manifestPath = require.resolve('@deepseek-ai/dsh-web-frontend/package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string }
  const distIndex = join(dirname(manifestPath), 'dist/index.html')
  const renderer = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-host-webserver')).href) as {
    renderIndexInjections(html: string, rows: Injection[]): string
  }
  const modules = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-client-modules')).href) as {
    bootInjections(graph: unknown): Injection[]
  }
  const surface = new NodeSurface({
    runtime: ctx, distIndex,
    renderIndex: (html) => {
      // Render the existing service's live contributions; do not call its HTTP listener.
      const webServer = (ctx.get ? ctx.get('webServer') : ctx.webServer) as RuntimeContext['webServer']
      if (webServer) return webServer.renderIndex(html)
      const rows: Injection[] = []
      ctx.emit('webserver/index-inject', rows)
      if (!rows.some((row) => row.kind === 'global' && row.name === '__DSH_BOOT__')) rows.push(...modules.bootInjections(ctx.clientModules.graph()))
      return renderer.renderIndexInjections(html, rows)
    },
  })
  return { surface, dshVersion: manifest.version }
}
