import type { ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import type { PluginsEventFrame } from '@deepseek-ai/dsh-client-hmr'

export type PluginEventSource = Pick<ClientModuleRegistry, 'graph' | 'onGraphChanged' | 'onRebuilt'>
const queueBytes = 1024 * 1024
const heartbeatMs = 15_000

/**
 * The published HMR plugin exposes its wire type and registry subscriptions,
 * but its SSE handler is listener-only. This adapter supplies that wire over
 * Fetch; file watching and graph ownership remain entirely with the Runtime.
 */
export function pluginEvents(request: Request, modules: PluginEventSource): Response {
  const headers = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' }
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
  if (request.method === 'HEAD') return new Response(null, { headers })
  const encoder = new TextEncoder()
  const unsubscribers: Array<() => void> = []
  let timer: ReturnType<typeof setInterval> | undefined
  let closed = false
  let abort = () => {}
  const cleanup = () => {
    if (closed) return
    closed = true
    clearInterval(timer)
    request.signal.removeEventListener('abort', abort)
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const fail = (error: unknown) => { if (!closed) { cleanup(); controller.error(error) } }
      const send = (text: string) => {
        if (closed) return
        const bytes = encoder.encode(text)
        if (bytes.byteLength > (controller.desiredSize ?? 0)) { fail(new Error('Plugin event consumer fell behind')); return }
        controller.enqueue(bytes)
      }
      const frame = (value: PluginsEventFrame) => {
        try { send(`data: ${JSON.stringify(value)}\n\n`) } catch (error) { fail(error) }
      }
      const graph = () => { try { frame({ type: 'graph', graph: modules.graph() }) } catch (error) { fail(error) } }
      abort = () => fail(request.signal.reason ?? new DOMException('Plugin event request aborted', 'AbortError'))
      if (request.signal.aborted) { abort(); return }
      request.signal.addEventListener('abort', abort, { once: true })
      try {
        // Subscribe before reading the initial snapshot, so no settled graph
        // change can disappear between the snapshot and listener installation.
        const subscribe = (dispose: () => void) => { if (closed) dispose(); else unsubscribers.push(dispose) }
        subscribe(modules.onGraphChanged(graph))
        if (closed) return
        subscribe(modules.onRebuilt((id, rev) => frame({ type: 'rebuilt', id, rev })))
        send(': connected\n\n')
        graph()
        if (!closed) {
          timer = setInterval(() => {
            // Comments keep the carrier alive; never grow a stalled queue.
            if (controller.desiredSize === queueBytes) send(': heartbeat\n\n')
          }, heartbeatMs)
          timer.unref()
        }
      } catch (error) { fail(error) }
    },
    cancel() { cleanup() },
  }, { highWaterMark: queueBytes, size: bytes => bytes.byteLength })
  return new Response(body, { headers })
}
