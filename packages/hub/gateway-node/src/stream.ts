/** Public native Gateway carrier contract, intentionally independent of business endpoints. */
export interface NativeWireStream {
  open(endpoint: string, payload: unknown, uplink: AsyncIterable<unknown>, peer: undefined, signal: AbortSignal): Promise<AsyncIterable<unknown>>
  failure(error: unknown): { code: string; message: string; details: object }
}

/** Bounded uplink with producer completion and cancellation distinct from an empty queue. */
class Inbox implements AsyncIterable<unknown> {
  private queue: Array<{ value: unknown; bytes: number }> = []
  private bytes = 0
  private ended = false
  private returned = false
  private consumed = false
  private failure?: unknown
  private waiter: { resolve: (item: IteratorResult<unknown>) => void; reject: (error: unknown) => void } | undefined
  constructor(private readonly overflow: (error: Error) => void) {}
  push(value: unknown, bytes: number): void {
    if (this.returned || this.failure) return
    if (this.ended) { const error = new Error('Native stream received an uplink item after end'); this.fail(error); this.overflow(error); return }
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve({ value, done: false }); return }
    if (this.bytes + bytes > 256 * 1024) { const error = new Error('Native stream uplink exceeded 256 KiB'); this.fail(error); this.overflow(error); return }
    this.queue.push({ value, bytes }); this.bytes += bytes
  }
  end(): void {
    this.ended = true
    if (this.waiter) { this.waiter.resolve({ done: true, value: undefined }); this.waiter = undefined }
  }
  fail(error: unknown): void {
    this.failure = error; this.queue = []; this.bytes = 0; this.ended = true
    this.waiter?.reject(error); this.waiter = undefined
  }
  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    if (this.consumed) throw new Error('Native stream uplink has one consumer')
    this.consumed = true
    return {
      next: async () => {
        if (this.returned) return { value: undefined, done: true }
        if (this.failure) throw this.failure
        const item = this.queue.shift()
        if (item) { this.bytes -= item.bytes; return { value: item.value, done: false } }
        if (this.ended) return { value: undefined, done: true }
        if (this.waiter) throw new Error('Native stream uplink has one pending read')
        return new Promise<IteratorResult<unknown>>((resolve, reject) => { this.waiter = { resolve, reject } })
      },
      return: async () => { this.returned = true; this.queue = []; this.bytes = 0; this.end(); return { value: undefined, done: true } },
    }
  }
}

interface Active { abort: AbortController; inbox: Inbox; done: Promise<void>; failure?: Error }

/** Native open/item/end/cancel mux framing; no endpoint names or arguments are rewritten. */
export class NativeMux {
  private readonly streams = new Map<string, Active>()
  private closed = false
  private writes: Promise<void> = Promise.resolve()
  private readonly onAbort = (): void => { void this.close() }
  constructor(private readonly wire: NativeWireStream, private readonly sendText: (text: string) => Promise<void> | void, private readonly signal: AbortSignal) {
    if (signal.aborted) this.closed = true
    else signal.addEventListener('abort', this.onAbort, { once: true })
  }
  receive(text: string): void {
    if (this.closed) throw new Error('Native mux is closed')
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Native mux frame exceeds 1 MiB')
    const frame = JSON.parse(text) as Record<string, unknown>
    if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.streamId !== 'string' || !frame.streamId) throw new Error('Invalid native stream frame')
    const streamId = frame.streamId
    const keys = Object.keys(frame).sort().join(',')
    if (frame.type === 'open') {
      if (keys !== 'endpoint,payload,streamId,type' || typeof frame.endpoint !== 'string' || !frame.endpoint) throw new Error('Invalid native stream open')
      if (this.streams.has(streamId)) throw new Error('Duplicate native stream identity')
      if (this.streams.size >= 256) throw new Error('Too many native streams')
      const abort = new AbortController()
      const inbox = new Inbox((error) => { active.failure = error; abort.abort(error) })
      const active: Active = { abort, inbox, done: Promise.resolve() }
      this.streams.set(streamId, active)
      active.done = this.pump(streamId, frame.endpoint, frame.payload, active).finally(() => { this.streams.delete(streamId) })
      return
    }
    const active = this.streams.get(streamId)
    if (frame.type === 'item' && (keys === 'streamId,type,value' || keys === 'streamId,type')) { active?.inbox.push(frame.value, Buffer.byteLength(text)); return }
    if (frame.type === 'end' && keys === 'streamId,type') { active?.inbox.end(); return }
    if (frame.type === 'cancel' && keys === 'streamId,type') {
      const reason = new Error('Native stream cancelled')
      active?.abort.abort(reason); active?.inbox.fail(reason); return
    }
    throw new Error('Invalid native stream frame')
  }
  private async pump(streamId: string, endpoint: string, payload: unknown, active: Active): Promise<void> {
    try {
      const source = await this.wire.open(endpoint, payload, active.inbox, undefined, active.abort.signal)
      for await (const value of source) {
        if (active.abort.signal.aborted || this.closed) break
        await this.send({ type: 'item', streamId, value })
      }
      if (active.failure && !this.closed) await this.send({ type: 'error', streamId, error: this.wire.failure(active.failure) })
      else if (!active.abort.signal.aborted && !this.closed) await this.send({ type: 'end', streamId })
    } catch (error) {
      if ((!active.abort.signal.aborted || active.failure) && !this.closed) {
        try { await this.send({ type: 'error', streamId, error: this.wire.failure(active.failure ?? error) }) } catch { void this.close() }
      }
    } finally { active.inbox.end() }
  }
  private send(frame: unknown): Promise<void> {
    const text = JSON.stringify(frame)
    const operation = this.writes.then(async () => { if (!this.closed) await this.sendText(text) })
    this.writes = operation.catch(() => {})
    return operation
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.signal.removeEventListener('abort', this.onAbort)
    const active = [...this.streams.values()]
    for (const stream of active) { const reason = new Error('Native mux disconnected'); stream.abort.abort(reason); stream.inbox.fail(reason) }
    await Promise.all(active.map((stream) => stream.done))
    this.streams.clear()
  }
}
