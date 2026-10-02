/** Experimental metadata-only fan-out. No HTTP listener, persistence or DSH runtime. */
export const SUPPORTED_VERSION = '0.1.7-rc.2'
export interface Target {
  nodeId: string
  runtimeId: string
  /** Must change on every reconnect, even when the Runtime identity is unchanged. */
  generation: string
  name: string
  origin: string
  version: string
  online: boolean
  capabilities: { sessionList: boolean; nativeNavigation?: string }
}
export interface Gateway {
  /** Synchronous snapshot of authorized, non-revoked targets, one per node/Runtime. */
  targets(): readonly Target[]
  /** Unwrap RemoteResult from remote.session.list({}, signal); never return history. */
  list(target: Target, request: Record<string, never>, signal: AbortSignal): Promise<unknown>
  /** Only supplied with a separately verified, pinned native navigation capability. */
  sessionUrl?(target: Target, sessionId: string): string
}
export interface Row {
  nodeId: string; runtimeId: string; sessionId: string
  title: string | null; updatedAt: number; running: boolean; agentAvailable: boolean
}
export interface Entry extends Row { nodeName: string; nodeUrl: string; sessionUrl: string | null }
export type State = 'ok' | 'offline' | 'unsupported' | 'timeout' | 'error' | 'changed'
export interface NodeResult {
  nodeId: string; runtimeId: string; state: State; count: number; truncated: boolean; cached: boolean
}
export interface Page {
  entries: Entry[]; nodes: NodeResult[]; offset: number; limit: number; total: number; nextOffset: number | null
}
export interface Options {
  timeoutMs?: number; cacheMs?: number; concurrency?: number; maxNodes?: number; maxSessionsPerNode?: number
}
interface Metadata { sessionId: string; title: string | null; updatedAt: number; running: boolean; agentAvailable: boolean }
interface Cache { rows: Metadata[]; truncated: boolean; expires: number; timer: ReturnType<typeof setTimeout> }
interface Fetched { target: Target; key: string; revision: number; state: State; rows: Metadata[]; truncated: boolean; cached: boolean }
const keyOf = (t: Target): string => JSON.stringify([t.nodeId, t.runtimeId, t.generation, t.version, t.origin, t.online, t.capabilities])
const ownerOf = (t: Target): string => JSON.stringify([t.nodeId, t.runtimeId])
function integer(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError('Directory option outside bounds')
  return value
}
function originOf(value: string): string {
  const url = new URL(value)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')))) || url.origin !== value || url.username || url.password) throw new Error('Invalid node origin')
  return url.origin
}
function metadata(value: unknown, max: number): { rows: Metadata[]; truncated: boolean } {
  if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items)) throw new Error('Invalid native list')
  const ids = new Set<string>()
  // Native rc.2 listing is unpaged; the adapter must also cap transport response bytes.
  const rows: Metadata[] = value.items.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid native row')
    const row = item as Record<string, unknown>
    if (typeof row.sessionId !== 'string' || !row.sessionId || row.sessionId.length > 1024 || ids.has(row.sessionId)
      || typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt)
      || typeof row.running !== 'boolean' || typeof row.agentAvailable !== 'boolean') throw new Error('Invalid native row')
    ids.add(row.sessionId)
    const projection = row.projections as { values?: { title?: unknown } } | undefined
    const title = projection?.values?.title
    return { sessionId: row.sessionId, title: typeof title === 'string' ? title.slice(0, 1024) : null,
      updatedAt: row.updatedAt, running: row.running, agentAvailable: row.agentAvailable }
  })
  rows.sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId))
  return { rows: rows.slice(0, max), truncated: rows.length > max }
}

