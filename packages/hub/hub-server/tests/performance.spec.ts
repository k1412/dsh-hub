import { describe, expect, it, vi } from 'vitest'
import { HubPerformanceTracker } from '../src/performance.ts'
import { HubBrowserStreamWriter } from '../src/server.ts'

describe('Hub live performance telemetry', () => {
  it('keeps a bounded payload-free window and aggregates target and method percentiles', () => {
    const tracker = new HubPerformanceTracker(3)
    tracker.record({
      occurredAt: 1, nodeId: 'home', runtimeId: 'web', method: 'session.list', outcome: 'ok',
      durationMs: 10, dispatchMs: 2, waitMs: 8, responseBytes: 100,
    })
    tracker.record({
      occurredAt: 2, nodeId: 'home', runtimeId: 'web', method: 'session.history', outcome: 'timeout',
      durationMs: 30_000, dispatchMs: 3, waitMs: 29_997, responseBytes: 0,
    })
    tracker.record({
      occurredAt: 3, nodeId: 'nas', runtimeId: 'default', method: 'workspace.list', outcome: 'ok',
      durationMs: 20, dispatchMs: 5, waitMs: 15, responseBytes: 200,
    })
    tracker.record({
      occurredAt: 4, nodeId: 'home', runtimeId: 'web', method: 'goals/clear', outcome: 'node-error',
      durationMs: 40, dispatchMs: 4, waitMs: 36, responseBytes: 80,
    })

    expect(tracker.snapshot(5)).toEqual({
      generatedAt: 5,
      windowStartedAt: 2,
      sampleLimit: 3,
      summary: {
        requests: 3, errors: 2, timeouts: 1, p50Ms: 40, p95Ms: 30_000, maxMs: 30_000,
        dispatchP95Ms: 5, waitP95Ms: 29_997, responseBytes: 280, maxResponseBytes: 200,
      },
      targets: [
        expect.objectContaining({
          nodeId: 'home', runtimeId: 'web', requests: 2, errors: 2, timeouts: 1, p95Ms: 30_000,
          methods: [
            expect.objectContaining({ method: 'session.history', requests: 1, timeouts: 1 }),
            expect.objectContaining({ method: 'goals/clear', requests: 1, errors: 1 }),
          ],
        }),
        expect.objectContaining({
          nodeId: 'nas', runtimeId: 'default', requests: 1, errors: 0, p95Ms: 20,
          methods: [expect.objectContaining({ method: 'workspace.list', requests: 1 })],
        }),
      ],
    })
  })

  it('rejects invalid bounds and metric values', () => {
    expect(() => new HubPerformanceTracker(0)).toThrow(/sample limit/)
    const tracker = new HubPerformanceTracker()
    expect(() => tracker.record({
      occurredAt: 1, nodeId: 'home', runtimeId: 'web', method: 'session.list', outcome: 'ok',
      durationMs: -1, dispatchMs: 0, waitMs: 0, responseBytes: 0,
    })).toThrow(/sample values/)
  })
})

describe('Hub browser stream backpressure', () => {
  it('closes a reconstructible stream before its unsent queue can grow without bound', () => {
    const callbacks: Array<(error?: Error) => void> = []
    const close = vi.fn()
    const socket = {
      readyState: 1,
      send: (_data: string, callback: (error?: Error) => void) => { callbacks.push(callback) },
      close,
    }
    const writer = new HubBrowserStreamWriter(socket, 2, 1_024)

    expect(writer.enqueue({ sequence: 1, payload: 'first' })).toBe(true)
    expect(writer.enqueue({ sequence: 2, payload: 'second' })).toBe(true)
    expect(writer.enqueue({ sequence: 3, payload: 'third' })).toBe(false)
    expect(close).toHaveBeenCalledWith(1012, 'browser stream backpressure')
    expect(writer.enqueue({ sequence: 4 })).toBe(false)
  })

  it('applies the byte bound before retaining an oversized frame', () => {
    const close = vi.fn()
    const writer = new HubBrowserStreamWriter({
      readyState: 1,
      send: () => undefined,
      close,
    }, 10, 16)

    expect(writer.enqueue({ payload: 'larger than sixteen bytes' })).toBe(false)
    expect(close).toHaveBeenCalledWith(1012, 'browser stream backpressure')
  })
})
