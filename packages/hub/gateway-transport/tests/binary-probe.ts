import assert from 'node:assert/strict'

// Setup, two transfers, integrity checks and cancellation share this test budget.
// Actual I/O retains separate response, stall, deadline and throughput gates.
export const BINARY_TEST_TIMEOUT_MS = 20_000
export const BINARY_TRANSFER_TIMEOUT_MS = 8_000

export async function verifyBinaryTransfer(
  label: string,
  open: (signal: AbortSignal) => Promise<Response>,
  expected: Buffer,
  health: () => unknown,
) {
  const started = performance.now()
  let lastProgress = started, bytes = 0, chunks = 0, headersMs: number | undefined
  const abort = new AbortController()
  const snapshot = () => ({ label, phase: headersMs === undefined ? 'headers' : 'body', bytes, expectedBytes: expected.length, chunks,
    elapsedMs: Math.round(performance.now() - started), idleMs: Math.round(performance.now() - lastProgress), headersMs, health: health() })
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let rejectWatchdog: (error: Error) => void = () => {}
  const watchdog = new Promise<never>((_resolve, reject) => { rejectWatchdog = reject })
  const timer = setInterval(() => {
    const now = performance.now()
    if (now - started >= BINARY_TRANSFER_TIMEOUT_MS || now - lastProgress >= 3000) {
      const error = new Error(`Binary transfer stalled/deadline exceeded: ${JSON.stringify(snapshot())}`)
      rejectWatchdog(error); abort.abort(error)
    }
  }, 100)
  try {
    const result = await Promise.race([watchdog, (async () => {
      const response = await open(abort.signal)
      headersMs = performance.now() - started; lastProgress = performance.now()
      assert.ok(response.body, 'Expected streaming binary response')
      reader = response.body.getReader()
      const buffers: Buffer[] = []
      while (true) {
        const item = await reader.read()
        if (item.done) break
        buffers.push(Buffer.from(item.value)); bytes += item.value.byteLength; chunks++; lastProgress = performance.now()
        assert.ok(bytes <= expected.length, 'Response exceeded expected binary length')
      }
      const elapsedMs = performance.now() - started
      const kibPerSecond = bytes / 1024 / (Math.max(elapsedMs, 0.01) / 1000)
      // Native memcmp compares every byte without deep-enumerating typed-array keys.
      assert.ok(Buffer.concat(buffers).equals(expected), 'Binary response bytes differ')
      const metrics = { label, bytes, chunks, headersMs, elapsedMs, kibPerSecond }
      console.info('gateway binary transfer', JSON.stringify(metrics))
      assert.ok(headersMs < 3000, 'Response headers exceeded 3s budget')
      assert.ok(kibPerSecond >= 128, 'Binary throughput below 128 KiB/s')
      return response
    })()])
    return result
  } catch (error) {
    abort.abort(error)
    throw new Error(`Binary transfer failed: ${JSON.stringify(snapshot())}`, { cause: error })
  } finally {
    clearInterval(timer)
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
}
