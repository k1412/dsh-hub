import { expect, it } from 'vitest'
import { DirectoryAdmission, nativeList, nativeArchivedSessions, nativeDirectoryList } from '../src/native-rpc.ts'
it('reads just the official workspace baseline and cancels its stream on success, bad frames, limits and caller abort', async () => {
  for (const outcome of ['success', 'wrong-id', 'error', 'oversize', 'malformed', 'abort']) {
    let closed = 0
    const frames: Record<string, unknown>[] = [], controller = new AbortController()
    const tunnel = { openMux: (receive: (text: string) => void) => ({
      send(text: string) {
        const frame = JSON.parse(text) as Record<string, unknown>; frames.push(frame)
        if (frame.type !== 'open') return
        expect(frame.endpoint).toBe('workspace/follow'); expect(frame.payload).toEqual({ args: {} })
        if (outcome === 'abort') { queueMicrotask(() => controller.abort(new Error('cancelled'))); return }
        queueMicrotask(() => receive(outcome === 'malformed' ? '{}' : JSON.stringify({
          type: outcome === 'error' ? 'error' : 'item', streamId: outcome === 'wrong-id' ? 'wrong' : frame.streamId,
          value: { type: 'baseline', value: { items: [{ path: 'private-path-must-not-retain' }], archivedSessionIds: [outcome === 'oversize' ? 'x'.repeat(500) : 'archived'] } },
        })))
      }, close() { closed++ },
    }) }
    const result = nativeArchivedSessions(tunnel, controller.signal, outcome === 'oversize' ? 100 : 1000)
    if (outcome === 'success') expect(await result).toEqual(['archived'])
    else await expect(result).rejects.toThrow()
    expect(closed).toBe(1)
    expect(frames.at(-1)).toEqual({ type: 'cancel', streamId: frames[0]?.streamId })
  }
})
it('cancels the workspace baseline when native session listing fails', async () => {
  let closed = 0
  const tunnel = { fetch: async () => new Response('failure', { status: 503 }),
    openMux: () => ({ send() {}, close() { closed++ } }),
  }
  await expect(nativeDirectoryList(tunnel, 'https://node.invalid', new AbortController().signal)).rejects.toThrow('Native list failed')
  expect(closed).toBe(1)
})
it('uses exact published rc.2 envelope and rejects mismatched or oversized responses', async () => {
  let cancelled = false
  const tunnel = { fetch: async (request: Request) => {
    const input = await request.json() as { rpcId: string; payload: unknown; method: string }
    expect(new URL(request.url).pathname).toBe('/api/session/list')
    expect(input.payload).toEqual({ args: { _request: {} } }); expect(input.method).toBe('session/list')
    return Response.json({ type: 'server-response', rpcId: input.rpcId, result: { ok: true, value: { items: [] } } })
  } }
  expect(await nativeList(tunnel, 'https://node.invalid', new AbortController().signal)).toEqual({ items: [] })
  const oversized = { fetch: async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(100)) }, cancel() { cancelled = true } }), { headers: { 'content-type': 'application/json' } }) }
  await expect(nativeList(oversized, 'https://node.invalid', new AbortController().signal, 50)).rejects.toThrow('limit')
  expect(cancelled).toBe(true)
  await expect(nativeList({ fetch: async () => Response.json({ type: 'server-response', rpcId: 'wrong', result: { ok: true, value: {} } }) }, 'https://node.invalid', new AbortController().signal)).rejects.toThrow('rejected')
})
it('bounds total native calls across independent pages and releases slots after failure', async () => {
  const admission = new DirectoryAdmission(2)
  let done!: () => void
  const held = new Promise<void>(resolve => { done = resolve })
  const a = admission.run(() => held), b = admission.run(() => held)
  expect(admission.inflight).toBe(2)
  await expect(admission.run(async () => {})).rejects.toThrow('busy')
  done(); await Promise.all([a, b]); expect(admission.inflight).toBe(0)
  await expect(admission.run(async () => { throw new Error('failed') })).rejects.toThrow('failed')
  expect(admission.inflight).toBe(0)
})
