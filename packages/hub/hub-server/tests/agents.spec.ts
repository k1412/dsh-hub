import { describe, expect, it, vi } from 'vitest'
import { sessionsCapability } from '@k1412/dsh-hub-capabilities'
import { generateHubIdentity, HubMessageId, type HubEnvelopeBody } from '@k1412/dsh-hub-protocol'
import type { HubStorage } from '@k1412/dsh-hub-storage'
import type { ReliableInboundRecord } from '@k1412/dsh-hub-transport'
import { HubAgentRegistry } from '../src/agents.ts'
import { HubEventBroker } from '../src/events.ts'

describe('Hub Agent recovery', () => {
  it('coalesces reconstructible recovery frames into one runtime resync', () => {
    const registry = new HubAgentRegistry(
      {} as HubStorage,
      new HubEventBroker(),
      generateHubIdentity(),
    )
    const enqueue = vi.fn()
    const connection = {
      runtimes: new Map([['default', new Map([
        [sessionsCapability.descriptor.name, sessionsCapability.descriptor],
      ])]]),
      recoveryResyncRuntimes: new Set<string>(),
      peer: { enqueue },
    }
    const body: HubEnvelopeBody = {
      type: 'stream.frame', runtimeId: 'default', streamId: 'recovered-events-stream',
      capability: 'dsh.sessions', stream: 'events', frameSequence: 1, payload: {},
    }
    const record = (sequence: number): ReliableInboundRecord => ({
      sequence,
      messageId: HubMessageId(`recovery-frame-${String(sequence).padStart(8, '0')}`),
      body,
      bodyHash: 'hash', bodySize: 1, createdAt: 1, recovery: true,
    })
    const internal = registry as unknown as {
      processInbound(connection: unknown, record: ReliableInboundRecord): void
    }

    internal.processInbound(connection, record(1))
    internal.processInbound(connection, record(2))

    expect(enqueue).toHaveBeenCalledOnce()
    expect(enqueue).toHaveBeenCalledWith({
      type: 'runtime.resync-required', runtimeId: 'default', reason: 'baseline-changed',
    })
  })
})
