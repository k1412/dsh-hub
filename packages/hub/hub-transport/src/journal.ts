/** SQLite durable journal for reliable Hub transport. */

import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  canonicalHubJson, hubEnvelopeBodySchema, hubJsonHash, HubMessageId,
  type HubEnvelopeBody, type HubJson, type HubMessageId as HubMessageIdType,
} from '@k1412/dsh-hub-protocol'

/** Resource bounds applied before accepting another outbound record. */
export interface ReliableJournalLimits {
  maxOutboundRecords: number
  maxOutboundBytes: number
}

/** Current reliable-outbox pressure and configured capacity. */
export interface ReliableJournalUsage {
  records: number
  bytes: number
  oldestCreatedAt: number
  maxRecords: number
  maxBytes: number
}

/** Durable outbound body awaiting a peer acknowledgement. */
export interface ReliableOutboundRecord {
  sequence: number
  messageId: HubMessageIdType
  body: HubEnvelopeBody
  bodyHash: string
  bodySize: number
  createdAt: number
}

/** Durable inbound body awaiting or undergoing business dispatch. */
export interface ReliableInboundRecord extends ReliableOutboundRecord {
  recovery: boolean
}

/** Result of durably accepting an authenticated inbound body. */
export type ReliableAcceptance =
  | { kind: 'accepted'; record: ReliableInboundRecord }
  | { kind: 'duplicate'; sequence: number }
  | { kind: 'gap'; expected: number; received: number }
  | { kind: 'conflict'; sequence: number }

