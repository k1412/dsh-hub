import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

export type Mode = 'tailscale' | 'tailcat'
export interface NodeRecord {
  id: string; name: string; mode: Mode; clientId: string; credentialHash: string
  dshVersion: string; runtimeId: string; createdAt: number; lastSeen: number; revokedAt: number | null
}
export interface Invitation {
  tokenHash: string; mode: Mode; endpoint: string; name: string; expiresAt: number; nodeId: string | null
}
export const secret = (): string => randomBytes(32).toString('base64url')
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
export function matches(value: string, hash: string): boolean {
  return /^[a-f0-9]{64}$/.test(hash) && timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(hash, 'hex'))
}

/** Only pairing and browser authorization live here; no DSH business records. */
export class GatewayStore {
  private readonly db: DatabaseSync
  constructor(path: string, private readonly now: () => number = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL, clientId TEXT NOT NULL UNIQUE,
        credentialHash TEXT NOT NULL, dshVersion TEXT NOT NULL, runtimeId TEXT NOT NULL,
        createdAt INTEGER NOT NULL, lastSeen INTEGER NOT NULL, revokedAt INTEGER);
      CREATE TABLE IF NOT EXISTS invitations (
        tokenHash TEXT PRIMARY KEY, mode TEXT NOT NULL, endpoint TEXT NOT NULL, name TEXT NOT NULL,
        expiresAt INTEGER NOT NULL, nodeId TEXT);
      CREATE TABLE IF NOT EXISTS sessions (
        tokenHash TEXT PRIMARY KEY, scope TEXT NOT NULL, expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tickets (
        tokenHash TEXT PRIMARY KEY, nodeId TEXT NOT NULL, expiresAt INTEGER NOT NULL);`)
  }
  nodes(): NodeRecord[] { return this.db.prepare('SELECT * FROM nodes ORDER BY createdAt').all() as unknown as NodeRecord[] }
  node(id: string): NodeRecord | undefined { return this.db.prepare('SELECT * FROM nodes WHERE id=?').get(id) as unknown as NodeRecord | undefined }
  invite(mode: Mode, endpoint: string, name: string): { token: string; invitation: Invitation } {
    const token = secret()
    const invitation = { tokenHash: digest(token), mode, endpoint, name, expiresAt: this.now() + 15 * 60_000, nodeId: null }
    this.db.prepare('INSERT INTO invitations VALUES (?,?,?,?,?,NULL)').run(invitation.tokenHash, mode, endpoint, name, invitation.expiresAt)
    return { token, invitation }
  }
  invitation(token: string): Invitation | undefined {
    return this.db.prepare('SELECT * FROM invitations WHERE tokenHash=?').get(digest(token)) as unknown as Invitation | undefined
  }
  enroll(input: { inviteToken: string; clientId: string; credential: string; name: string; dshVersion: string; runtimeId: string }): NodeRecord {
    const invite = this.invitation(input.inviteToken)
    if (!invite) throw new Error('邀请无效，请在 Hub 重新生成安装命令。')
    if (invite.nodeId) {
      const current = this.node(invite.nodeId)
      if (current && !current.revokedAt && current.clientId === input.clientId && current.runtimeId === input.runtimeId && matches(input.credential, current.credentialHash)) return current
      throw new Error('邀请已使用。每个 node 需要单独的邀请。')
    }
    if (invite.expiresAt <= this.now()) throw new Error('邀请已过期，请重新生成。')
    const existing = this.db.prepare('SELECT id FROM nodes WHERE clientId=?').get(input.clientId)
    if (existing) throw new Error('此身份已经配对，请使用原连接配置或先撤销。')
    const node: NodeRecord = { id: `n${randomBytes(8).toString('hex')}`, name: invite.name || input.name,
      mode: invite.mode, clientId: input.clientId, credentialHash: digest(input.credential), dshVersion: input.dshVersion,
      runtimeId: input.runtimeId, createdAt: this.now(), lastSeen: 0, revokedAt: null }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?,NULL)').run(node.id, node.name, node.mode, node.clientId,
        node.credentialHash, node.dshVersion, node.runtimeId, node.createdAt, node.lastSeen)
      this.db.prepare('UPDATE invitations SET nodeId=? WHERE tokenHash=?').run(node.id, invite.tokenHash)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return node
  }
  authenticate(id: string, credential: string): NodeRecord | undefined {
    const node = this.node(id)
    return node && !node.revokedAt && matches(credential, node.credentialHash) ? node : undefined
  }
  seen(id: string, version: string): void {
    this.db.prepare('UPDATE nodes SET lastSeen=?, dshVersion=? WHERE id=?').run(this.now(), version, id)
  }
  revoke(id: string): void {
    this.db.prepare('UPDATE nodes SET revokedAt=? WHERE id=?').run(this.now(), id)
    this.db.prepare('DELETE FROM sessions WHERE scope=?').run(id)
    this.db.prepare('DELETE FROM tickets WHERE nodeId=?').run(id)
  }
  rename(id: string, name: string): void { this.db.prepare('UPDATE nodes SET name=? WHERE id=?').run(name, id) }
  session(scope: string, duration = 8 * 60 * 60_000): string {
    const token = secret()
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token), scope, this.now() + duration)
    return token
  }
  authorized(token: string, scope: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM sessions WHERE tokenHash=? AND scope=? AND expiresAt>?').get(digest(token), scope, this.now())
  }
  logout(token: string): void { this.db.prepare('DELETE FROM sessions WHERE tokenHash=?').run(digest(token)) }
  ticket(nodeId: string, kind: 'node' | 'session' = 'node'): string {
    const token = `${kind === 'session' ? 's.' : ''}${secret()}`
    this.db.prepare('INSERT INTO tickets VALUES (?,?,?)').run(digest(token), nodeId, this.now() + 60_000)
    return token
  }
  consumeTicket(token: string, nodeId: string): boolean {
    const row = this.db.prepare('DELETE FROM tickets WHERE tokenHash=? AND nodeId=? AND expiresAt>? RETURNING nodeId').get(digest(token), nodeId, this.now())
    return !!row
  }
  prune(): void {
    for (const table of ['sessions', 'tickets']) this.db.prepare(`DELETE FROM ${table} WHERE expiresAt<=?`).run(this.now())
    this.db.prepare('DELETE FROM invitations WHERE expiresAt<?').run(this.now() - 24 * 60 * 60_000)
  }
  close(): void { this.db.close() }
}
