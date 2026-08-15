import { describe, expect, it, vi } from 'vitest'
import { HubEventBroker } from '../src/events.ts'

describe('Hub browser event broker', () => {
  it('fans out live payloads without replaying them to a later subscriber', async () => {
    const broker = new HubEventBroker()
    const first = vi.fn()
    const subscription = broker.subscribe(undefined, first)
    const event = broker.publish('session.events', { privatePayload: 'live-only' }, 1_000)
    expect(first).toHaveBeenCalledWith(event)
    subscription.unsubscribe()

    const later = vi.fn()
    broker.subscribe('older:1', later)
    await Promise.resolve()
    expect(later).toHaveBeenCalledTimes(1)
    expect(later).toHaveBeenCalledWith(expect.objectContaining({
      type: 'hub.resync-required',
      data: { reason: 'event-payloads-are-not-retained' },
    }))
    expect(JSON.stringify(later.mock.calls)).not.toContain('privatePayload')
  })
})
