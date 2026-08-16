/** Durable SQLite control-plane records for DSH Hub. */

import { createHash, randomBytes } from 'node:crypto'
import { backup, type DatabaseSync } from 'node:sqlite'
import { chmod, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  canonicalHubJson, hubJsonHash, HubNodeId, HubRuntimeId,
  type HubIdempotency, type HubJson, type HubNodeId as HubNodeIdType,
  type HubRuntimeId as HubRuntimeIdType,
} from '@k1412/dsh-hub-protocol'
import { hubTransaction } from './schema.ts'

/** Lifecycle status of a durable Hub command. */
export type HubCommandStatus = 'pending' | 'sent' | 'running' | 'ok' | 'error' | 'outcome-unknown'

/** Persisted enrollment grant without its one-time secret. */
export interface HubEnrollmentGrant {
  nodeId: HubNodeIdType
  displayName: string
  code: string
  expiresAt: number
}

/** Persisted enrolled-node record. */
export interface HubNodeRecord {
  nodeId: HubNodeIdType
  displayName: string
  publicKey: string
  status: 'active' | 'revoked'
  connectionGeneration: number
  serviceIdentity?: string
  createdAt: number
  updatedAt: number
  lastSeenAt?: number
  revokedAt?: number
}

/** Runtime baseline projected by one Connector. */
export interface HubRuntimeInput {
  nodeId: HubNodeIdType
  runtimeId: HubRuntimeIdType
  bootId: string
  dshVersion: string
  connectorVersion: string
  capabilities: HubJson
  online: boolean
  lastSeenAt: number
}

/** Runtime baseline returned to Hub services and operator APIs. */
export type HubRuntimeRecord = HubRuntimeInput

/** Minimal, non-authoritative session discovery record. */
export interface HubSessionIndexInput {
  hubSessionId: string
  nodeId: HubNodeIdType
  runtimeId: HubRuntimeIdType
  sourceId: string
  title?: string
  updatedAt: number
  running: boolean
  stale: boolean
}


/** Minimal session discovery record returned to the Hub UI. */
export type HubSessionIndexRecord = HubSessionIndexInput

/** Durable command record accepted before network delivery. */
export interface HubCommandInput {
  commandId: string
  nodeId: HubNodeIdType
  runtimeId?: HubRuntimeIdType
  capability: string
  capabilityVersion: string
  operation: string
  idempotency: HubIdempotency
  idempotencyKey?: string
  payload: HubJson
  createdAt: number
}

/** One command loaded for delivery or reconciliation. */
export interface HubCommandRecord extends HubCommandInput {
  payloadHash: string
  status: HubCommandStatus
  result?: HubJson
  resultHash?: string
  updatedAt: number
  terminalAt?: number
}

/** Audit event whose hash links to every preceding event. */
export interface HubAuditInput {
  occurredAt: number
  actor: string
  action: string
  nodeId?: HubNodeIdType
  runtimeId?: HubRuntimeIdType
  resourceId?: string
  outcome: string
  details: HubJson
}

/** Result of appending one audit event. */
export interface HubAuditRecord extends HubAuditInput {
  sequence: number
  previousHash: string
  recordHash: string
}

const TERMINAL_COMMANDS = new Set<HubCommandStatus>(['ok', 'error', 'outcome-unknown'])
const COMMAND_TRANSITIONS: Readonly<Record<HubCommandStatus, readonly HubCommandStatus[]>> = {
  pending: ['sent', 'error'],
  sent: ['running', 'ok', 'error', 'outcome-unknown'],
  running: ['ok', 'error', 'outcome-unknown'],
  ok: [],
  error: [],
  'outcome-unknown': [],
}

function secretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('base64url')
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('corrupt string field')
  return value
}

function optionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value)
}

function parseJson(value: unknown): HubJson {
  if (typeof value !== 'string') throw new Error('corrupt Hub JSON column')
  const parsed = JSON.parse(value) as HubJson
  canonicalHubJson(parsed)
  return parsed
}

