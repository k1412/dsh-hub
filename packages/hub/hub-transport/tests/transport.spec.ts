import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  generateHubIdentity, HubMessageId, HubNodeId, signHubEnvelope,
  type HubEnvelopeBody,
} from '@k1412/dsh-hub-protocol'
import { ReliablePeer, SqliteReliableJournal } from '../src/index.ts'

const databases: DatabaseSync[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function peerPair(generation = 1, nodeBoot = 'node-boot-0000001', hubBoot = 'hub-boot-00000001') {
  const nodeIdentity = generateHubIdentity()
  const hubIdentity = generateHubIdentity()
  const nodeDatabase = new DatabaseSync(':memory:')
  const hubDatabase = new DatabaseSync(':memory:')
  databases.push(nodeDatabase, hubDatabase)
  const nodeJournal = new SqliteReliableJournal(nodeDatabase, 'hub')
  const hubJournal = new SqliteReliableJournal(hubDatabase, 'node')
  const nodeId = HubNodeId('test-node')
  const node = new ReliablePeer({
    nodeId,
    localBootId: nodeBoot,
    expectedRemoteBootId: hubBoot,
    connectionGeneration: generation,
    localPrivateKey: nodeIdentity.privateKey,
    remotePublicKey: hubIdentity.publicKey,
    journal: nodeJournal,
  })
  const hub = new ReliablePeer({
    nodeId,
    localBootId: hubBoot,
    expectedRemoteBootId: nodeBoot,
    connectionGeneration: generation,
    localPrivateKey: hubIdentity.privateKey,
    remotePublicKey: nodeIdentity.publicKey,
    journal: hubJournal,
  })
  return { node, hub, nodeJournal, hubJournal, nodeId, nodeIdentity, hubIdentity }
}

const hello: HubEnvelopeBody = {
  type: 'runtime.hello',
  runtimeId: 'default-runtime',
  bootId: 'runtime-boot-0001',
  dshVersion: '0.1.0-rc.5',
  connectorVersion: '0.1.0-rc.5',
  capabilities: [],
}

describe('reliable Hub transport', () => {
  it('persists before delivery, deduplicates replay, and clears only after a peer acknowledgement', () => {
    const { node, hub, nodeJournal, hubJournal } = peerPair()
    const record = node.enqueue(hello, 1_000)
    const [frame] = node.renderPending(1_001)
    expect(frame?.directionSequence).toBe(record.sequence)
    const accepted = hub.receive(frame, 1_002)
    expect(accepted.kind).toBe('accepted')
    expect(hub.receive(frame, 1_003)).toEqual({ kind: 'duplicate', sequence: 1 })
    expect(nodeJournal.pendingOutbound()).toHaveLength(1)

    const claimed = hubJournal.claimInbound(1, 1_004)
    expect(claimed?.body).toEqual(hello)
    hubJournal.completeInbound(1, 1_005)
    hub.enqueueAcknowledgement(1_006)
    const [ack] = hub.renderPending(1_007)
    expect(node.receive(ack, 1_008).kind).toBe('accepted')
    expect(nodeJournal.pendingOutbound()).toHaveLength(0)
  })

  it('re-signs an unacknowledged record for a new connection generation and boot', () => {
    const first = peerPair(1, 'node-boot-0000001')
    const record = first.node.enqueue(hello, 2_000)
    const [oldFrame] = first.node.renderPending(2_001)

    const nodeJournal = first.nodeJournal
    const hubJournal = first.hubJournal
    const restartedNode = new ReliablePeer({
      nodeId: first.nodeId,
      localBootId: 'node-boot-0000002',
      expectedRemoteBootId: 'hub-boot-00000001',
      connectionGeneration: 2,
      localPrivateKey: first.nodeIdentity.privateKey,
      remotePublicKey: first.hubIdentity.publicKey,
      journal: nodeJournal,
    })
    const reconnectedHub = new ReliablePeer({
      nodeId: first.nodeId,
      localBootId: 'hub-boot-00000001',
      expectedRemoteBootId: 'node-boot-0000002',
      connectionGeneration: 2,
      localPrivateKey: first.hubIdentity.privateKey,
      remotePublicKey: first.nodeIdentity.publicKey,
      journal: hubJournal,
    })
    const [newFrame] = restartedNode.renderPending(2_002)
    expect(newFrame).toMatchObject({
      messageId: record.messageId,
      directionSequence: record.sequence,
      connectionGeneration: 2,
      bootId: 'node-boot-0000002',
    })
    expect(newFrame?.signature).not.toBe(oldFrame?.signature)
    expect(reconnectedHub.receive(oldFrame, 2_003)).toMatchObject({ kind: 'rejected', reason: 'fenced-generation' })
    expect(reconnectedHub.receive(newFrame, 2_003).kind).toBe('accepted')
  })

  it('rejects gaps, wrong boot ids, tampering, and acknowledgements beyond allocated state', () => {
    const { node, hub, nodeId, nodeIdentity } = peerPair()
    node.enqueue(hello, 3_000)
    const [valid] = node.renderPending(3_001)
    expect(valid).toBeDefined()
    const gap = signHubEnvelope({
      protocolVersion: 1,
      nodeId,
      bootId: 'node-boot-0000001',
      connectionGeneration: 1,
      messageId: 'message-gap-0000001',
      directionSequence: 2,
      cumulativeAck: 0,
      issuedAt: 3_001,
      expiresAt: 33_001,
      body: hello,
    }, nodeIdentity.privateKey)
    expect(hub.receive(gap, 3_002)).toMatchObject({
      kind: 'rejected', reason: 'sequence-gap', expectedSequence: 1, receivedSequence: 2,
    })

    const wrongBoot = { ...valid, bootId: 'wrong-boot-000001' }
    expect(hub.receive(wrongBoot, 3_002)).toMatchObject({ kind: 'rejected', reason: 'signature' })
    const tampered = { ...valid, body: { type: 'transport.ack' } }
    expect(hub.receive(tampered, 3_002)).toMatchObject({ kind: 'rejected', reason: 'body-hash' })

    const excessiveAck = signHubEnvelope({
      protocolVersion: 1,
      nodeId,
      bootId: 'node-boot-0000001',
      connectionGeneration: 1,
      messageId: 'message-ack-0000001',
      directionSequence: 1,
      cumulativeAck: 1,
      issuedAt: 3_001,
      expiresAt: 33_001,
      body: hello,
    }, nodeIdentity.privateKey)
    expect(hub.receive(excessiveAck, 3_002)).toMatchObject({ kind: 'rejected', reason: 'ack-out-of-range' })
  })

  it('recovers both unclaimed and crash-interrupted inbound work', () => {
    const { node, hub, hubJournal } = peerPair()
    node.enqueue(hello, 4_000)
    const [first] = node.renderPending(4_001)
    expect(hub.receive(first, 4_002).kind).toBe('accepted')
    expect(hubJournal.recoverableInbound()).toMatchObject([{ sequence: 1, recovery: false }])
    expect(hubJournal.claimInbound(1, 4_003)?.recovery).toBe(false)
    expect(hubJournal.recoverableInbound()).toMatchObject([{ sequence: 1, recovery: true }])
    expect(hubJournal.claimInbound(1, 4_004)?.recovery).toBe(true)
    hubJournal.completeInbound(1, 4_005)
    expect(hubJournal.recoverableInbound()).toEqual([])
  })

  it('pages recoverable inbound work without repeating an unfinished earlier page', () => {
    const { node, hub, hubJournal } = peerPair()
    for (let index = 0; index < 3; index += 1) node.enqueue(hello, 4_100 + index)
    for (const frame of node.renderPending(4_200)) expect(hub.receive(frame, 4_201).kind).toBe('accepted')

    const first = hubJournal.recoverableInboundAfter(0, 2)
    const second = hubJournal.recoverableInboundAfter(first.at(-1)?.sequence ?? 0, 2)
    expect(first.map(record => record.sequence)).toEqual([1, 2])
    expect(second.map(record => record.sequence)).toEqual([3])
  })

  it('coalesces idle acknowledgement records and enforces an outbound byte quota', () => {
    const database = new DatabaseSync(':memory:')
    databases.push(database)
    const journal = new SqliteReliableJournal(database, 'hub', { maxOutboundRecords: 2, maxOutboundBytes: 80 })
    const first = journal.enqueue({ type: 'transport.ack' }, 5_000)
    expect(journal.pendingAcknowledgement()?.messageId).toBe(first.messageId)
    const pair = peerPair()
    const acknowledgement = pair.node.enqueueAcknowledgement(5_001)
    expect(pair.node.enqueueAcknowledgement(5_002).messageId).toBe(acknowledgement.messageId)
    expect(() => journal.enqueue({
      type: 'runtime.resync-required',
      reason: 'operator-request',
      runtimeId: 'a-runtime-with-a-long-name',
    }, 5_003)).toThrow(/quota/)
  })

  it('reports one body type without counting large command results as stream backlog', () => {
    const database = new DatabaseSync(':memory:')
    databases.push(database)
    const journal = new SqliteReliableJournal(database, 'hub')
    journal.enqueue({
      type: 'capability.result',
      commandId: 'large-result-command-001',
      status: 'ok',
      value: { body: 'x'.repeat(4 * 1024 * 1024) },
    }, 5_100)
    journal.enqueue({
      type: 'stream.frame',
      runtimeId: 'default-runtime',
      streamId: 'stream-usage-test-0001',
      capability: 'dsh.web',
      stream: 'mux',
      frameSequence: 1,
      payload: {},
    }, 5_101)

    expect(journal.outboundUsage()).toMatchObject({ records: 2 })
    expect(journal.outboundUsage().bytes).toBeGreaterThan(4 * 1024 * 1024)
    expect(journal.outboundUsageForBodyType('stream.frame')).toMatchObject({
      records: 1,
      oldestCreatedAt: 5_101,
    })
    expect(journal.outboundUsageForBodyType('stream.frame').bytes).toBeLessThan(1_024)
  })

  it('migrates durable byte usage and keeps it exact across acknowledgement and reopen', () => {
    const database = new DatabaseSync(':memory:')
    databases.push(database)
    database.exec(`
      CREATE TABLE reliable_peer_state (
        peer_id TEXT PRIMARY KEY,
        outbound_sequence INTEGER NOT NULL DEFAULT 0 CHECK (outbound_sequence >= 0),
        outbound_ack INTEGER NOT NULL DEFAULT 0 CHECK (outbound_ack >= 0),
        inbound_ack INTEGER NOT NULL DEFAULT 0 CHECK (inbound_ack >= 0)
      ) STRICT;
      CREATE TABLE reliable_outbox (
        peer_id TEXT NOT NULL REFERENCES reliable_peer_state(peer_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        message_id TEXT NOT NULL,
        body_json TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        body_size INTEGER NOT NULL CHECK (body_size >= 0),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (peer_id, sequence),
        UNIQUE (peer_id, message_id)
      ) STRICT;
      INSERT INTO reliable_peer_state (peer_id, outbound_sequence) VALUES ('hub', 2);
      INSERT INTO reliable_outbox
        (peer_id, sequence, message_id, body_json, body_hash, body_size, created_at)
      VALUES
        ('hub', 1, 'migration-message-01', '{"type":"transport.ack"}', 'hash-one', 24, 6100),
        ('hub', 2, 'migration-message-02', '{"type":"transport.ack"}', 'hash-two', 25, 6200);
    `)

    const migrated = new SqliteReliableJournal(database, 'hub')
    expect(migrated.outboundUsage()).toMatchObject({ records: 2, bytes: 49, oldestCreatedAt: 6_100 })
    migrated.acknowledgeOutbound(1)
    expect(migrated.outboundUsage()).toMatchObject({ records: 1, bytes: 25, oldestCreatedAt: 6_200 })
    const reopened = new SqliteReliableJournal(database, 'hub')
    expect(reopened.outboundUsage()).toMatchObject({ records: 1, bytes: 25 })
    reopened.acknowledgeOutbound(2)
    expect(reopened.outboundUsage()).toMatchObject({ records: 0, bytes: 0, oldestCreatedAt: 0 })
  })

  it('does not dispatch a duplicate message id under a different sequence', () => {
    const { hub, nodeId, nodeIdentity } = peerPair()
    const first = signHubEnvelope({
      protocolVersion: 1,
      nodeId,
      bootId: 'node-boot-0000001',
      connectionGeneration: 1,
      messageId: 'reused-message-00001',
      directionSequence: 1,
      cumulativeAck: 0,
      issuedAt: 6_000,
      expiresAt: 36_000,
      body: hello,
    }, nodeIdentity.privateKey)
    expect(hub.receive(first, 6_001).kind).toBe('accepted')
    const reused = signHubEnvelope({
      protocolVersion: 1,
      nodeId,
      bootId: 'node-boot-0000001',
      connectionGeneration: 1,
      messageId: 'reused-message-00001',
      directionSequence: 2,
      cumulativeAck: 0,
      issuedAt: 6_002,
      expiresAt: 36_002,
      body: { type: 'transport.ack' },
    }, nodeIdentity.privateKey)
    expect(hub.receive(reused, 6_003)).toMatchObject({ kind: 'rejected', reason: 'sequence-conflict' })
  })

  it('pages and signs an exactly full outbox beyond the first render window', () => {
    const { node, nodeJournal } = peerPair()
    for (let index = 1; index <= 10_000; index += 1) {
      nodeJournal.enqueue(
        { type: 'transport.ack' },
        7_000 + index,
        HubMessageId(`full-outbox-${String(index).padStart(8, '0')}`),
      )
    }
    expect(nodeJournal.outboundUsage()).toMatchObject({
      records: 10_000,
      maxRecords: 10_000,
      oldestCreatedAt: 7_001,
    })
    expect(() => nodeJournal.enqueue({ type: 'transport.ack' }, 18_000)).toThrow(/quota/)

    const sequences: number[] = []
    let cursor = 0
    for (;;) {
      const page = node.renderPendingAfter(cursor, 20_000, 257)
      if (page.length === 0) break
      sequences.push(...page.map(frame => frame.directionSequence))
      cursor = page.at(-1)?.directionSequence ?? cursor
    }
    expect(sequences).toHaveLength(10_000)
    expect(sequences[0]).toBe(1)
    expect(sequences.at(-1)).toBe(10_000)
  }, 30_000)
})
