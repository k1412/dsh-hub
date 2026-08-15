import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  generateHubIdentity, HubNodeId, signHubEnvelope,
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
})
