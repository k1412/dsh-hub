import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { BINARY_TEST_TIMEOUT_MS, BINARY_TRANSFER_TIMEOUT_MS, verifyBinaryTransfer } from './binary-probe.ts';
import WebSocket, { WebSocketServer } from 'ws';
import { GatewayTunnel, serveSurface, STREAM_WINDOW_BYTES, type GatewaySurface, type TransportOptions } from '../src/index.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(fn => fn())); });
const idleMux: GatewaySurface['openMux'] = () => ({ receive() {}, close() {} });
async function pair(surface: Partial<GatewaySurface> = {}, options: TransportOptions = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 256 * 1024 });
  await once(server, 'listening');
  const accepted = once(server, 'connection');
  const address = server.address(); if (typeof address === 'string' || !address) throw new Error('No address');
  const node = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const [hub] = await accepted as [WebSocket];
  await once(node, 'open');
  const service = serveSurface(node, { handle: async () => new Response('ok'), openMux: idleMux, ...surface }, options);
  const tunnel = new GatewayTunnel(hub, options);
  cleanups.push(async () => { tunnel.close(); service.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { tunnel, node, hub, service };
}
function upload(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  return new Request('http://runtime.invalid/native/files?raw=%2F', { method: 'POST', body, duplex: 'half', ...(signal ? { signal } : {}) } as RequestInit);
}
function fixture(data: Uint8Array, size = 8191) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === data.length) { controller.close(); return; }
    controller.enqueue(data.slice(offset, offset + size)); offset = Math.min(data.length, offset + size);
  } }, { highWaterMark: 0 });
}
async function eventually(predicate: () => boolean) { await expect.poll(predicate, { timeout: 2000 }).toBe(true); }

