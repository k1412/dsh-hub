import { randomUUID } from 'node:crypto'
import WebSocket, { type RawData } from 'ws'

export type ControlHandler = (method: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
/** Negotiated, bounded RPC on the authenticated native carrier. No automatic write retries. */
export class ControlRPC {
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private active = new Map<string, AbortController>()
  private seen = new Set<string>()
  private dead = false
  constructor(private ws: WebSocket, private handler: ControlHandler, private timeout = 30_000) {
    ws.on('message', this.message); ws.once('close', this.close)
  }
  get health() { return { pending: this.pending.size, active: this.active.size, replayEntries: this.seen.size } }
  private send(frame: Record<string, unknown>) {
    const text = JSON.stringify({ control: 1, ...frame })
    if (this.dead || this.ws.readyState !== WebSocket.OPEN) throw new Error('control-disconnected')
    if (Buffer.byteLength(text) > 65536 || this.ws.bufferedAmount > 262144) throw new Error('control-capacity')
    this.ws.send(text)
  }
  call(method: string, input: Record<string, unknown>): Promise<unknown> {
    if (this.pending.size >= 16) return Promise.reject(new Error('control-capacity'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('control-timeout; query job before retrying')); }, this.timeout)
      timer.unref(); this.pending.set(id, { resolve, reject, timer })
      try { this.send({ id, method, input }) } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  private message = (raw: RawData, binary: boolean) => {
    if (binary || this.dead) return
    let frame: Record<string, unknown>
    try { frame = JSON.parse(raw.toString()) as Record<string, unknown> } catch { return }
    if (frame?.control !== 1) return
    const id = frame.id
    if (typeof id !== 'string' || id.length > 64 || Buffer.byteLength(raw.toString()) > 65536) { this.ws.close(1008, 'Invalid control'); return }
    if ('result' in frame || 'error' in frame) {
      const pending = this.pending.get(id); if (!pending) return
      this.pending.delete(id); clearTimeout(pending.timer)
      if ('error' in frame) pending.reject(new Error('Remote control refused or failed')); else pending.resolve(frame.result)
      return
    }
    if (this.seen.has(id) || this.active.size >= 8 || this.seen.size >= 10000 || typeof frame.method !== 'string' || !frame.input || typeof frame.input !== 'object' || Array.isArray(frame.input)) {
      try { this.send({ id, error: 'replay-or-capacity' }) } catch { /* closing */ } return
    }
    this.seen.add(id)
    const abort = new AbortController(); this.active.set(id, abort)
    const timer = setTimeout(() => abort.abort(), this.timeout); timer.unref()
    void Promise.resolve().then(() => this.handler(frame.method as string, frame.input as Record<string, unknown>, abort.signal)).then(result => {
      if (!abort.signal.aborted) this.send({ id, result: result ?? null })
    }).catch(() => { try { this.send({ id, error: 'refused-or-failed' }) } catch { /* closed */ } }).finally(() => { clearTimeout(timer); this.active.delete(id) })
  }
  close = () => {
    if (this.dead) return
    this.dead = true; this.ws.off('message', this.message); this.ws.off('close', this.close)
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('control-disconnected')) }
    for (const abort of this.active.values()) abort.abort()
    this.pending.clear(); this.active.clear(); this.seen.clear()
  }
}
