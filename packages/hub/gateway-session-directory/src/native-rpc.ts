import { randomUUID } from 'node:crypto'
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
