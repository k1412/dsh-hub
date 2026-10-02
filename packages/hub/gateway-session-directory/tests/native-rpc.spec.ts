import { expect, it } from 'vitest'
import { DirectoryAdmission, nativeList } from '../src/native-rpc.ts'
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
