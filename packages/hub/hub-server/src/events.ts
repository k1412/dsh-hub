/** Ephemeral fan-out for authenticated browser event streams. */

import { randomBytes } from 'node:crypto'
import type { HubJson } from '@k1412/dsh-hub-protocol'

/** One browser event. Payloads are transferred live and are not retained. */
export interface HubBrowserEvent {
  id: string
  type: string
  occurredAt: number
  data: HubJson
}

/** Subscription result carrying the current non-replayable cursor. */
export interface HubEventSubscription {
  cursor: string
  unsubscribe: () => void
}

/**
 * Fan out live events without building a second conversation store.
 * Reconnecting clients receive a resync marker and load node-authoritative baselines.
 */
export class HubEventBroker {
  private readonly bootId = randomBytes(12).toString('base64url')
  private sequence = 0
  private readonly subscribers = new Set<(event: HubBrowserEvent) => void>()

  /**
   * Current cursor used by SSE baseline messages.
   * @returns process-generation and sequence cursor.
   */
  public cursor(): string {
    return `${this.bootId}:${String(this.sequence)}`
  }

  /**
   * Publish one event directly to current subscribers without retaining its payload.
   * @param type - stable browser event type.
   * @param data - strict transient event payload.
   * @param occurredAt - event clock in Unix milliseconds.
   * @returns the emitted event envelope.
   */
  public publish(type: string, data: HubJson, occurredAt = Date.now()): HubBrowserEvent {
    const event: HubBrowserEvent = {
      id: `${this.bootId}:${String(++this.sequence)}`,
      type,
      occurredAt,
      data,
    }
    for (const subscriber of this.subscribers) subscriber(event)
    return event
  }

  /**
   * Subscribe to future events and request a baseline refresh for any older cursor.
   * @param lastEventId - browser's last observed cursor, when present.
   * @param subscriber - live event receiver.
   * @returns current cursor and subscription disposer.
   */
  public subscribe(lastEventId: string | undefined, subscriber: (event: HubBrowserEvent) => void): HubEventSubscription {
    this.subscribers.add(subscriber)
    const cursor = this.cursor()
    if (lastEventId !== undefined && lastEventId !== cursor) {
      queueMicrotask(() => {
        if (!this.subscribers.has(subscriber)) return
        subscriber({
          id: cursor,
          type: 'hub.resync-required',
          occurredAt: Date.now(),
          data: { reason: 'event-payloads-are-not-retained' },
        })
      })
    }
    return { cursor, unsubscribe: () => this.subscribers.delete(subscriber) }
  }
}
