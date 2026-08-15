import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HubNodeId, HubRuntimeId } from '@k1412/dsh-hub-protocol'
import {
  HubControlStore, HubObjectStore, HubStorage, openHubDatabase,
} from '../src/index.ts'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hub-storage-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function enrolledStore() {
  const root = await temporaryRoot()
  const storage = await HubStorage.open(join(root, 'control', 'hub.db'), join(root, 'data'))
  const nodeId = HubNodeId('test-node')
  const grant = storage.control.createEnrollment(nodeId, 'Test Node', 2_000, 1_000)
  const node = storage.control.consumeEnrollment(grant.code, 'test-public-key', 'service-token-id', 1_001)
  return { root, storage, nodeId, node, grant }
}

describe('Hub control storage', () => {
  it('consumes an enrollment secret once and stores only its hash', async () => {
    const { root, storage, nodeId, node, grant } = await enrolledStore()
    expect(node).toMatchObject({ nodeId, status: 'active', publicKey: 'test-public-key' })
    expect(() => storage.control.consumeEnrollment('invalid-secret', 'key', undefined, 1_002)).toThrow(/invalid or expired/)

    storage.close()
    const bytes = await readFile(join(root, 'control', 'hub.db'))
    expect(bytes.includes(Buffer.from(grant.code))).toBe(false)
  })

  it('increments connection generations and fences revoked nodes', async () => {
    const { storage, nodeId } = await enrolledStore()
    expect(storage.control.beginConnection(nodeId, 2_000)).toBe(1)
    expect(storage.control.beginConnection(nodeId, 2_001)).toBe(2)
    storage.control.revokeNode(nodeId, 2_002)
    expect(() => storage.control.beginConnection(nodeId, 2_003)).toThrow(/revoked/)
    storage.close()
  })

  it('persists minimal session discovery and legal command recovery state', async () => {
    const { storage, nodeId } = await enrolledStore()
    const runtimeId = HubRuntimeId('default-runtime')
    storage.control.upsertRuntime({
      nodeId,
      runtimeId,
      bootId: randomBytes(16).toString('base64url'),
      dshVersion: '0.1.0-rc.5',
      connectorVersion: '0.1.0-rc.5',
      capabilities: [],
      online: true,
      lastSeenAt: 3_000,
    })
    storage.control.upsertSessionIndex({
      hubSessionId: 'hub-session-1',
      nodeId,
      runtimeId,
      sourceId: 'local-session-1',
      title: 'Minimal title',
      updatedAt: 3_001,
      running: false,
      stale: false,
    })
    const command = storage.control.createCommand({
      commandId: 'command-000000000001',
      nodeId,
      runtimeId,
      capability: 'dsh.session',
      capabilityVersion: '1.0.0',
      operation: 'message.append',
      idempotency: 'reconcile',
      idempotencyKey: 'attempt-000000000001',
      payload: { sessionId: 'local-session-1', message: 'continue' },
      createdAt: 3_002,
    })
    expect(command.status).toBe('pending')
    expect(storage.control.listRecoverableCommands(nodeId)).toHaveLength(1)
    storage.control.transitionCommand(command.commandId, 'sent', undefined, 3_003)
    storage.control.transitionCommand(command.commandId, 'running', undefined, 3_004)
    const complete = storage.control.transitionCommand(command.commandId, 'ok', { accepted: true }, 3_005)
    expect(complete.resultHash).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(storage.control.listRecoverableCommands(nodeId)).toHaveLength(0)
    expect(() => storage.control.transitionCommand(command.commandId, 'error', { code: 'late' }, 3_006)).toThrow(/illegal/)
    storage.control.redactTerminalCommandContent(command.commandId)
    storage.close()
  })

  it('chains audit records and makes the table append-only', async () => {
    const root = await temporaryRoot()
    const database = await openHubDatabase(join(root, 'hub.db'))
    const control = new HubControlStore(database)
    const first = control.appendAudit({
      occurredAt: 1_000,
      actor: 'operator:test',
      action: 'node.enrollment.created',
      outcome: 'ok',
      details: { nodeId: 'test-node' },
    })
    const second = control.appendAudit({
      occurredAt: 1_001,
      actor: 'node:test-node',
      action: 'node.connected',
      outcome: 'ok',
      details: {},
    })
    expect(second.previousHash).toBe(first.recordHash)
    expect(control.listAudit()).toEqual([second, first])
    expect(() =>{  database.exec('DELETE FROM audit_log') }).toThrow(/append-only/)
    control.verifyAuditChain()
    database.close()
  })

  it('redacts completed command bodies individually and by retention cutoff', async () => {
    const { storage, nodeId } = await enrolledStore()
    const create = (commandId: string, createdAt: number) => storage.control.createCommand({
      commandId,
      nodeId,
      capability: 'dsh.files',
      capabilityVersion: '1.0.0',
      operation: 'read',
      idempotency: 'read',
      payload: { path: `/private/${commandId}` },
      createdAt,
    })
    create('command-redaction-0001', 1_100)
    create('command-redaction-0002', 1_200)
    storage.control.transitionCommand('command-redaction-0001', 'error', { message: 'sensitive result' }, 1_300)
    storage.control.transitionCommand('command-redaction-0002', 'error', { message: 'new result' }, 1_400)
    storage.control.redactTerminalCommandContent('command-redaction-0002')
    expect(storage.control.getCommand('command-redaction-0002')).toMatchObject({ payload: null })
    expect(storage.control.getCommand('command-redaction-0002')?.result).toBeUndefined()
    expect(storage.control.redactTerminalCommandContentBefore(1_350)).toBe(1)
    expect(storage.control.getCommand('command-redaction-0001')).toMatchObject({ payload: null })
    storage.close()
  })

  it('creates a restorable online SQLite backup with owner-only mode', async () => {
    const { root, storage } = await enrolledStore()
    const destination = join(root, 'backups', 'hub.db')
    await storage.control.backupTo(destination)
    expect((await stat(destination)).mode & 0o777).toBe(0o600)
    storage.close()

    const restored = await openHubDatabase(destination)
    expect(new HubControlStore(restored).listNodes()).toHaveLength(1)
    restored.close()
  })
})