function nodeFromRow(row: Record<string, unknown>): HubNodeRecord {
  const record: HubNodeRecord = {
    nodeId: HubNodeId(String(row.node_id)),
    displayName: String(row.display_name),
    publicKey: String(row.public_key),
    status: row.status === 'revoked' ? 'revoked' : 'active',
    connectionGeneration: Number(row.connection_generation),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
  const serviceIdentity = optionalString(row.service_identity)
  if (serviceIdentity !== undefined) record.serviceIdentity = serviceIdentity
  const lastSeenAt = optionalNumber(row.last_seen_at)
  if (lastSeenAt !== undefined) record.lastSeenAt = lastSeenAt
  const revokedAt = optionalNumber(row.revoked_at)
  if (revokedAt !== undefined) record.revokedAt = revokedAt
  return record
}

function commandFromRow(row: Record<string, unknown>): HubCommandRecord {
  const payload = row.payload_json === null ? null : parseJson(row.payload_json)
  const record: HubCommandRecord = {
    commandId: String(row.command_id),
    nodeId: HubNodeId(String(row.node_id)),
    capability: String(row.capability),
    capabilityVersion: String(row.capability_ver),
    operation: String(row.operation),
    idempotency: String(row.idempotency) as HubIdempotency,
    payload,
    payloadHash: String(row.payload_hash),
    status: String(row.status) as HubCommandStatus,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
  const runtimeId = optionalString(row.runtime_id)
  if (runtimeId !== undefined) record.runtimeId = HubRuntimeId(runtimeId)
  const idempotencyKey = optionalString(row.idempotency_key)
  if (idempotencyKey !== undefined) record.idempotencyKey = idempotencyKey
  if (row.result_json !== null) record.result = parseJson(row.result_json)
  const resultHash = optionalString(row.result_hash)
  if (resultHash !== undefined) record.resultHash = resultHash
  const terminalAt = optionalNumber(row.terminal_at)
  if (terminalAt !== undefined) record.terminalAt = terminalAt
  return record
}

function auditFromRow(row: Record<string, unknown>): HubAuditRecord {
  const record: HubAuditRecord = {
    sequence: Number(row.sequence),
    occurredAt: Number(row.occurred_at),
    actor: String(row.actor),
    action: String(row.action),
    outcome: String(row.outcome),
    details: parseJson(row.details_json),
    previousHash: String(row.previous_hash),
    recordHash: String(row.record_hash),
  }
  const nodeId = optionalString(row.node_id)
  if (nodeId !== undefined) record.nodeId = HubNodeId(nodeId)
  const runtimeId = optionalString(row.runtime_id)
  if (runtimeId !== undefined) record.runtimeId = HubRuntimeId(runtimeId)
  const resourceId = optionalString(row.resource_id)
  if (resourceId !== undefined) record.resourceId = resourceId
  return record
}

/** Synchronous transactional control store over one private SQLite connection. */
export class HubControlStore {
  public constructor(private readonly database: DatabaseSync) {}

  /**
   * Create a one-time enrollment grant; only its SHA-256 is persisted.
   * A new grant rotates any unconsumed grant for the same unenrolled node.
   * @param nodeId - stable node identifier reserved by the grant.
   * @param displayName - operator-facing node label.
   * @param expiresAt - exclusive grant expiry in Unix milliseconds.
   * @param now - creation clock in Unix milliseconds.
   * @returns one-time plaintext enrollment grant.
   */
  public createEnrollment(nodeId: HubNodeIdType, displayName: string, expiresAt: number, now = Date.now()): HubEnrollmentGrant {
    if (expiresAt <= now) throw new Error('enrollment expiry must be in the future')
    if (displayName.trim().length === 0 || displayName.length > 128) throw new Error('invalid node display name')
    const code = randomBytes(32).toString('base64url')
    hubTransaction(this.database, () => {
      if (this.getNode(nodeId) !== undefined) throw new Error('node is already enrolled')
      this.database.prepare(`
        DELETE FROM enrollment_codes
        WHERE node_id = ? AND consumed_at IS NULL
      `).run(nodeId)
      this.database.prepare(`
        INSERT INTO enrollment_codes (code_hash, node_id, display_name, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(secretHash(code), nodeId, displayName, expiresAt, now)
    })
    return { nodeId, displayName, code, expiresAt }
  }

  /**
   * Consume one enrollment secret and atomically establish the node identity.
   * @param code - one-time enrollment secret.
   * @param publicKey - node's permanent Ed25519 public key.
   * @param serviceIdentity - Cloudflare Service Token Client ID claim.
   * @param now - enrollment clock in Unix milliseconds.
   * @returns newly enrolled node record.
   */
  public consumeEnrollment(code: string, publicKey: string, serviceIdentity: string | undefined, now = Date.now()): HubNodeRecord {
    return hubTransaction(this.database, () => {
      const row = this.database.prepare(`
        SELECT node_id, display_name, expires_at, consumed_at
        FROM enrollment_codes WHERE code_hash = ?
      `).get(secretHash(code))
      if (row === undefined || row.consumed_at !== null || Number(row.expires_at) <= now) {
        throw new Error('invalid or expired enrollment code')
      }
      const changed = this.database.prepare(`
        UPDATE enrollment_codes SET consumed_at = ?
        WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?
      `).run(now, secretHash(code), now)
      if (Number(changed.changes) !== 1) throw new Error('enrollment code was already consumed')
      this.database.prepare(`
        INSERT INTO nodes (
          node_id, display_name, public_key, status, service_identity, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, ?, ?)
      `).run(String(row.node_id), String(row.display_name), publicKey, serviceIdentity ?? null, now, now)
      return this.requireNode(HubNodeId(String(row.node_id)))
    })
  }

  /**
   * Return one enrolled node, including revoked identities.
   * @param nodeId - enrolled node identifier.
   * @returns matching node record, when present.
   */
  public getNode(nodeId: HubNodeIdType): HubNodeRecord | undefined {
    const row = this.database.prepare('SELECT * FROM nodes WHERE node_id = ?').get(nodeId)
    return row === undefined ? undefined : nodeFromRow(row)
  }

  /**
   * Return all enrolled nodes in stable display order.
   * @returns all node records, including revoked identities.
   */
  public listNodes(): HubNodeRecord[] {
    return this.database.prepare('SELECT * FROM nodes ORDER BY display_name, node_id').all().map(nodeFromRow)
  }

  /**
   * Reject future connections and invalidate every runtime for one node.
   * @param nodeId - active node to revoke.
   * @param now - revocation clock in Unix milliseconds.
   */
  public revokeNode(nodeId: HubNodeIdType, now = Date.now()): void {
    hubTransaction(this.database, () => {
      const result = this.database.prepare(`
        UPDATE nodes SET status = 'revoked', revoked_at = ?, updated_at = ?
        WHERE node_id = ? AND status = 'active'
      `).run(now, now, nodeId)
      if (Number(result.changes) !== 1) throw new Error('active node not found')
      this.database.prepare('UPDATE runtimes SET online = 0 WHERE node_id = ?').run(nodeId)
      this.database.prepare('UPDATE session_index SET stale = 1 WHERE node_id = ?').run(nodeId)
    })
  }

  /**
   * Start an authenticated connection and return its strictly increasing generation.
   * @param nodeId - active authenticated node.
   * @param now - connection clock in Unix milliseconds.
   * @returns new strictly increasing connection generation.
   */
  public beginConnection(nodeId: HubNodeIdType, now = Date.now()): number {
    return hubTransaction(this.database, () => {
      const current = this.requireActiveNode(nodeId)
      const generation = current.connectionGeneration + 1
      this.database.prepare(`
        UPDATE nodes SET connection_generation = ?, last_seen_at = ?, updated_at = ? WHERE node_id = ?
      `).run(generation, now, now, nodeId)
      this.database.prepare('UPDATE runtimes SET online = 0 WHERE node_id = ?').run(nodeId)
      return generation
    })
  }

  /**
   * Insert or replace the authoritative runtime capability baseline.
   * @param input - complete runtime baseline from the Connector.
   */
  public upsertRuntime(input: HubRuntimeInput): void {
    this.requireActiveNode(input.nodeId)
    this.database.prepare(`
      INSERT INTO runtimes (
        node_id, runtime_id, boot_id, dsh_version, connector_version,
        capabilities_json, online, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (node_id, runtime_id) DO UPDATE SET
        boot_id = excluded.boot_id,
        dsh_version = excluded.dsh_version,
        connector_version = excluded.connector_version,
        capabilities_json = excluded.capabilities_json,
        online = excluded.online,
        last_seen_at = excluded.last_seen_at
    `).run(
      input.nodeId, input.runtimeId, input.bootId, input.dshVersion, input.connectorVersion,
      canonicalHubJson(input.capabilities), input.online ? 1 : 0, input.lastSeenAt,
    )
  }

  /**
   * Return runtime baselines in stable node and runtime order.
   * @param nodeId - optional node filter.
   * @returns matching runtime baselines.
   */
  public listRuntimes(nodeId?: HubNodeIdType): HubRuntimeRecord[] {
    const rows = nodeId === undefined
      ? this.database.prepare('SELECT * FROM runtimes ORDER BY node_id, runtime_id').all()
      : this.database.prepare('SELECT * FROM runtimes WHERE node_id = ? ORDER BY runtime_id').all(nodeId)
    return rows.map(row => ({
      nodeId: HubNodeId(String(row.node_id)),
      runtimeId: HubRuntimeId(String(row.runtime_id)),
      bootId: String(row.boot_id),
      dshVersion: String(row.dsh_version),
      connectorVersion: String(row.connector_version),
      capabilities: parseJson(row.capabilities_json),
      online: Number(row.online) === 1,
      lastSeenAt: Number(row.last_seen_at),
    }))
  }

  /**
   * Mark every runtime and indexed session on a disconnected node stale.
   * @param nodeId - disconnected node identifier.
   */
  public markNodeDisconnected(nodeId: HubNodeIdType): void {
    hubTransaction(this.database, () => {
      this.database.prepare('UPDATE runtimes SET online = 0 WHERE node_id = ?').run(nodeId)
      this.database.prepare('UPDATE session_index SET stale = 1 WHERE node_id = ?').run(nodeId)
    })
  }

  /**
   * Mark one departed runtime and its discovery projection offline.
   * @param nodeId - owning node identifier.
   * @param runtimeId - departed runtime identifier.
   */
  public markRuntimeDisconnected(nodeId: HubNodeIdType, runtimeId: HubRuntimeIdType): void {
    hubTransaction(this.database, () => {
      this.database.prepare(`
        UPDATE runtimes SET online = 0 WHERE node_id = ? AND runtime_id = ?
      `).run(nodeId, runtimeId)
      this.database.prepare(`
        UPDATE session_index SET stale = 1 WHERE node_id = ? AND runtime_id = ?
      `).run(nodeId, runtimeId)
    })
  }

  /**
   * Upsert one discovery-only session projection without storing its transcript.
   * @param input - complete discovery projection.
   */
  public upsertSessionIndex(input: HubSessionIndexInput): void {
    this.database.prepare(`
      INSERT INTO session_index (
        hub_session_id, node_id, runtime_id, source_id, title, updated_at, running, stale
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (node_id, runtime_id, source_id) DO UPDATE SET
        hub_session_id = excluded.hub_session_id,
        title = excluded.title,
        updated_at = excluded.updated_at,
        running = excluded.running,
        stale = excluded.stale
    `).run(
      input.hubSessionId, input.nodeId, input.runtimeId, input.sourceId, input.title ?? null,
      input.updatedAt, input.running ? 1 : 0, input.stale ? 1 : 0,
    )
  }

  /**
   * Atomically replace one runtime's authoritative discovery baseline.
   * @param nodeId - owning node identifier.
   * @param runtimeId - owning runtime identifier.
   * @param sessions - current complete session discovery list.
   */
  public replaceSessionIndex(nodeId: HubNodeIdType, runtimeId: HubRuntimeIdType, sessions: readonly HubSessionIndexInput[]): void {
    hubTransaction(this.database, () => {
      this.database.prepare(`
        UPDATE session_index SET stale = 1 WHERE node_id = ? AND runtime_id = ?
      `).run(nodeId, runtimeId)
      for (const input of sessions) this.upsertSessionIndex(input)
    })
  }

  /**
   * Return the non-authoritative session discovery index without transcript content.
   * @param nodeId - optional node filter.
   * @returns matching discovery records.
   */
  public listSessionIndex(nodeId?: HubNodeIdType): HubSessionIndexRecord[] {
    const rows = nodeId === undefined
      ? this.database.prepare('SELECT * FROM session_index ORDER BY updated_at DESC, hub_session_id').all()
      : this.database.prepare(`
          SELECT * FROM session_index WHERE node_id = ? ORDER BY updated_at DESC, hub_session_id
        `).all(nodeId)
    return rows.map((row) => {
      const record: HubSessionIndexRecord = {
        hubSessionId: String(row.hub_session_id),
        nodeId: HubNodeId(String(row.node_id)),
        runtimeId: HubRuntimeId(String(row.runtime_id)),
        sourceId: String(row.source_id),
        updatedAt: Number(row.updated_at),
        running: Number(row.running) === 1,
        stale: Number(row.stale) === 1,
      }
      const title = optionalString(row.title)
      if (title !== undefined) record.title = title
      return record
    })
  }

  /**
   * Persist operator intent before attempting network delivery.
   * @param input - complete validated command intent.
   * @returns persisted pending command record.
   */
  public createCommand(input: HubCommandInput): HubCommandRecord {
    const payloadJson = canonicalHubJson(input.payload)
    this.database.prepare(`
      INSERT INTO commands (
        command_id, node_id, runtime_id, capability, capability_ver, operation,
        idempotency, idempotency_key, payload_json, payload_hash, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      input.commandId, input.nodeId, input.runtimeId ?? null, input.capability,
      input.capabilityVersion, input.operation, input.idempotency, input.idempotencyKey ?? null,
      payloadJson, hubJsonHash(input.payload), input.createdAt, input.createdAt,
    )
    return this.requireCommand(input.commandId)
  }

  /**
   * Load all non-terminal commands in deterministic delivery order.
   * @param nodeId - optional destination-node filter.
   * @returns recoverable command records.
   */
  public listRecoverableCommands(nodeId?: HubNodeIdType): HubCommandRecord[] {
    const sql = `SELECT * FROM commands
      WHERE status IN ('pending', 'sent', 'running')${nodeId === undefined ? '' : ' AND node_id = ?'}
      ORDER BY created_at, command_id`
    const rows = nodeId === undefined
      ? this.database.prepare(sql).all()
      : this.database.prepare(sql).all(nodeId)
    return rows.map(commandFromRow)
  }

  /**
   * Return recent command lifecycle metadata for operator inspection.
   * @param limit - maximum record count.
   * @param nodeId - optional destination-node filter.
   * @returns newest matching command records.
   */
  public listCommands(limit = 100, nodeId?: HubNodeIdType): HubCommandRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('command limit must be 1..1000')
    const rows = nodeId === undefined
      ? this.database.prepare('SELECT * FROM commands ORDER BY created_at DESC LIMIT ?').all(limit)
      : this.database.prepare(`
          SELECT * FROM commands WHERE node_id = ? ORDER BY created_at DESC LIMIT ?
        `).all(nodeId, limit)
    return rows.map(commandFromRow)
  }

  /**
   * Return one command record.
   * @param commandId - command identifier.
   * @returns matching command record, when present.
   */
  public getCommand(commandId: string): HubCommandRecord | undefined {
    const row = this.database.prepare('SELECT * FROM commands WHERE command_id = ?').get(commandId)
    return row === undefined ? undefined : commandFromRow(row)
  }

  /**
   * Apply a legal command transition and optionally persist its terminal result.
   * @param commandId - command identifier.
   * @param status - legal next lifecycle status.
   * @param result - required terminal result or omitted non-terminal result.
   * @param now - transition clock in Unix milliseconds.
   * @returns updated command record.
   */
  public transitionCommand(commandId: string, status: HubCommandStatus, result: HubJson | undefined, now = Date.now()): HubCommandRecord {
    return hubTransaction(this.database, () => {
      const current = this.requireCommand(commandId)
      if (!COMMAND_TRANSITIONS[current.status].includes(status)) {
        throw new Error(`illegal command transition ${current.status} -> ${status}`)
      }
      const terminal = TERMINAL_COMMANDS.has(status)
      if (terminal !== (result !== undefined)) throw new Error('terminal commands require a result and non-terminal commands forbid it')
      const resultJson = result === undefined ? null : canonicalHubJson(result)
      this.database.prepare(`
        UPDATE commands SET status = ?, result_json = ?, result_hash = ?, updated_at = ?, terminal_at = ?
        WHERE command_id = ?
      `).run(status, resultJson, result === undefined ? null : hubJsonHash(result), now, terminal ? now : null, commandId)
      return this.requireCommand(commandId)
    })
  }

  /**
   * Remove delivered command bodies while retaining hashes, state, and auditability.
   * @param commandId - terminal command identifier.
   */
  public redactTerminalCommandContent(commandId: string): void {
    const result = this.database.prepare(`
      UPDATE commands SET payload_json = NULL, result_json = NULL
      WHERE command_id = ? AND status IN ('ok', 'error', 'outcome-unknown')
    `).run(commandId)
    if (Number(result.changes) !== 1) throw new Error('terminal command not found')
  }

  /**
   * Discard command bodies whose terminal result retention window elapsed.
   * @param before - exclusive terminal timestamp cutoff in Unix milliseconds.
   * @returns number of command records redacted.
   */
  public redactTerminalCommandContentBefore(before: number): number {
    if (!Number.isSafeInteger(before) || before < 0) throw new Error('invalid command redaction cutoff')
    const result = this.database.prepare(`
      UPDATE commands SET payload_json = NULL, result_json = NULL
      WHERE terminal_at < ? AND (payload_json IS NOT NULL OR result_json IS NOT NULL)
    `).run(before)
    return Number(result.changes)
  }

  /**
   * Append one hash-chained, immutable audit record.
   * @param input - complete audit event without chain metadata.
   * @returns persisted record with sequence and hashes.
   */
  public appendAudit(input: HubAuditInput): HubAuditRecord {
    return hubTransaction(this.database, () => {
      const prior = this.database.prepare(`
        SELECT record_hash FROM audit_log ORDER BY sequence DESC LIMIT 1
      `).get()
      const previousHash = prior === undefined ? '0'.repeat(43) : String(prior.record_hash)
      const detailsJson = canonicalHubJson(input.details)
      const hashInput: HubJson = {
        occurredAt: input.occurredAt,
        actor: input.actor,
        action: input.action,
        nodeId: input.nodeId ?? null,
        runtimeId: input.runtimeId ?? null,
        resourceId: input.resourceId ?? null,
        outcome: input.outcome,
        details: input.details,
        previousHash,
      }
      const recordHash = hubJsonHash(hashInput)
      const result = this.database.prepare(`
        INSERT INTO audit_log (
          occurred_at, actor, action, node_id, runtime_id, resource_id,
          outcome, details_json, previous_hash, record_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.occurredAt, input.actor, input.action, input.nodeId ?? null, input.runtimeId ?? null,
        input.resourceId ?? null, input.outcome, detailsJson, previousHash, recordHash,
      )
      return { ...input, sequence: Number(result.lastInsertRowid), previousHash, recordHash }
    })
  }

  /**
   * Return recent audit records in reverse chronological order.
   * @param limit - maximum record count.
   * @param nodeId - optional node filter.
   * @returns newest matching immutable audit records.
   */
  public listAudit(limit = 100, nodeId?: HubNodeIdType): HubAuditRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('audit limit must be 1..1000')
    const rows = nodeId === undefined
      ? this.database.prepare('SELECT * FROM audit_log ORDER BY sequence DESC LIMIT ?').all(limit)
      : this.database.prepare(`
          SELECT * FROM audit_log WHERE node_id = ? ORDER BY sequence DESC LIMIT ?
        `).all(nodeId, limit)
    return rows.map(auditFromRow)
  }

  /** Verify the complete audit hash chain and reject any discontinuity. */
  public verifyAuditChain(): void {
    let previousHash = '0'.repeat(43)
    const rows = this.database.prepare('SELECT * FROM audit_log ORDER BY sequence').all()
    for (const row of rows) {
      if (String(row.previous_hash) !== previousHash) throw new Error('audit chain discontinuity')
      const details = parseJson(row.details_json)
      const expected = hubJsonHash({
        occurredAt: Number(row.occurred_at),
        actor: String(row.actor),
        action: String(row.action),
        nodeId: row.node_id === null ? null : String(row.node_id),
        runtimeId: row.runtime_id === null ? null : String(row.runtime_id),
        resourceId: row.resource_id === null ? null : String(row.resource_id),
        outcome: String(row.outcome),
        details,
        previousHash,
      })
      if (expected !== String(row.record_hash)) throw new Error('audit record hash mismatch')
      previousHash = expected
    }
  }

  /**
   * Create an online, transactionally consistent SQLite backup.
   * @param path - destination database path.
   * @returns number of pages copied by SQLite backup.
   */
  public async backupTo(path: string): Promise<number> {
    const actual = resolve(path)
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
    const pages = await backup(this.database, actual)
    await chmod(actual, 0o600)
    return pages
  }

  private requireNode(nodeId: HubNodeIdType): HubNodeRecord {
    const node = this.getNode(nodeId)
    if (node === undefined) throw new Error('node not found')
    return node
  }

  private requireActiveNode(nodeId: HubNodeIdType): HubNodeRecord {
    const node = this.requireNode(nodeId)
    if (node.status !== 'active') throw new Error('node is revoked')
    return node
  }

  private requireCommand(commandId: string): HubCommandRecord {
    const row = this.database.prepare('SELECT * FROM commands WHERE command_id = ?').get(commandId)
    if (row === undefined) throw new Error('command not found')
    return commandFromRow(row)
  }
}
