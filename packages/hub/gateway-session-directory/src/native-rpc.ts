import { randomUUID } from 'node:crypto'
interface NativeTunnel {
  fetch(request: Request): Promise<Response>
  openMux(receive: (text: string) => void, signal: AbortSignal): { send(text: string): void; close(): void }
}
/** The exact rc.2 generated Typert JSON carrier. No business schema translation. */
export async function nativeList(tunnel: { fetch(request: Request): Promise<Response> }, origin: string, signal: AbortSignal, maxBytes = 8 * 1024 * 1024): Promise<unknown> {
  const rpcId = randomUUID()
  const response = await tunnel.fetch(new Request(new URL('/api/session/list', origin), {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'session/list', payload: { args: { _request: {} } } }),
  }))
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel(); throw new Error('Native list failed')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty native reply')
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const part = await reader.read(); if (part.done) break
      size += part.value.byteLength
      if (size > maxBytes) throw new Error('Native reply exceeds directory limit')
      chunks.push(part.value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const reply = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { type?: string; rpcId?: string; result?: { ok?: boolean; value?: unknown } }
  if (reply.type !== 'server-response' || reply.rpcId !== rpcId || reply.result?.ok !== true) throw new Error('Native list rejected')
  return reply.result.value
}
/** Read one official workspace/follow baseline, then cancel its native subscription. */
export async function nativeArchivedSessions(tunnel: Pick<NativeTunnel, 'openMux'>, signal: AbortSignal, maxBytes = 256 * 1024): Promise<string[]> {
  signal.throwIfAborted()
  const streamId = randomUUID(), result = Promise.withResolvers<string[]>()
  const aborted = () => result.reject(signal.reason)
  signal.addEventListener('abort', aborted, { once: true })
  let mux: ReturnType<NativeTunnel['openMux']> | undefined
  try {
    mux = tunnel.openMux(text => {
      try {
        if (Buffer.byteLength(text) > maxBytes) throw new Error('Native workspace baseline exceeds directory limit')
        const frame = JSON.parse(text) as { type?: string; streamId?: string; value?: { type?: string; value?: { archivedSessionIds?: unknown } } }
        if (frame.streamId !== streamId || frame.type !== 'item' || frame.value?.type !== 'baseline') throw new Error('Native workspace baseline rejected')
        const ids = frame.value.value?.archivedSessionIds
        if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id || id.length > 1024)
          || new Set(ids).size !== ids.length) throw new Error('Invalid native archive metadata')
        result.resolve(ids)
      } catch (error) { result.reject(error) }
    }, signal)
    mux.send(JSON.stringify({ type: 'open', streamId, endpoint: 'workspace/follow', payload: { args: {} } }))
    return await result.promise
  } finally {
    signal.removeEventListener('abort', aborted)
    if (mux) {
      try { mux.send(JSON.stringify({ type: 'cancel', streamId })) } catch { /* Parent cancellation may have already closed this mux. */ }
      mux.close()
    }
  }
}
/** Directory-only projection; unavailable archive metadata never becomes an openable link. */
export async function nativeDirectoryList(tunnel: NativeTunnel, origin: string, signal: AbortSignal): Promise<unknown> {
  const stop = new AbortController(), combined = AbortSignal.any([signal, stop.signal])
  try {
    const [sessions, archivedSessionIds] = await Promise.all([nativeList(tunnel, origin, combined), nativeArchivedSessions(tunnel, combined)])
    if (!sessions || typeof sessions !== 'object' || !('items' in sessions)) throw new Error('Invalid native list')
    return { items: sessions.items, archivedSessionIds }
  } finally { stop.abort() }
}
/** Global admission limit across all pages; no unbounded request queue. */
export class DirectoryAdmission {
  private active = 0
  constructor(private readonly maximum = 8) {}
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum) throw new Error('Directory busy; refresh to retry')
    this.active++
    try { return await operation() } finally { this.active-- }
  }
  get inflight(): number { return this.active }
}
