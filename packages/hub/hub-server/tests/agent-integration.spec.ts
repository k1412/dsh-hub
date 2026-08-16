import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionsCapability, terminalsCapability, webCapability } from '@k1412/dsh-hub-capabilities'
import {
  generateHubIdentity, HubCommandId, HubMessageId, HubNodeId, HubRuntimeId, signHubEnvelope,
  verifyHubEnvelope, type HubEnvelopeBody,
} from '@k1412/dsh-hub-protocol'
import { HubStorage } from '@k1412/dsh-hub-storage'
import { ReliablePeer, SqliteReliableJournal } from '@k1412/dsh-hub-transport'
import type { HubAccessVerifier } from '../src/server.ts'
import { HubServer } from '../src/server.ts'

const roots: string[] = []
const servers: HubServer[] = []
const sockets: WebSocket[] = []
const databases: DatabaseSync[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  for (const database of databases.splice(0)) database.close()
  await Promise.allSettled(servers.splice(0).map(server => server.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const access: HubAccessVerifier = {
  async verifyHuman() {
    return { kind: 'human', email: 'operator@example.com', subject: 'subject', expiresAt: Math.floor(Date.now() / 1_000) + 60 }
  },
  async verifyService() {
    return { kind: 'service', commonName: 'node-token.access', expiresAt: Math.floor(Date.now() / 1_000) + 60 }
  },
}

function socketQueue(socket: WebSocket) {
  const values: unknown[] = []
  const waiting: Array<(value: unknown) => void> = []
  socket.on('message', (data, binary) => {
    if (binary) throw new Error('unexpected binary frame')
    const bytes = Array.isArray(data)
      ? Buffer.concat(data)
      : data instanceof ArrayBuffer ? Buffer.from(data) : data
    const text = bytes.toString('utf8')
    const value = JSON.parse(text) as unknown
    const resolve = waiting.shift()
    if (resolve === undefined) values.push(value)
    else resolve(value)
  })
  return (): Promise<unknown> => {
    const value = values.shift()
    return value === undefined
      ? new Promise<unknown>(resolve => waiting.push(resolve))
      : Promise.resolve(value)
  }
}

function send(socket: WebSocket, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(JSON.stringify(value), (error) => {
      if (error == null) resolve()
      else reject(error)
    })
  })
}

describe('Hub Agent WebSocket integration', () => {
  it('enrolls, authenticates, announces a runtime, invokes a capability, and records its result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hub-agent-integration-'))
    roots.push(root)
    const storage = await HubStorage.open(join(root, 'hub.db'))
    const hubIdentity = generateHubIdentity()
    const nodeIdentity = generateHubIdentity()
    const nodeId = HubNodeId('node-a')
    const runtimeId = HubRuntimeId('default-runtime')
    const nodeBootId = HubMessageId(randomBytes(18).toString('base64url'))
    const enrollment = storage.control.createEnrollment(nodeId, 'Node A', Date.now() + 60_000)
    const serverErrors: unknown[] = []
    const server = new HubServer({
      storage,
      access,
      originGuard: { permits: () => true },
      hubIdentity,
      publicOrigin: 'https://hub.example.com',
      reportError: error => serverErrors.push(error),
    })
    servers.push(server)
    const address = await server.listen('127.0.0.1', 0)
    const socket = new WebSocket(
      `ws://127.0.0.1:${String(address.port)}/hub/v1/agent?nodeId=node-a&bootId=${nodeBootId}`,
    )
    sockets.push(socket)
    const next = socketQueue(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const challengeInput = await next()
    const challenge = verifyHubEnvelope(challengeInput, hubIdentity.publicKey)
    expect(challenge.ok).toBe(true)
    expect(serverErrors).toEqual([])
    if (!challenge.ok || challenge.envelope.body.type !== 'auth.challenge') throw new Error('invalid challenge')
    const now = Date.now()
    await send(socket, signHubEnvelope({
      protocolVersion: 1,
      nodeId,
      bootId: nodeBootId,
      connectionGeneration: 0,
      messageId: HubMessageId(randomBytes(18).toString('base64url')),
      directionSequence: 1,
      cumulativeAck: 0,
      issuedAt: now,
      expiresAt: now + 10_000,
      body: {
        type: 'auth.node-proof',
        publicKey: nodeIdentity.publicKey,
        challenge: challenge.envelope.body.challenge,
        enrollmentCode: enrollment.code,
        agentVersion: '0.1.0-rc.5',
        protocolMin: 1,
        protocolMax: 1,
      },
    }, nodeIdentity.privateKey))
    const acceptedInput = await next()
    const accepted = verifyHubEnvelope(acceptedInput, hubIdentity.publicKey)
    expect(accepted.ok).toBe(true)
    if (!accepted.ok || accepted.envelope.body.type !== 'auth.accepted') throw new Error('invalid acceptance')

    const nodeDatabase = new DatabaseSync(':memory:')
    databases.push(nodeDatabase)
    const nodeJournal = new SqliteReliableJournal(nodeDatabase, 'hub')
    const peer = new ReliablePeer({
      nodeId,
      localBootId: nodeBootId,
      expectedRemoteBootId: accepted.envelope.bootId,
      connectionGeneration: accepted.envelope.connectionGeneration,
      localPrivateKey: nodeIdentity.privateKey,
      remotePublicKey: hubIdentity.publicKey,
      journal: nodeJournal,
    })
    peer.enqueue({
      type: 'runtime.hello',
      runtimeId,
      bootId: 'runtime-boot-00001',
      dshVersion: '0.1.0-rc.5',
      connectorVersion: '1.0.0',
      capabilities: [sessionsCapability.descriptor, terminalsCapability.descriptor, webCapability.descriptor],
    })
    await Promise.all(peer.renderPending().map(frame => send(socket, frame)))
    await vi.waitFor(() => { expect(storage.control.listRuntimes(nodeId)).toMatchObject([{
      runtimeId,
      online: true,
    }]) })

    const ackInput = await next()
    const ack = peer.receive(ackInput)
    expect(ack.kind).toBe('accepted')
    if (ack.kind !== 'accepted') throw new Error('invalid acknowledgement')
    const claimedAck = nodeJournal.claimInbound(ack.record.sequence)
    expect(claimedAck?.body.type).toBe('transport.ack')
    nodeJournal.completeInbound(ack.record.sequence)
    peer.enqueueAcknowledgement()
    await Promise.all(peer.renderPending().map(frame => send(socket, frame)))

    peer.enqueue({
      type: 'stream.frame',
      runtimeId,
      capability: 'dsh.sessions',
      streamId: HubMessageId('session-index-stream-01'),
      stream: 'index',
      frameSequence: 1,
      payload: {
        revision: 1,
        sessions: [{
          sessionId: 'session-project-one',
          title: 'Project conversation',
          workspacePath: '/workspace/project-one',
          updatedAt: 3_000,
          running: false,
          eventSequence: 4,
        }],
      },
    })
    await Promise.all(peer.renderPending().map(frame => send(socket, frame)))
    await vi.waitFor(() => { expect(storage.control.listSessionIndex(nodeId)).toMatchObject([{
      nodeId,
      runtimeId,
      sourceId: 'session-project-one',
      title: 'Project conversation',
      workspacePath: '/workspace/project-one',
      stale: false,
    }]) })

    const command = await server.agents.invoke(
      nodeId,
      runtimeId,
      'dsh.sessions',
      '1.0.0',
      'list',
      { limit: 100 },
      'human:operator@example.com',
    )
    let claimedCommand: ReturnType<typeof nodeJournal.claimInbound>
    while (claimedCommand === undefined) {
      const receivedCommand = peer.receive(await next())
      if (receivedCommand.kind === 'duplicate') continue
      expect(receivedCommand.kind).toBe('accepted')
      if (receivedCommand.kind !== 'accepted') throw new Error('invalid command')
      const claimed = nodeJournal.claimInbound(receivedCommand.record.sequence)
      if (claimed === undefined) continue
      nodeJournal.completeInbound(receivedCommand.record.sequence)
      if (claimed.body.type !== 'transport.ack') claimedCommand = claimed
    }
    expect(claimedCommand?.body).toMatchObject({ type: 'capability.invoke', commandId: command.commandId })
    peer.enqueue({
      type: 'capability.result',
      commandId: command.commandId,
      status: 'ok',
      value: { sessions: [] },
    })
    await Promise.all(peer.renderPending().map(frame => send(socket, frame)))
    await vi.waitFor(() => { expect(storage.control.getCommand(command.commandId)).toMatchObject({
      status: 'ok',
      result: { sessions: [] },
    }) })
    expect(storage.control.getNode(nodeId)).toMatchObject({
      publicKey: nodeIdentity.publicKey,
      serviceIdentity: 'node-token.access',
      status: 'active',
    })

    const nextAgentCommand = async (
      operation: string,
      capability = 'dsh.terminals',
    ) => {
      while (true) {
        const input = await next()
        const received = peer.receive(input)
        if (received.kind === 'duplicate') continue
        expect(received.kind).toBe('accepted')
        if (received.kind !== 'accepted') throw new Error(`Agent frame rejected: ${received.reason}`)
        const claimed = nodeJournal.claimInbound(received.record.sequence)
        if (claimed === undefined) throw new Error('Agent frame was not claimable')
        nodeJournal.completeInbound(received.record.sequence)
        if (claimed.body.type === 'transport.ack') continue
        expect(claimed.body).toMatchObject({
          type: 'capability.invoke', capability, operation,
        })
        if (claimed.body.type !== 'capability.invoke') throw new Error('expected terminal capability command')
        return claimed.body
      }
    }
    const flushNode = async () => {
      await Promise.all(peer.renderPending().map(frame => send(socket, frame)))
    }

    const rootRedirect = await fetch(`http://127.0.0.1:${String(address.port)}/`, { redirect: 'manual' })
    expect(rootRedirect.status).toBe(302)
    expect(rootRedirect.headers.get('location')).toBe('/?nodeId=node-a&runtimeId=default-runtime')

    const officialRequest = fetch(
      `http://127.0.0.1:${String(address.port)}/api/host.describe?nodeId=node-a&runtimeId=default-runtime`,
    )
    const officialFetch = await nextAgentCommand('fetch', 'dsh.web')
    expect(officialFetch.payload).toMatchObject({ method: 'GET', path: '/api/host.describe' })
    peer.enqueue({
      type: 'capability.result',
      commandId: officialFetch.commandId,
      status: 'ok',
      value: {
        status: 200,
        headers: [['content-type', 'application/json; charset=utf-8']],
        encoding: 'utf8',
        body: JSON.stringify({ rpcId: 'hub-web', result: { ok: true, value: { version: '0.1.0-rc.5' } } }),
      },
    })
    await flushNode()
    const officialResponse = await officialRequest
    expect(officialResponse.status).toBe(200)
    await expect(officialResponse.json()).resolves.toMatchObject({
      result: { ok: true, value: { version: '0.1.0-rc.5' } },
    })

    const officialSocket = new WebSocket(
      `ws://127.0.0.1:${String(address.port)}/api/events.mux?nodeId=node-a&runtimeId=default-runtime`,
      { origin: 'https://hub.example.com' },
    )
    sockets.push(officialSocket)
    const nextOfficial = socketQueue(officialSocket)
    await new Promise<void>((resolve, reject) => {
      officialSocket.once('open', resolve)
      officialSocket.once('error', reject)
    })
    const officialFrame = {
      type: 'server-request',
      rpcId: 'stream-rpc-1',
      method: 'session/event',
      payload: { type: 'session/event', payload: { sessionId: 'session-project-one' } },
    }
    peer.enqueue({
      type: 'stream.frame',
      runtimeId,
      capability: 'dsh.web',
      streamId: HubMessageId('official-mux-stream-01'),
      stream: 'mux',
      frameSequence: 1,
      payload: officialFrame,
    })
    await flushNode()
    await expect(nextOfficial()).resolves.toEqual(officialFrame)
    officialSocket.close()

    // A command can be enqueued while an earlier socket send is still in
    // progress. The flush pump must drain that tail without waiting for an
    // unrelated later event to wake it.
    const burstCommands = await Promise.all(Array.from({ length: 8 }, () => server.agents.invoke(
      nodeId,
      runtimeId,
      'dsh.sessions',
      '1.0.0',
      'list',
      { limit: 10 },
      'human:operator@example.com',
    )))
    const burstBodies = []
    for (let index = 0; index < burstCommands.length; index += 1) {
      burstBodies.push(await nextAgentCommand('list', 'dsh.sessions'))
    }
    expect(new Set(burstBodies.map(body => body.commandId))).toEqual(
      new Set(burstCommands.map(command => command.commandId)),
    )
    for (const body of burstBodies) {
      peer.enqueue({
        type: 'capability.result',
        commandId: body.commandId,
        status: 'ok',
        value: { sessions: [] },
      })
    }
    await flushNode()
    await vi.waitFor(() => {
      expect(burstCommands.map(command => storage.control.getCommand(command.commandId)?.status))
        .toEqual(burstCommands.map(() => 'ok'))
    })
    const burstIds = new Set(burstCommands.map(command => command.commandId))
    while (nodeJournal.pendingOutbound(100).some(record =>
      record.body.type === 'capability.result' && burstIds.has(record.body.commandId))) {
      const input = await Promise.race([
        next(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => { reject(new Error('refreshed cumulative acknowledgement was not delivered')) }, 1_000)
        }),
      ])
      const received = peer.receive(input)
      if (received.kind !== 'accepted') continue
      const claimed = nodeJournal.claimInbound(received.record.sequence)
      if (claimed !== undefined) {
        nodeJournal.completeInbound(claimed.sequence)
        nodeJournal.pruneProcessed()
      }
    }

    const terminalSocket = new WebSocket(
      `ws://127.0.0.1:${String(address.port)}/hub/v1/terminal?nodeId=node-a&runtimeId=default-runtime&columns=100&rows=30`,
      { origin: 'https://hub.example.com' },
    )
    sockets.push(terminalSocket)
    const nextTerminal = socketQueue(terminalSocket)
    await new Promise<void>((resolve, reject) => {
      terminalSocket.once('open', resolve)
      terminalSocket.once('error', reject)
    })
    const open = await nextAgentCommand('open')
    expect(open.payload).toMatchObject({ columns: 100, rows: 30 })
    peer.enqueue({
      type: 'capability.result', commandId: open.commandId, status: 'ok', value: { terminalId: 'terminal-one' },
    })
    await flushNode()
    await expect(nextTerminal()).resolves.toEqual({ type: 'opened', terminalId: 'terminal-one' })

    await send(terminalSocket, { type: 'input', data: 'printf hub-terminal' })
    const write = await nextAgentCommand('write')
    expect(write.payload).toEqual({ terminalId: 'terminal-one', encoding: 'utf8', data: 'printf hub-terminal' })
    peer.enqueue({ type: 'capability.result', commandId: write.commandId, status: 'ok', value: { ok: true } })
    await flushNode()
    peer.enqueue({
      type: 'stream.frame',
      runtimeId,
      capability: 'dsh.terminals',
      streamId: HubMessageId('terminal-output-stream-01'),
      stream: 'output',
      frameSequence: 1,
      payload: {
        terminalId: 'terminal-one', sequence: 1, encoding: 'utf8', data: 'hub-terminal', eof: false,
      },
    })
    await flushNode()
    await expect(nextTerminal()).resolves.toEqual({
      type: 'output', terminalId: 'terminal-one', sequence: 1, encoding: 'utf8', data: 'hub-terminal', eof: false,
    })

    terminalSocket.close()
    const close = await nextAgentCommand('close')
    expect(close.payload).toEqual({ terminalId: 'terminal-one' })
    peer.enqueue({ type: 'capability.result', commandId: close.commandId, status: 'ok', value: { ok: true } })
    await flushNode()

    const disconnected = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
    socket.close()
    await disconnected
    await vi.waitFor(() => { expect(server.agents.isOnline(nodeId)).toBe(false) })

    const offlineCommand = await server.agents.invoke(
      nodeId, runtimeId, 'dsh.sessions', '1.0.0', 'list', { limit: 9 }, 'human:operator@example.com',
    )
    expect(offlineCommand.status).toBe('sent')
    const recoveredCommandId = HubCommandId(randomBytes(18).toString('base64url'))
    storage.control.createCommand({
      commandId: recoveredCommandId,
      nodeId,
      runtimeId,
      capability: 'dsh.sessions',
      capabilityVersion: '1.0.0',
      operation: 'list',
      idempotency: 'read',
      payload: { limit: 17 },
      createdAt: Date.now(),
    })

    const reconnectBootId = HubMessageId(randomBytes(18).toString('base64url'))
    const reconnectedSocket = new WebSocket(
      `ws://127.0.0.1:${String(address.port)}/hub/v1/agent?nodeId=node-a&bootId=${reconnectBootId}`,
    )
    sockets.push(reconnectedSocket)
    const nextReconnected = socketQueue(reconnectedSocket)
    await new Promise<void>((resolve, reject) => {
      reconnectedSocket.once('open', resolve)
      reconnectedSocket.once('error', reject)
    })
    const reconnectChallengeInput = await nextReconnected()
    const reconnectChallenge = verifyHubEnvelope(reconnectChallengeInput, hubIdentity.publicKey)
    expect(reconnectChallenge.ok).toBe(true)
    if (!reconnectChallenge.ok || reconnectChallenge.envelope.body.type !== 'auth.challenge') {
      throw new Error('invalid reconnect challenge')
    }
    const reconnectAt = Date.now()
    await send(reconnectedSocket, signHubEnvelope({
      protocolVersion: 1,
      nodeId,
      bootId: reconnectBootId,
      connectionGeneration: 0,
      messageId: HubMessageId(randomBytes(18).toString('base64url')),
      directionSequence: 1,
      cumulativeAck: nodeJournal.inboundAcknowledgement(),
      issuedAt: reconnectAt,
      expiresAt: reconnectAt + 10_000,
      body: {
        type: 'auth.node-proof',
        publicKey: nodeIdentity.publicKey,
        challenge: reconnectChallenge.envelope.body.challenge,
        agentVersion: '0.1.0-rc.5',
        protocolMin: 1,
        protocolMax: 1,
      },
    }, nodeIdentity.privateKey))
    const reconnectAcceptedInput = await nextReconnected()
    const reconnectAccepted = verifyHubEnvelope(reconnectAcceptedInput, hubIdentity.publicKey)
    expect(reconnectAccepted.ok).toBe(true)
    if (!reconnectAccepted.ok || reconnectAccepted.envelope.body.type !== 'auth.accepted') {
      throw new Error('invalid reconnect acceptance')
    }
    nodeJournal.acknowledgeOutbound(reconnectAccepted.envelope.body.hubAck)
    const reconnectedPeer = new ReliablePeer({
      nodeId,
      localBootId: reconnectBootId,
      expectedRemoteBootId: reconnectAccepted.envelope.bootId,
      connectionGeneration: reconnectAccepted.envelope.connectionGeneration,
      localPrivateKey: nodeIdentity.privateKey,
      remotePublicKey: hubIdentity.publicKey,
      journal: nodeJournal,
    })

    const recoveredInvocations = new Map<string, Extract<HubEnvelopeBody, { type: 'capability.invoke' }>>()
    while (recoveredInvocations.size < 2) {
      const received = reconnectedPeer.receive(await nextReconnected())
      if (received.kind === 'duplicate') continue
      expect(received.kind).toBe('accepted')
      if (received.kind !== 'accepted') throw new Error(`reconnected frame rejected: ${received.reason}`)
      const claimed = nodeJournal.claimInbound(received.record.sequence)
      if (claimed === undefined) throw new Error('reconnected frame was not claimable')
      nodeJournal.completeInbound(claimed.sequence)
      if (claimed.body.type === 'capability.invoke'
        && (claimed.body.commandId === recoveredCommandId || claimed.body.commandId === offlineCommand.commandId)) {
        recoveredInvocations.set(claimed.body.commandId, claimed.body)
      }
    }
    expect(recoveredInvocations.get(recoveredCommandId)?.payload).toEqual({ limit: 17 })
    expect(recoveredInvocations.get(offlineCommand.commandId)?.payload).toEqual({ limit: 9 })
    expect(storage.control.getCommand(recoveredCommandId)?.status).toBe('sent')
    for (const commandId of [offlineCommand.commandId, recoveredCommandId]) {
      reconnectedPeer.enqueue({
        type: 'capability.result',
        commandId,
        status: 'ok',
        value: { sessions: [] },
      })
    }
    await Promise.all(reconnectedPeer.renderPending().map(frame => send(reconnectedSocket, frame)))
    await vi.waitFor(() => { expect(storage.control.getCommand(recoveredCommandId)?.status).toBe('ok') })
    expect(storage.control.getCommand(offlineCommand.commandId)?.status).toBe('ok')
    expect(storage.control.listAudit(100, nodeId).filter(record =>
      record.action === 'command.completed' && record.resourceId === recoveredCommandId)).toHaveLength(1)

    const nodeClosed = new Promise<number>((resolve) => { reconnectedSocket.once('close', resolve) })
    const revoked = await fetch(`http://127.0.0.1:${String(address.port)}/hub/v1/nodes/node-a/revoke`, {
      method: 'POST',
      headers: { origin: 'https://hub.example.com', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(revoked.status).toBe(200)
    await expect(nodeClosed).resolves.toBe(4003)
    expect(server.agents.isOnline(nodeId)).toBe(false)
    expect(storage.control.getNode(nodeId)?.status).toBe('revoked')
  })
})