describe('Hub durable object storage', () => {
  it('atomically deduplicates, verifies, references, and collects explicit objects', async () => {
    const root = await temporaryRoot()
    const database = await openHubDatabase(join(root, 'hub.db'))
    const objects = await HubObjectStore.open(database, join(root, 'data'))
    const bytes = Buffer.from('immutable plugin artifact')
    const first = await objects.putBytes('plugin-artifact', bytes, 'application/gzip', 1_000)
    const second = await objects.putBytes('plugin-artifact', bytes, 'application/gzip', 1_001)
    expect(second.objectHash).toBe(first.objectHash)
    expect(await objects.readBytes(first.objectHash)).toEqual(bytes)
    await expect(objects.verifyAll()).resolves.toBe(1)
    objects.addReference('plugin-release', 'release-1', first.objectHash, 1_002)
    objects.addReference('plugin-release', 'release-1', first.objectHash, 1_003)
    expect(await objects.collectUnreferenced(2_000)).toEqual([])
    objects.removeReference('plugin-release', 'release-1', first.objectHash)
    expect(await objects.collectUnreferenced(2_000)).toEqual([first.objectHash])
    expect(() => objects.objectPath(first.objectHash)).toThrow(/not found/)
    database.close()
  })

  it('contains no transcript, workspace, terminal, log, or credential tables', async () => {
    const root = await temporaryRoot()
    const database = await openHubDatabase(join(root, 'hub.db'))
    const names = database.prepare(`
      SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name
    `).all().map(row => String(row.name)).join(' ')
    expect(names).not.toMatch(/transcript|workspace|terminal|credential|message|attachment|cache|log_output/)
    database.close()
  })
})
