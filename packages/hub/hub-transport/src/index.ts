/** Durable signed-envelope delivery across reconnecting Hub WebSockets. */

import type { KeyObject } from 'node:crypto'
import {
  canonicalHubJson, signHubEnvelope, verifyHubEnvelope,
  type HubEnvelopeBody, type HubJson, type HubNodeId, type HubSignedEnvelope,
} from '@k1412/dsh-hub-protocol'
import {
  SqliteReliableJournal, type ReliableAcceptance, type ReliableInboundRecord,
  type ReliableOutboundRecord,
} from './journal.ts'

export * from './journal.ts'

/** One authenticated transport generation after the application handshake. */
export interface ReliablePeerOptions {
  nodeId: HubNodeId
  localBootId: string
  expectedRemoteBootId: string
  connectionGeneration: number
  localPrivateKey: string | KeyObject
  remotePublicKey: string | KeyObject
  journal: SqliteReliableJournal
  envelopeTtlMs?: number
}

/** Classified result after signature, fencing, acknowledgement, and journaling. */
export type ReliableReceiveResult =
  | { kind: 'accepted'; record: ReliableInboundRecord }
  | { kind: 'duplicate'; sequence: number }
  | { kind: 'rejected'; reason: string; expectedSequence?: number; receivedSequence?: number }

/** Re-signs durable bodies for each connection generation and accepts them before dispatch. */
export class ReliablePeer {
  private readonly envelopeTtlMs: number

  public constructor(private readonly options: ReliablePeerOptions) {
    if (!Number.isSafeInteger(options.connectionGeneration) || options.connectionGeneration < 1) {
      throw new Error('authenticated connection generation must be positive')
    }
    this.envelopeTtlMs = options.envelopeTtlMs ?? 30_000
    if (!Number.isSafeInteger(this.envelopeTtlMs) || this.envelopeTtlMs < 1_000 || this.envelopeTtlMs > 300_000) {
      throw new Error('envelope TTL must be between one and 300 seconds')
    }
  }

  /**
   * Persist one business body before its first transmission.
   * @param body - validated protocol body.
   * @param now - enqueue clock in Unix milliseconds.
   * @returns durable outbound record.
   */
  public enqueue(body: HubEnvelopeBody, now = Date.now()): ReliableOutboundRecord {
    return this.options.journal.enqueue(body, now)
  }

  /**
   * Coalesce an acknowledgement-only record when no business record can piggyback it.
   * @param now - enqueue clock in Unix milliseconds.
   * @returns existing or newly persisted acknowledgement record.
   */
  public enqueueAcknowledgement(now = Date.now()): ReliableOutboundRecord {
    return this.options.journal.pendingAcknowledgement()
      ?? this.options.journal.enqueue({ type: 'transport.ack' }, now)
  }

  /**
   * Render pending bodies as fresh signatures for this fenced connection.
   * @param now - signature clock in Unix milliseconds.
   * @param limit - maximum number of pending bodies to render.
   * @returns freshly signed envelopes in directional order.
   */
  public renderPending(now = Date.now(), limit = 1_000): HubSignedEnvelope[] {
    const acknowledgement = this.options.journal.inboundAcknowledgement()
    return this.options.journal.pendingOutbound(limit).map(record => signHubEnvelope({
      protocolVersion: 1,
      nodeId: this.options.nodeId,
      bootId: this.options.localBootId,
      connectionGeneration: this.options.connectionGeneration,
      messageId: record.messageId,
      directionSequence: record.sequence,
      cumulativeAck: acknowledgement,
      issuedAt: now,
      expiresAt: now + this.envelopeTtlMs,
      body: record.body,
    }, this.options.localPrivateKey))
  }

  /**
   * Authenticate and durably journal one frame before the caller dispatches it.
   * @param input - untrusted decoded WebSocket frame.
   * @param now - verification clock in Unix milliseconds.
   * @returns classified acceptance, duplicate, or rejection result.
   */
  public receive(input: unknown, now = Date.now()): ReliableReceiveResult {
    const verification = verifyHubEnvelope(input, this.options.remotePublicKey, now)
    if (!verification.ok) return { kind: 'rejected', reason: verification.reason }
    const envelope = verification.envelope
    if (envelope.nodeId !== this.options.nodeId) return { kind: 'rejected', reason: 'wrong-node' }
    if (envelope.connectionGeneration !== this.options.connectionGeneration) {
      return { kind: 'rejected', reason: 'fenced-generation' }
    }
    if (envelope.bootId !== this.options.expectedRemoteBootId) return { kind: 'rejected', reason: 'wrong-boot' }
    if (envelope.expiresAt - envelope.issuedAt > this.envelopeTtlMs) {
      return { kind: 'rejected', reason: 'validity-window' }
    }
    try {
      this.options.journal.acknowledgeOutbound(envelope.cumulativeAck)
    } catch {
      return { kind: 'rejected', reason: 'ack-out-of-range' }
    }
    const acceptance: ReliableAcceptance = this.options.journal.acceptInbound({
      sequence: envelope.directionSequence,
      messageId: envelope.messageId as ReliableOutboundRecord['messageId'],
      body: envelope.body,
      bodyHash: envelope.bodyHash,
      bodySize: Buffer.byteLength(canonicalHubJson(envelope.body as unknown as HubJson), 'utf8'),
      createdAt: envelope.issuedAt,
    }, now)
    if (acceptance.kind === 'accepted') return acceptance
    if (acceptance.kind === 'duplicate') return acceptance
    if (acceptance.kind === 'gap') {
      return {
        kind: 'rejected',
        reason: 'sequence-gap',
        expectedSequence: acceptance.expected,
        receivedSequence: acceptance.received,
      }
    }
    return { kind: 'rejected', reason: 'sequence-conflict', receivedSequence: acceptance.sequence }
  }
}