const DEFAULT_LIMITS: ReliableJournalLimits = {
  maxOutboundRecords: 10_000,
  maxOutboundBytes: 64 * 1024 * 1024,
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function parseBody(value: unknown): HubEnvelopeBody {
  if (typeof value !== 'string') throw new Error('corrupt reliable body')
  return hubEnvelopeBodySchema.parse(JSON.parse(value))
}

function outboundFromRow(row: Record<string, unknown>): ReliableOutboundRecord {
  return {
    sequence: Number(row.sequence),
    messageId: HubMessageId(String(row.message_id)),
    body: parseBody(row.body_json),
    bodyHash: String(row.body_hash),
    bodySize: Number(row.body_size),
    createdAt: Number(row.created_at),
  }
}

/**
 * Install the idempotent reliable-transport tables on a private SQLite database.
 * @param database - target private SQLite connection.
 */
export function installReliableJournalSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS reliable_peer_state (
      peer_id           TEXT PRIMARY KEY,
      outbound_sequence INTEGER NOT NULL DEFAULT 0 CHECK (outbound_sequence >= 0),
      outbound_ack      INTEGER NOT NULL DEFAULT 0 CHECK (outbound_ack >= 0),
      inbound_ack       INTEGER NOT NULL DEFAULT 0 CHECK (inbound_ack >= 0)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS reliable_outbox (
      peer_id    TEXT NOT NULL REFERENCES reliable_peer_state(peer_id) ON DELETE CASCADE,
      sequence   INTEGER NOT NULL CHECK (sequence > 0),
      message_id TEXT NOT NULL,
      body_json  TEXT NOT NULL,
      body_hash  TEXT NOT NULL,
      body_size  INTEGER NOT NULL CHECK (body_size >= 0),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (peer_id, sequence),
      UNIQUE (peer_id, message_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS reliable_inbox (
      peer_id    TEXT NOT NULL REFERENCES reliable_peer_state(peer_id) ON DELETE CASCADE,
      sequence   INTEGER NOT NULL CHECK (sequence > 0),
      message_id TEXT NOT NULL,
      body_json  TEXT,
      body_hash  TEXT NOT NULL,
      body_size  INTEGER NOT NULL CHECK (body_size >= 0),
      state      TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'processed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (peer_id, sequence),
      UNIQUE (peer_id, message_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS reliable_inbox_recovery
      ON reliable_inbox(peer_id, state, sequence);
  `)
}

/** Durable peer journal shared by reconnecting WebSocket generations. */
export class SqliteReliableJournal {
  private readonly limits: ReliableJournalLimits

  public constructor(
    private readonly database: DatabaseSync,
    private readonly peerId: string,
    limits: Partial<ReliableJournalLimits> = {},
  ) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(peerId)) throw new Error('invalid reliable peer id')
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    if (!Number.isSafeInteger(this.limits.maxOutboundRecords) || this.limits.maxOutboundRecords < 1) {
      throw new Error('maxOutboundRecords must be a positive integer')
    }
    if (!Number.isSafeInteger(this.limits.maxOutboundBytes) || this.limits.maxOutboundBytes < 1) {
      throw new Error('maxOutboundBytes must be a positive integer')
    }
    installReliableJournalSchema(database)
    database.prepare('INSERT INTO reliable_peer_state (peer_id) VALUES (?) ON CONFLICT DO NOTHING').run(peerId)
  }

  /**
   * Persist a body and allocate its immutable directional sequence.
   * @param bodyInput - validated protocol body.
   * @param now - enqueue clock in Unix milliseconds.
   * @param messageId - unique message identifier.
   * @returns durable outbound record.
   */
  public enqueue(bodyInput: HubEnvelopeBody, now = Date.now(), messageId = HubMessageId(randomBytes(18).toString('base64url'))): ReliableOutboundRecord {
    const body = hubEnvelopeBodySchema.parse(bodyInput)
    const bodyJson = canonicalHubJson(body as unknown as HubJson)
    const bodySize = Buffer.byteLength(bodyJson, 'utf8')
    return transaction(this.database, () => {
      const usage = this.database.prepare(`
        SELECT COUNT(*) AS records, COALESCE(SUM(body_size), 0) AS bytes
        FROM reliable_outbox WHERE peer_id = ?
      `).get(this.peerId) as { records: number; bytes: number }
      if (usage.records >= this.limits.maxOutboundRecords
        || usage.bytes + bodySize > this.limits.maxOutboundBytes) {
        throw new Error('reliable outbox quota exceeded')
      }
      const state = this.state()
      const sequence = state.outboundSequence + 1
      this.database.prepare(`
        INSERT INTO reliable_outbox (
          peer_id, sequence, message_id, body_json, body_hash, body_size, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(this.peerId, sequence, messageId, bodyJson, hubJsonHash(body as unknown as HubJson), bodySize, now)
      this.database.prepare(`
        UPDATE reliable_peer_state SET outbound_sequence = ? WHERE peer_id = ?
      `).run(sequence, this.peerId)
      return { sequence, messageId, body, bodyHash: hubJsonHash(body as unknown as HubJson), bodySize, createdAt: now }
    })
  }

  /**
   * Return every unacknowledged body in directional order.
   * @param limit - maximum record count.
   * @returns pending outbound records.
   */
  public pendingOutbound(limit = 1_000): ReliableOutboundRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('pending limit must be a positive integer')
    return this.database.prepare(`
      SELECT * FROM reliable_outbox WHERE peer_id = ? ORDER BY sequence LIMIT ?
    `).all(this.peerId, limit).map(outboundFromRow)
  }

  /**
   * Return unacknowledged bodies after a connection-local send cursor.
   * @param sequence - exclusive lower directional-sequence bound.
   * @param limit - maximum record count.
   * @returns pending outbound records after the supplied sequence.
   */
  public pendingOutboundAfter(sequence: number, limit = 1_000): ReliableOutboundRecord[] {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('outbound cursor must be a non-negative integer')
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('pending limit must be a positive integer')
    return this.database.prepare(`
      SELECT * FROM reliable_outbox
      WHERE peer_id = ? AND sequence > ?
      ORDER BY sequence LIMIT ?
    `).all(this.peerId, sequence, limit).map(outboundFromRow)
  }

  /**
   * Return current queue usage for health reporting and producer backpressure.
   * @returns record, byte, and configured capacity totals.
   */
  public outboundUsage(): ReliableJournalUsage {
    const usage = this.database.prepare(`
      SELECT COUNT(*) AS records, COALESCE(SUM(body_size), 0) AS bytes,
             COALESCE(MIN(created_at), 0) AS oldest_created_at
      FROM reliable_outbox WHERE peer_id = ?
    `).get(this.peerId) as { records: number; bytes: number; oldest_created_at: number }
    return {
      records: usage.records,
      bytes: usage.bytes,
      oldestCreatedAt: usage.oldest_created_at,
      maxRecords: this.limits.maxOutboundRecords,
      maxBytes: this.limits.maxOutboundBytes,
    }
  }

  /**
   * Return current queue usage for one protocol-body type.
   *
   * This narrower query is intentionally separate from the total used for the
   * hard quota. Producers use it only after a total-queue threshold is crossed,
   * so a large command result cannot masquerade as a backlog of reconstructible
   * stream frames.
   * @param bodyType - exact Hub envelope body discriminator.
   * @returns matching record, byte, and configured capacity totals.
   */
  public outboundUsageForBodyType(bodyType: HubEnvelopeBody['type']): ReliableJournalUsage {
    const usage = this.database.prepare(`
      SELECT COUNT(*) AS records, COALESCE(SUM(body_size), 0) AS bytes,
             COALESCE(MIN(created_at), 0) AS oldest_created_at
      FROM reliable_outbox
      WHERE peer_id = ? AND json_extract(body_json, '$.type') = ?
    `).get(this.peerId, bodyType) as { records: number; bytes: number; oldest_created_at: number }
    return {
      records: usage.records,
      bytes: usage.bytes,
      oldestCreatedAt: usage.oldest_created_at,
      maxRecords: this.limits.maxOutboundRecords,
      maxBytes: this.limits.maxOutboundBytes,
    }
  }

  /**
   * Delete the acknowledged prefix after validating it was allocated locally.
   * @param acknowledgement - peer's highest contiguous accepted sequence.
   */
  public acknowledgeOutbound(acknowledgement: number): void {
    transaction(this.database, () => {
      const state = this.state()
      if (!Number.isSafeInteger(acknowledgement) || acknowledgement < state.outboundAck) {
        throw new Error('outbound acknowledgement regression')
      }
      if (acknowledgement > state.outboundSequence) throw new Error('outbound acknowledgement exceeds allocated sequence')
      if (acknowledgement === state.outboundAck) return
      this.database.prepare(`
        DELETE FROM reliable_outbox WHERE peer_id = ? AND sequence <= ?
      `).run(this.peerId, acknowledgement)
      this.database.prepare(`
        UPDATE reliable_peer_state SET outbound_ack = ? WHERE peer_id = ?
      `).run(acknowledgement, this.peerId)
    })
  }

  /**
   * Return the highest contiguous inbound sequence durably accepted.
   * @returns durable inbound acknowledgement cursor.
   */
  public inboundAcknowledgement(): number {
    return this.state().inboundAck
  }

  /**
   * Persist an authenticated body before acknowledging or dispatching it.
   * @param record - authenticated outbound-format record received from the peer.
   * @param now - acceptance clock in Unix milliseconds.
   * @returns classified durable acceptance result.
   */
  public acceptInbound(record: ReliableOutboundRecord, now = Date.now()): ReliableAcceptance {
    const body = hubEnvelopeBodySchema.parse(record.body)
    const bodyJson = canonicalHubJson(body as unknown as HubJson)
    const bodyHash = hubJsonHash(body as unknown as HubJson)
    if (bodyHash !== record.bodyHash || Buffer.byteLength(bodyJson, 'utf8') !== record.bodySize) {
      return { kind: 'conflict', sequence: record.sequence }
    }
    return transaction(this.database, () => {
      const state = this.state()
      if (record.sequence <= state.inboundAck) {
        const existing = this.database.prepare(`
          SELECT message_id, body_hash FROM reliable_inbox WHERE peer_id = ? AND sequence = ?
        `).get(this.peerId, record.sequence)
        if (existing !== undefined
          && (String(existing.message_id) !== record.messageId || String(existing.body_hash) !== record.bodyHash)) {
          return { kind: 'conflict', sequence: record.sequence }
        }
        return { kind: 'duplicate', sequence: record.sequence }
      }
      const expected = state.inboundAck + 1
      if (record.sequence !== expected) return { kind: 'gap', expected, received: record.sequence }
      const reused = this.database.prepare(`
        SELECT sequence FROM reliable_inbox WHERE peer_id = ? AND message_id = ?
      `).get(this.peerId, record.messageId)
      if (reused !== undefined) return { kind: 'conflict', sequence: record.sequence }
      this.database.prepare(`
        INSERT INTO reliable_inbox (
          peer_id, sequence, message_id, body_json, body_hash, body_size,
          state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        this.peerId, record.sequence, record.messageId, bodyJson, bodyHash, record.bodySize, now, now,
      )
      this.database.prepare(`
        UPDATE reliable_peer_state SET inbound_ack = ? WHERE peer_id = ?
      `).run(record.sequence, this.peerId)
      return {
        kind: 'accepted',
        record: { ...record, body, recovery: false },
      }
    })
  }

  /**
   * Claim one accepted record immediately before business dispatch.
   * @param sequence - accepted inbound sequence.
   * @param now - claim clock in Unix milliseconds.
   * @returns claimed record, or `undefined` when unavailable.
   */
  public claimInbound(sequence: number, now = Date.now()): ReliableInboundRecord | undefined {
    return transaction(this.database, () => {
      const row = this.database.prepare(`
        SELECT * FROM reliable_inbox
        WHERE peer_id = ? AND sequence = ? AND state IN ('pending', 'processing')
      `).get(this.peerId, sequence)
      if (row === undefined || row.body_json === null) return undefined
      const recovery = row.state === 'processing'
      this.database.prepare(`
        UPDATE reliable_inbox SET state = 'processing', updated_at = ?
        WHERE peer_id = ? AND sequence = ?
      `).run(now, this.peerId, sequence)
      return { ...outboundFromRow(row), recovery }
    })
  }

  /**
   * List bodies requiring initial dispatch or crash-policy reconciliation.
   * @param limit - maximum record count.
   * @returns recoverable inbound records in sequence order.
   */
  public recoverableInbound(limit = 1_000): ReliableInboundRecord[] {
    return this.database.prepare(`
      SELECT * FROM reliable_inbox
      WHERE peer_id = ? AND state IN ('pending', 'processing')
      ORDER BY sequence LIMIT ?
    `).all(this.peerId, limit).map(row => ({
      ...outboundFromRow(row),
      recovery: row.state === 'processing',
    }))
  }

  /**
   * List recoverable bodies after a recovery-pass cursor.
   * @param sequence - exclusive lower directional-sequence bound.
   * @param limit - maximum record count.
   * @returns recoverable inbound records after the supplied sequence.
   */
  public recoverableInboundAfter(sequence: number, limit = 1_000): ReliableInboundRecord[] {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('inbound cursor must be a non-negative integer')
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('recovery limit must be a positive integer')
    return this.database.prepare(`
      SELECT * FROM reliable_inbox
      WHERE peer_id = ? AND sequence > ? AND state IN ('pending', 'processing')
      ORDER BY sequence LIMIT ?
    `).all(this.peerId, sequence, limit).map(row => ({
      ...outboundFromRow(row),
      recovery: row.state === 'processing',
    }))
  }

  /**
   * Mark one claimed body processed and remove its business content.
   * @param sequence - claimed inbound sequence.
   * @param now - completion clock in Unix milliseconds.
   */
  public completeInbound(sequence: number, now = Date.now()): void {
    const result = this.database.prepare(`
      UPDATE reliable_inbox SET state = 'processed', body_json = NULL, updated_at = ?
      WHERE peer_id = ? AND sequence = ? AND state = 'processing'
    `).run(now, this.peerId, sequence)
    if (Number(result.changes) !== 1) throw new Error('processing inbound record not found')
  }

  /**
   * Retain a bounded processed deduplication suffix while preserving recoverable bodies.
   * @param retain - processed-sequence suffix length to retain.
   * @returns number of processed records deleted.
   */
  public pruneProcessed(retain = 4_096): number {
    if (!Number.isSafeInteger(retain) || retain < 0) throw new Error('retain must be a non-negative integer')
    const threshold = this.inboundAcknowledgement() - retain
    if (threshold <= 0) return 0
    return Number(this.database.prepare(`
      DELETE FROM reliable_inbox
      WHERE peer_id = ? AND state = 'processed' AND sequence <= ?
    `).run(this.peerId, threshold).changes)
  }

  /**
   * Return an existing queued acknowledgement so acknowledgement records coalesce.
   * @returns newest queued acknowledgement record, when present.
   */
  public pendingAcknowledgement(): ReliableOutboundRecord | undefined {
    const rows = this.pendingOutbound(this.limits.maxOutboundRecords)
    return rows.findLast(record => record.body.type === 'transport.ack')
  }

  private state(): { outboundSequence: number; outboundAck: number; inboundAck: number } {
    const row = this.database.prepare(`
      SELECT outbound_sequence, outbound_ack, inbound_ack
      FROM reliable_peer_state WHERE peer_id = ?
    `).get(this.peerId)
    if (row === undefined) throw new Error('reliable peer state not found')
    return {
      outboundSequence: Number(row.outbound_sequence),
      outboundAck: Number(row.outbound_ack),
      inboundAck: Number(row.inbound_ack),
    }
  }
}
