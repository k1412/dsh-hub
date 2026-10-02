import WebSocket, { type RawData } from 'ws';

export const PROTOCOL_VERSION = 1;
export const STREAM_WINDOW_BYTES = 32 * 1024;
const MAX_CONTROL_BYTES = 256 * 1024;
const MAX_SOCKET_BUFFER = 8 * 1024 * 1024;
export interface TransportOptions { requestTimeoutMs?: number; maxChannels?: number }
export interface GatewayHealth { connected: boolean; inflightRequests: number; openMuxes: number }
export interface GatewaySurface {
  handle(request: Request): Promise<Response>;
  openMux(send: (text: string) => void, signal: AbortSignal): { receive(text: string): void; close(): void };
}
export type TransportErrorCode = 'DISCONNECTED' | 'TIMEOUT' | 'PROTOCOL' | 'REMOTE' | 'CAPACITY';
export class GatewayTransportError extends Error {
  readonly status: 502 | 504;
  constructor(readonly code: TransportErrorCode, message: string) {
    super(message); this.name = 'GatewayTransportError'; this.status = code === 'TIMEOUT' ? 504 : 502;
  }
}
type Frame = { v: 1; type: string; id: number; [key: string]: unknown };
type Call = {
  kind: 'call'; id: number; abort: AbortController; timer: ReturnType<typeof setTimeout>;
  method: string; resolve?: (response: Response) => void; reject?: (reason: unknown) => void;
  incoming?: ReadableStreamDefaultController<Uint8Array>; incomingStarted: boolean; incomingEnded: boolean;
  receiveCredit: number; sendCredit: number; wake?: () => void; reader?: ReadableStreamDefaultReader<Uint8Array>;
  outgoingStarted: boolean; outgoingEnded: boolean; cleanup?: () => void;
};
type Mux = { kind: 'mux'; id: number; abort: AbortController; receive: (text: string) => void; dispose: () => void; cleanup?: () => void };
type Channel = Call | Mux;
const fault = (message: string) => new GatewayTransportError('PROTOCOL', message);
function headers(value: unknown): [string, string][] {
  if (!Array.isArray(value) || value.length > 512) throw fault('Invalid headers');
  return value.map((pair: unknown) => {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') throw fault('Invalid header');
    return [pair[0], pair[1]];
  });
}
function headerPairs(value: Headers): [string, string][] {
  const result: [string, string][] = [];
  value.forEach((v, k) => { if (k !== 'set-cookie') result.push([k, v]); });
  for (const cookie of value.getSetCookie()) result.push(['set-cookie', cookie]);
  return result;
}
function bytes(data: RawData): Buffer {
  return Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

class Peer {
  readonly channels = new Map<number, Channel>();
  private nextId = 0;
  private highestId = 0;
  private dead = false;
  private readonly timeout: number;
  private readonly limit: number;
  constructor(readonly ws: WebSocket, readonly surface: GatewaySurface | undefined, options: TransportOptions) {
    this.timeout = options.requestTimeoutMs ?? 120_000;
    this.limit = options.maxChannels ?? 128;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 2_147_483_647 || !Number.isSafeInteger(this.limit) || this.limit < 1 || this.limit > 4096) throw new RangeError('Invalid transport limits');
    ws.on('message', this.onMessage);
    ws.on('close', this.onClose);
    ws.on('error', this.onError);
  }
  get isOpen() { return !this.dead && this.ws.readyState === WebSocket.OPEN; }
  get health(): GatewayHealth {
    let inflightRequests = 0, openMuxes = 0;
    for (const c of this.channels.values()) {
      if (c.kind === 'call') inflightRequests++; else openMuxes++;
    }
    return { connected: this.isOpen, inflightRequests, openMuxes };
  }
  private onClose = () => this.shutdown(new GatewayTransportError('DISCONNECTED', 'Node connection closed'));
  private onError = () => this.shutdown(new GatewayTransportError('DISCONNECTED', 'Node connection failed'));
  close() { this.shutdown(new GatewayTransportError('DISCONNECTED', 'Gateway closed')); }
  private shutdown(error: Error) {
    if (this.dead) return;
    this.dead = true;
    for (const c of [...this.channels.values()]) this.finish(c, error);
    this.ws.off('message', this.onMessage);
    this.ws.off('close', this.onClose);
    // Keep the error listener until close: ws can emit an error while terminating.
    this.ws.once('close', () => this.ws.off('error', this.onError));
    if (this.ws.readyState !== WebSocket.CLOSED) this.ws.terminate();
    else this.ws.off('error', this.onError);
  }
  private sendRaw(data: string | Buffer) {
    if (!this.isOpen) throw new GatewayTransportError('DISCONNECTED', 'Node is disconnected');
    if (this.ws.bufferedAmount + Buffer.byteLength(data) > MAX_SOCKET_BUFFER) {
      const error = new GatewayTransportError('CAPACITY', 'Transport write buffer exhausted'); this.shutdown(error); throw error;
    }
    this.ws.send(data, error => { if (error) this.shutdown(new GatewayTransportError('DISCONNECTED', 'Transport write failed')); });
  }
  private send(type: string, id: number, fields: Record<string, unknown> = {}) {
    const data = JSON.stringify({ v: 1, type, id, ...fields });
    if (Buffer.byteLength(data) > MAX_CONTROL_BYTES) throw fault('Control frame too large');
    this.sendRaw(data);
  }
  private available() {
    if (!this.isOpen) throw new GatewayTransportError('DISCONNECTED', 'Node is disconnected');
    if (this.channels.size >= this.limit) throw new GatewayTransportError('CAPACITY', 'Too many transport channels');
  }
  private allocate() {
    this.available();
    if (this.nextId >= 0xffffffff) throw new GatewayTransportError('CAPACITY', 'Channel identifiers exhausted');
    this.highestId = ++this.nextId;
    return this.nextId;
  }
  private call(id: number, method: string): Call {
    const abort = new AbortController();
    const c: Call = { kind: 'call', id, method, abort, timer: setTimeout(() => {
      this.cancel(c, new GatewayTransportError('TIMEOUT', 'Gateway request timed out'), true);
    }, this.timeout), incomingStarted: false, incomingEnded: false, receiveCredit: 0, sendCredit: 0, outgoingStarted: false, outgoingEnded: false };
    c.timer.unref(); this.channels.set(id, c); return c;
  }
  private finish(c: Channel, error?: unknown) {
    if (!this.channels.delete(c.id)) return;
    c.cleanup?.();
    c.abort.abort(error);
    if (c.kind === 'mux') { try { c.dispose(); } catch { /* Cleanup must not prevent other channels closing. */ } return; }
    clearTimeout(c.timer);
    c.wake?.();
    if (c.reader) void c.reader.cancel(error).catch(() => {});
    if (error) {
      c.reject?.(error);
      try { c.incoming?.error(error); } catch { /* Already closed. */ }
    } else if (!c.incomingEnded) {
      try { c.incoming?.close(); } catch { /* Already closed. */ }
    }
  }
  private cancel(c: Channel, error: unknown, timeout = false) {
    if (!this.channels.has(c.id)) return;
    try { this.send(timeout ? 'error' : 'cancel', c.id, timeout ? { code: 'TIMEOUT' } : {}); }
    catch { /* Local cleanup still runs on disconnect. */ }
    this.finish(c, error);
  }
  private incoming(c: Call): ReadableStream<Uint8Array> {
    c.incomingStarted = true;
    return new ReadableStream<Uint8Array>({
      start: controller => { c.incoming = controller; },
      pull: () => {
        if (c.incomingEnded || c.abort.signal.aborted || c.receiveCredit !== 0) return;
        c.receiveCredit = STREAM_WINDOW_BYTES;
        try { this.send('credit', c.id, { bytes: STREAM_WINDOW_BYTES }); }
        catch (error) { this.finish(c, error); }
      },
      cancel: reason => this.cancel(c, reason ?? new DOMException('Body cancelled', 'AbortError')),
    }, { highWaterMark: 0 });
  }
  private async outgoing(c: Call, body: ReadableStream<Uint8Array> | null) {
    c.outgoingStarted = true;
    try {
      if (body) {
        const reader = body.getReader(); c.reader = reader;
        while (!c.abort.signal.aborted) {
          // Never pull the producer until the consumer has granted space.
          while (!c.sendCredit && !c.abort.signal.aborted) await new Promise<void>(resolve => { c.wake = resolve; });
          if (c.abort.signal.aborted) return;
          const part = await reader.read();
          if (part.done) break;
          if (!(part.value instanceof Uint8Array)) throw new Error('Body must produce bytes');
          for (let offset = 0; offset < part.value.byteLength;) {
            while (!c.sendCredit && !c.abort.signal.aborted) await new Promise<void>(resolve => { c.wake = resolve; });
            if (c.abort.signal.aborted) return;
            const count = Math.min(c.sendCredit, STREAM_WINDOW_BYTES, part.value.byteLength - offset);
            const frame = Buffer.allocUnsafe(5 + count); frame[0] = 1; frame.writeUInt32BE(c.id, 1);
            frame.set(part.value.subarray(offset, offset + count), 5);
            c.sendCredit -= count; offset += count; this.sendRaw(frame);
          }
        }
      }
      if (c.abort.signal.aborted) return;
      c.outgoingEnded = true; this.send('end', c.id);
      if (this.surface) this.finish(c);
    } catch {
      if (!c.abort.signal.aborted) {
        try { this.send('error', c.id, { code: 'REMOTE' }); } catch { /* Disconnected. */ }
        this.finish(c, new GatewayTransportError('REMOTE', 'Surface stream failed'));
      }
    }
  }
  fetch(request: Request): Promise<Response> {
    if (request.signal.aborted) return Promise.reject(request.signal.reason);
    let c: Call;
    try { c = this.call(this.allocate(), request.method); } catch (error) { return Promise.reject(error); }
    return new Promise<Response>((resolve, reject) => {
      c.resolve = resolve; c.reject = reject;
      const abort = () => this.cancel(c, request.signal.reason);
      request.signal.addEventListener('abort', abort, { once: true });
      c.cleanup = () => request.signal.removeEventListener('abort', abort);
      try {
        this.send('request', c.id, { url: request.url, method: request.method, headers: headerPairs(request.headers), body: request.body !== null });
        void this.outgoing(c, request.body);
      } catch (error) { this.finish(c, error); }
    });
  }
  openMux(receive: (text: string) => void, signal?: AbortSignal) {
    if (signal?.aborted) throw signal.reason;
    const id = this.allocate();
    const c: Mux = { kind: 'mux', id, abort: new AbortController(), receive, dispose: () => {} };
    this.channels.set(id, c);
    const close = () => this.cancel(c, new DOMException('Mux closed', 'AbortError'));
    signal?.addEventListener('abort', close, { once: true });
    c.cleanup = () => signal?.removeEventListener('abort', close);
    try { this.send('mux-open', id); } catch (error) { this.finish(c, error); throw error; }
    return { send: (text: string) => {
      if (!this.channels.has(id)) throw new GatewayTransportError('DISCONNECTED', 'Mux is closed');
      if (typeof text !== 'string') throw new TypeError('Mux message must be text');
      try { this.send('mux-text', id, { text }); } catch (error) { this.cancel(c, error); throw error; }
    }, close };
  }
  private onMessage = (raw: RawData, binary: boolean) => {
    try {
      const data = bytes(raw);
      if (binary) {
        if (data.length < 6 || data.length > STREAM_WINDOW_BYTES + 5 || data[0] !== 1) throw fault('Invalid body frame');
        const id = data.readUInt32BE(1), c = this.lookup(id);
        if (!c) return;
        if (c.kind !== 'call' || !c.incomingStarted || c.incomingEnded || data.length - 5 > c.receiveCredit) throw fault('Unexpected body bytes');
        c.receiveCredit -= data.length - 5;
        if (!c.incoming) throw fault('Missing body receiver');
        c.incoming.enqueue(new Uint8Array(data.subarray(5)));
        return;
      }
      if (data.length > MAX_CONTROL_BYTES) throw fault('Control frame too large');
      const value: unknown = JSON.parse(data.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('Invalid envelope');
      const f = value as Frame;
      if (f.v !== 1 || !Number.isSafeInteger(f.id) || f.id < 1 || f.id > 0xffffffff || typeof f.type !== 'string') throw fault('Invalid envelope');
      if (!['request', 'response', 'credit', 'end', 'cancel', 'error', 'mux-open', 'mux-text'].includes(f.type)) throw fault('Unknown frame');
      if (f.type === 'request' || f.type === 'mux-open') { this.openRemote(f); return; }
      // Validate payload even for retired channels; late valid frames can race cancellation.
      if (f.type === 'credit' && (!Number.isSafeInteger(f.bytes) || (f.bytes as number) < 1 || (f.bytes as number) > STREAM_WINDOW_BYTES)) throw fault('Invalid credit');
      if (f.type === 'mux-text' && typeof f.text !== 'string') throw fault('Invalid mux text');
      if (f.type === 'error' && f.code !== 'TIMEOUT' && f.code !== 'REMOTE') throw fault('Invalid error');
      const c = this.lookup(f.id); if (!c) return;
      if (f.type === 'cancel') { this.finish(c, new DOMException('Remote cancelled', 'AbortError')); return; }
      if (f.type === 'error') { this.finish(c, new GatewayTransportError(f.code as 'TIMEOUT' | 'REMOTE', 'Remote operation failed')); return; }
      if (c.kind === 'mux') {
        if (f.type !== 'mux-text') throw fault('Invalid mux operation');
        try { c.receive(f.text as string); } catch { this.cancel(c, new GatewayTransportError('REMOTE', 'Mux receiver failed')); }
        return;
      }
      if (f.type === 'credit') {
        if (!c.outgoingStarted || c.sendCredit + (f.bytes as number) > STREAM_WINDOW_BYTES) throw fault('Unexpected credit');
        if (!c.outgoingEnded) { c.sendCredit += f.bytes as number; c.wake?.(); }
      } else if (f.type === 'response') {
        if (this.surface || c.incomingStarted || typeof f.body !== 'boolean' || !Number.isInteger(f.status) || (f.status as number) < 200 || (f.status as number) > 599 || typeof f.statusText !== 'string') throw fault('Invalid response');
        const hs = headers(f.headers);
        if (f.body && (c.method === 'HEAD' || [204, 205, 304].includes(f.status as number))) throw fault('Body on bodyless response');
        const body = f.body ? this.incoming(c) : null;
        c.incomingStarted = true;
        if (!c.resolve) throw fault('Missing response receiver');
        c.resolve(new Response(body, { status: f.status as number, statusText: f.statusText, headers: hs }));
      } else if (f.type === 'end') {
        if (!c.incomingStarted || c.incomingEnded) throw fault('Unexpected stream end');
        c.incomingEnded = true; c.incoming?.close();
        if (!this.surface) this.finish(c);
      } else throw fault('Invalid request operation');
    } catch (error) { this.shutdown(error instanceof GatewayTransportError ? error : fault('Malformed transport frame')); }
  };
  private lookup(id: number): Channel | undefined {
    if (id < 1 || id > this.highestId) throw fault('Unknown channel');
    return this.channels.get(id);
  }
  private openRemote(f: Frame) {
    if (!this.surface || f.id <= this.highestId) throw fault('Invalid channel open');
    this.available(); this.highestId = f.id;
    if (f.type === 'mux-open') {
      const c: Mux = { kind: 'mux', id: f.id, abort: new AbortController(), receive: () => {}, dispose: () => {} };
      this.channels.set(c.id, c);
      try {
        const mux = this.surface.openMux(text => {
          if (!this.channels.has(c.id)) return;
          try { this.send('mux-text', c.id, { text }); } catch (error) { this.cancel(c, error); }
        }, c.abort.signal);
        if (c.abort.signal.aborted) { mux.close(); return; }
        c.receive = text => mux.receive(text); c.dispose = () => mux.close();
      } catch (error) { this.cancel(c, error); }
      return;
    }
    if (typeof f.url !== 'string' || f.url.length > 32_768 || typeof f.method !== 'string' || f.method.length > 64 || typeof f.body !== 'boolean') throw fault('Invalid request');
    const hs = headers(f.headers);
    const c = this.call(f.id, f.method);
    const body = f.body ? this.incoming(c) : null; c.incomingStarted = true;
    const init: RequestInit & { duplex: 'half' } = { method: f.method, headers: hs, body, signal: c.abort.signal, duplex: 'half' };
    const request = new Request(f.url, init);
    void this.handle(c, request);
  }
  private async handle(c: Call, request: Request) {
    try {
      if (!this.surface) throw fault('Missing native surface');
      const response = await this.surface.handle(request);
      if (c.abort.signal.aborted) { await response.body?.cancel().catch(() => {}); return; }
      const body = c.method === 'HEAD' || [204, 205, 304].includes(response.status) ? null : response.body;
      this.send('response', c.id, { status: response.status, statusText: response.statusText, headers: headerPairs(response.headers), body: body !== null });
      if (!body) await response.body?.cancel();
      await this.outgoing(c, body);
    } catch {
      if (!c.abort.signal.aborted) {
        try { this.send('error', c.id, { code: 'REMOTE' }); } catch { /* Disconnected. */ }
        this.finish(c, new GatewayTransportError('REMOTE', 'Surface request failed'));
      }
    }
  }
}

/** One authenticated node connection, with no reconnect or write retries. */
export class GatewayTunnel {
  private readonly peer: Peer;
  constructor(ws: WebSocket, options: TransportOptions = {}) { this.peer = new Peer(ws, undefined, options); }
  get isOpen() { return this.peer.isOpen; }
  get health() { return this.peer.health; }
  fetch(request: Request) { return this.peer.fetch(request); }
  openMux(sendToBrowser: (text: string) => void, signal?: AbortSignal) { return this.peer.openMux(sendToBrowser, signal); }
  close() { this.peer.close(); }
}
/** Attach the installed Runtime surface to an already authenticated outbound socket. */
export function serveSurface(ws: WebSocket, surface: GatewaySurface, options: TransportOptions = {}): { close(): void; readonly health: GatewayHealth } {
  const peer = new Peer(ws, surface, options);
  return { close: () => peer.close(), get health() { return peer.health; } };
}