export class SessionDirectory {
  private readonly cache = new Map<string, Cache>()
  private readonly active = new Map<AbortController, Target>()
  private revision = 0
  private disposed = false
  readonly options: Required<Options>
  constructor(private readonly gateway: Gateway, options: Options = {}) {
    this.options = {
      timeoutMs: integer(options.timeoutMs ?? 800, 1, 30_000), cacheMs: integer(options.cacheMs ?? 2000, 0, 5000),
      concurrency: integer(options.concurrency ?? 8, 1, 64), maxNodes: integer(options.maxNodes ?? 64, 1, 256),
      maxSessionsPerNode: integer(options.maxSessionsPerNode ?? 10_000, 1, 100_000),
    }
  }
  /** Call on list changes, reconnect/disconnect, revocation and shutdown. */
  invalidate(nodeId?: string): void {
    this.revision++
    for (const [key, entry] of this.cache) {
      if (nodeId === undefined || (JSON.parse(key) as unknown[])[0] === nodeId) {
        clearTimeout(entry.timer); this.cache.delete(key)
      }
    }
    for (const [controller, target] of this.active) {
      if (nodeId === undefined || target.nodeId === nodeId) controller.abort(new Error('changed'))
    }
  }
  dispose(): void { this.disposed = true; this.invalidate() }
  private current(target: Target): boolean {
    return this.gateway.targets().some(t => ownerOf(t) === ownerOf(target) && keyOf(t) === keyOf(target))
  }
  private async fetch(target: Target, signal?: AbortSignal): Promise<Fetched> {
    const key = keyOf(target), revision = this.revision
    const base: Fetched = { target, key, revision, state: 'ok', rows: [], truncated: false, cached: false }
    if (!target.online) return { ...base, state: 'offline' }
    if (target.version !== SUPPORTED_VERSION || !target.capabilities.sessionList) return { ...base, state: 'unsupported' }
    try { originOf(target.origin) } catch { return { ...base, state: 'unsupported' } }
    const cached = this.cache.get(key)
    if (cached && cached.expires > Date.now()) return { ...base, rows: cached.rows, truncated: cached.truncated, cached: true }
    const controller = new AbortController()
    this.active.set(controller, target)
    let timeout = false
    const timer = setTimeout(() => { timeout = true; controller.abort(new Error('timeout')) }, this.options.timeoutMs)
    const abort = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    let removeAbort = (): void => {}
    const stopped = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', onAbort, { once: true })
      removeAbort = () => controller.signal.removeEventListener('abort', onAbort)
    })
    try {
      signal?.throwIfAborted()
      const raw = await Promise.race([Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return this.gateway.list(target, {}, controller.signal)
      }), stopped])
      controller.signal.throwIfAborted()
      if (revision !== this.revision || !this.current(target)) return { ...base, state: 'changed' }
      const parsed = metadata(raw, this.options.maxSessionsPerNode)
      if (this.options.cacheMs > 0) {
        const old = this.cache.get(key)
        if (old) clearTimeout(old.timer)
        const entry: Cache = { ...parsed, expires: Date.now() + this.options.cacheMs,
          timer: setTimeout(() => { if (this.cache.get(key) === entry) this.cache.delete(key) }, this.options.cacheMs) }
        entry.timer.unref()
        this.cache.set(key, entry)
      }
      return { ...base, ...parsed }
    } catch {
      signal?.throwIfAborted()
      return { ...base, state: timeout ? 'timeout' : revision !== this.revision || !this.current(target) ? 'changed' : 'error' }
    } finally {
      clearTimeout(timer); removeAbort(); signal?.removeEventListener('abort', abort); this.active.delete(controller)
    }
  }
  async page(request: { offset?: number; limit?: number; signal?: AbortSignal } = {}): Promise<Page> {
    if (this.disposed) throw new Error('Directory disposed')
    request.signal?.throwIfAborted()
    const offset = integer(request.offset ?? 0, 0, Number.MAX_SAFE_INTEGER), limit = integer(request.limit ?? 50, 1, 200)
    const targets = this.gateway.targets().map(t => ({ ...t, capabilities: { ...t.capabilities } }))
    if (targets.length > this.options.maxNodes) throw new RangeError('Too many directory targets')
    if (new Set(targets.map(ownerOf)).size !== targets.length) throw new Error('Duplicate gateway ownership')
    if (new Set(targets.map(t => t.origin)).size !== targets.length) throw new Error('Node origins must be distinct')
    const keys = new Set(targets.map(keyOf))
    for (const [key, entry] of this.cache) if (!keys.has(key)) { clearTimeout(entry.timer); this.cache.delete(key) }
    const results: Fetched[] = []
    let index = 0
    await Promise.all(Array.from({ length: Math.min(this.options.concurrency, targets.length) }, async () => {
      while (index < targets.length) {
        request.signal?.throwIfAborted()
        const target = targets[index++]
        if (!target) break
        results.push(await this.fetch(target, request.signal))
      }
    }))
    request.signal?.throwIfAborted()
    const entries: Entry[] = [], nodes: NodeResult[] = []
    for (const result of results.sort((a, b) => ownerOf(a.target).localeCompare(ownerOf(b.target)))) {
      const { target } = result
      if (!this.current(target) || result.revision !== this.revision) { result.state = 'changed'; result.rows = [] }
      nodes.push({ nodeId: target.nodeId, runtimeId: target.runtimeId, state: result.state,
        count: result.rows.length, truncated: result.truncated, cached: result.cached })
      for (const row of result.rows) {
        let sessionUrl: string | null = null
        if (target.capabilities.nativeNavigation && this.gateway.sessionUrl) {
          try {
            const url = new URL(this.gateway.sessionUrl(target, row.sessionId))
            if (url.origin === target.origin && !url.username && !url.password) sessionUrl = url.href
          } catch { /* Missing/invalid navigation stays explicit, never falls back to another target. */ }
        }
        entries.push({ ...row, nodeId: target.nodeId, runtimeId: target.runtimeId, nodeName: target.name,
          nodeUrl: `${target.origin}/`, sessionUrl })
      }
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt || a.nodeId.localeCompare(b.nodeId)
      || a.runtimeId.localeCompare(b.runtimeId) || a.sessionId.localeCompare(b.sessionId))
    return { entries: entries.slice(offset, offset + limit), nodes, offset, limit, total: entries.length,
      nextOffset: offset + limit < entries.length ? offset + limit : null }
  }
}
export { renderDirectory, directoryResponse } from './ssr.ts'

export { nativeList, DirectoryAdmission } from './native-rpc.ts'