describe('native gateway transport over real sockets', () => {
  it('streams arbitrary binary uploads/downloads above the window and preserves native metadata', async () => {
    const data = randomBytes(STREAM_WINDOW_BYTES * 19 + 37);
    let seen = '';
    const { tunnel } = await pair({ handle: async request => {
      seen = `${request.method} ${request.url}`;
      expect(Buffer.from(await request.arrayBuffer()).equals(data), 'Native upload bytes differ').toBe(true);
      return new Response(fixture(data, 100003), { status: 206, headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="binary.dat"', 'x-native': 'yes' } });
    } }, { requestTimeoutMs: BINARY_TRANSFER_TIMEOUT_MS });
    const response = await verifyBinaryTransfer('transport upload + download', signal => tunnel.fetch(upload(fixture(data), signal)), data, () => tunnel.health);
    expect(response.status).toBe(206);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="binary.dat"');
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('x-native')).toBe('yes');
    expect(seen).toBe('POST http://runtime.invalid/native/files?raw=%2F');
    await eventually(() => tunnel.health.inflightRequests === 0);
  }, BINARY_TEST_TIMEOUT_MS);

  it('does not pull a download producer while the browser is stalled', async () => {
    let produced = 0;
    const { tunnel } = await pair({ handle: async () => new Response(new ReadableStream<Uint8Array>({ pull(c) { produced++; c.enqueue(new Uint8Array(STREAM_WINDOW_BYTES)); } }, { highWaterMark: 0 })) });
    const response = await tunnel.fetch(new Request('http://runtime.invalid/stream'));
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(produced).toBe(0);
    const reader = response.body!.getReader();
    expect((await reader.read()).value!.length).toBe(STREAM_WINDOW_BYTES);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(produced).toBe(1);
    await reader.cancel();
    await eventually(() => tunnel.health.inflightRequests === 0);
  });

  it('does not pull uploads before the native surface reads and aborts the surface', async () => {
    let produced = 0, aborted = false;
    const { tunnel, service } = await pair({ handle: request => new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => { aborted = true; reject(request.signal.reason); }, { once: true });
    }) });
    const ac = new AbortController();
    const pending = tunnel.fetch(upload(new ReadableStream<Uint8Array>({ pull(c) { produced++; c.enqueue(new Uint8Array(STREAM_WINDOW_BYTES)); } }, { highWaterMark: 0 }), ac.signal));
    const failure = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(produced).toBe(0); ac.abort(); await failure;
    await eventually(() => aborted && service.health.inflightRequests === 0);
  });

  it('isolates concurrent requests and two muxes on each of two nodes', async () => {
    const make = async (label: string) => pair({
      handle: async request => { await new Promise(resolve => setTimeout(resolve, Math.random() * 15)); return new Response(`${label}:${new URL(request.url).pathname}`); },
      openMux: send => ({ receive: text => send(`${label}:${text}`), close() {} }),
    });
    const [a, b] = await Promise.all([make('a'), make('b')]);
    const results: string[][] = [[], [], [], []];
    const muxes = [a, a, b, b].map((p, i) => p.tunnel.openMux(text => results[i]!.push(text)));
    const payloads = ['{"native":"α\\n"}', ' raw\ntext ', '\u0000', '😀'];
    muxes.forEach((mux, i) => mux.send(payloads[i]!));
    const requests = Array.from({ length: 30 }, async (_, i) => {
      const p = i % 2 ? a : b;
      expect(await (await p.tunnel.fetch(new Request(`http://runtime.invalid/${i}`))).text()).toBe(`${i % 2 ? 'a' : 'b'}:/${i}`);
    });
    await Promise.all(requests);
    await eventually(() => results.every(messages => messages.length === 1));
    expect(results).toEqual(payloads.map((text, i) => [`${i < 2 ? 'a' : 'b'}:${text}`]));
    muxes.forEach(mux => mux.close());
    await eventually(() => a.service.health.openMuxes === 0 && b.service.health.openMuxes === 0);
  });

  it('fails interrupted calls without retrying and aborts native work', async () => {
    let calls = 0, aborted = 0;
    const { tunnel, node } = await pair({ handle: request => {
      calls++; request.signal.addEventListener('abort', () => aborted++);
      return new Promise(() => {});
    } });
    const pending = Array.from({ length: 4 }, () => tunnel.fetch(new Request('http://runtime.invalid/write', { method: 'POST', body: 'data' })));
    const settled = Promise.allSettled(pending);
    await eventually(() => calls === 4); node.terminate();
    for (const result of await settled) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'DISCONNECTED', status: 502 });
    }
    await eventually(() => aborted === 4);
    expect(calls).toBe(4); expect(tunnel.health.connected).toBe(false);
  });

  it('bounds a stalled request with a 504 error and aborts native work', async () => {
    let aborted = false;
    const { tunnel } = await pair({ handle: request => { request.signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); } }, { requestTimeoutMs: 60 });
    await expect(tunnel.fetch(new Request('http://runtime.invalid/slow'))).rejects.toMatchObject({ code: 'TIMEOUT', status: 504 });
    await eventually(() => aborted);
  });

  it('handles HEAD and 204 without constructing forbidden response bodies', async () => {
    const { tunnel } = await pair({ handle: async request => request.method === 'HEAD'
      ? new Response('ignored', { headers: { 'content-length': '7' } })
      : new Response(null, { status: 204 }) });
    const head = await tunnel.fetch(new Request('http://runtime.invalid/head', { method: 'HEAD' }));
    expect(head.body).toBeNull(); expect(head.headers.get('content-length')).toBe('7');
    const empty = await tunnel.fetch(new Request('http://runtime.invalid/empty'));
    expect(empty.status).toBe(204); expect(empty.body).toBeNull();
    await eventually(() => tunnel.health.inflightRequests === 0);
  });

  it.each(['{"v":2,"id":1,"type":"end"}', '{bad', '{"v":1,"id":1,"type":"credit","bytes":999999}'])('cleans all inflight work on malformed protocol input %s', async frame => {
    const { tunnel, node, service } = await pair({ handle: async () => new Promise(() => {}) });
    const pending = tunnel.fetch(new Request('http://runtime.invalid/wait'));
    const failure = expect(pending).rejects.toMatchObject({ code: 'PROTOCOL', status: 502 });
    await eventually(() => service.health.inflightRequests === 1);
    node.send(frame); await failure;
    await eventually(() => service.health.inflightRequests === 0 && !service.health.connected);
    expect(tunnel.health.inflightRequests).toBe(0);
  });

  it('cancels a native streaming download when the browser aborts after headers', async () => {
    let cancelled = false, aborted = false;
    const { tunnel } = await pair({ handle: async request => {
      request.signal.addEventListener('abort', () => { aborted = true; });
      return new Response(new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array([1, 2])); }, cancel() { cancelled = true; } }, { highWaterMark: 0 }));
    } });
    const ac = new AbortController();
    const response = await tunnel.fetch(new Request('http://runtime.invalid/events', { signal: ac.signal }));
    const reader = response.body!.getReader(); await reader.read(); ac.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    await eventually(() => cancelled && aborted);
  });

  it('rejects unsolicited binary bytes and aborts every native call', async () => {
    let aborted = false;
    const { tunnel, hub, service } = await pair({ handle: request => {
      request.signal.addEventListener('abort', () => { aborted = true; });
      return new Promise(() => {});
    } });
    const pending = tunnel.fetch(new Request('http://runtime.invalid/wait'));
    const failure = expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' });
    await eventually(() => service.health.inflightRequests === 1);
    // Valid binary envelope, but there is no upload and no granted credit.
    hub.send(Buffer.from([1, 0, 0, 0, 1, 255]));
    await failure;
    await eventually(() => aborted && !service.health.connected);
  });

  it('times out stalled streaming bodies after response headers', async () => {
    let cancelled = false;
    const { tunnel } = await pair({ handle: async () => new Response(new ReadableStream<Uint8Array>({
      pull() { return new Promise(() => {}); }, cancel() { cancelled = true; },
    }, { highWaterMark: 0 })) }, { requestTimeoutMs: 100 });
    const response = await tunnel.fetch(new Request('http://runtime.invalid/slow-body'));
    await expect(response.arrayBuffer()).rejects.toMatchObject({ code: 'TIMEOUT', status: 504 });
    await eventually(() => cancelled);
  });

  it('bounds active channels and releases muxes on abort without disturbing requests', async () => {
    let muxClosed = 0;
    const { tunnel, service } = await pair({ openMux: () => ({ receive() {}, close() { muxClosed++; } }) }, { maxChannels: 2 });
    const ac = new AbortController();
    const mux = tunnel.openMux(() => {}, ac.signal);
    tunnel.openMux(() => {});
    await expect(tunnel.fetch(new Request('http://runtime.invalid/full'))).rejects.toMatchObject({ code: 'CAPACITY', status: 502 });
    ac.abort();
    expect(() => mux.send('late')).toThrow('Mux is closed');
    await eventually(() => muxClosed === 1 && service.health.openMuxes === 1);
    expect(await (await tunnel.fetch(new Request('http://runtime.invalid/ok'))).text()).toBe('ok');
  });

  it('maps surface exceptions to 502 and leaves the connection usable', async () => {
    const { tunnel } = await pair({ handle: async request => {
      if (new URL(request.url).pathname === '/fail') throw new Error('private runtime details');
      return new Response('alive');
    } });
    await expect(tunnel.fetch(new Request('http://runtime.invalid/fail'))).rejects.toMatchObject({ code: 'REMOTE', status: 502, message: 'Remote operation failed' });
    expect(await (await tunnel.fetch(new Request('http://runtime.invalid/ok'))).text()).toBe('alive');
  });

});
