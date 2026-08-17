import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runtimeCapability, sessionsCapability, webCapability } from '@k1412/dsh-hub-capabilities'
import {
  generateHubIdentity, HubMessageId, HubNodeId, HubRuntimeId, signHubEnvelope,
  verifyHubEnvelope, type HubEnvelopeBody, type HubIdentityKeyPair,
} from '@k1412/dsh-hub-protocol'
import { HubStorage } from '@k1412/dsh-hub-storage'
import { ReliablePeer, SqliteReliableJournal } from '@k1412/dsh-hub-transport'
import type { HubAccessVerifier } from '../src/server.ts'
import { HubServer } from '../src/server.ts'
import { encodeFleetId } from '../src/fleet-web.ts'

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
    return {
      kind: 'human', email: 'operator@example.com', subject: 'operator',
      expiresAt: Math.floor(Date.now() / 1_000) + 60,
    }
  },
  async verifyService() {
    return {
      kind: 'service', commonName: 'node-token.access',
      expiresAt: Math.floor(Date.now() / 1_000) + 60,
    }
  },
}

function socketQueue(socket: WebSocket): () => Promise<unknown> {
  const values: unknown[] = []
  const waiting: Array<(value: unknown) => void> = []
  socket.on('message', (data, binary) => {
    if (binary) throw new Error('unexpected binary Agent frame')
    const bytes = Array.isArray(data)
      ? Buffer.concat(data)
      : data instanceof ArrayBuffer ? Buffer.from(data) : data
    const value = JSON.parse(bytes.toString('utf8')) as unknown
    const resolve = waiting.shift()
    if (resolve === undefined) values.push(value)
    else resolve(value)
  })
  return async () => {
    const value = values.shift()
    return value === undefined
      ? await new Promise<unknown>(resolve => waiting.push(resolve))
      : value
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

interface SignedNode {
  nodeId: ReturnType<typeof HubNodeId>
  runtimeId: ReturnType<typeof HubRuntimeId>
  identity: HubIdentityKeyPair
  journal: SqliteReliableJournal
  socket: WebSocket
  peer: ReliablePeer
  next: () => Promise<unknown>
  flush(): Promise<void>
  nextCommand(): Promise<Extract<HubEnvelopeBody, { type: 'capability.invoke' }>>
  respond(commandId: string, value: unknown): Promise<void>
}

async function openSignedNode(options: {
  storage: HubStorage
  hubIdentity: HubIdentityKeyPair
  port: number
  nodeName: string
  existing?: Pick<SignedNode, 'nodeId' | 'runtimeId' | 'identity' | 'journal'>
}): Promise<SignedNode> {
  const nodeId = options.existing?.nodeId ?? HubNodeId(options.nodeName)
  const runtimeId = options.existing?.runtimeId ?? HubRuntimeId('default')
  const identity = options.existing?.identity ?? generateHubIdentity()
  const database = options.existing === undefined ? new DatabaseSync(':memory:') : undefined
  if (database !== undefined) databases.push(database)
  const journal = options.existing?.journal ?? new SqliteReliableJournal(database as DatabaseSync, 'hub')
  const enrollment = options.existing === undefined
    ? options.storage.control.createEnrollment(nodeId, options.nodeName, Date.now() + 60_000)
    : undefined
  const bootId = HubMessageId(randomBytes(18).toString('base64url'))
  const socket = new WebSocket(
    `ws://127.0.0.1:${String(options.port)}/hub/v1/agent?nodeId=${nodeId}&bootId=${bootId}`,
  )
  sockets.push(socket)
  const next = socketQueue(socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const challengeInput = await next()
  const challenge = verifyHubEnvelope(challengeInput, options.hubIdentity.publicKey)
  if (!challenge.ok || challenge.envelope.body.type !== 'auth.challenge') {
    throw new Error(`invalid challenge for ${nodeId}`)
  }
  const now = Date.now()
  await send(socket, signHubEnvelope({
    protocolVersion: 1,
    nodeId,
    bootId,
    connectionGeneration: 0,
    messageId: HubMessageId(randomBytes(18).toString('base64url')),
    directionSequence: 1,
    cumulativeAck: journal.inboundAcknowledgement(),
    issuedAt: now,
    expiresAt: now + 10_000,
    body: {
      type: 'auth.node-proof',
      publicKey: identity.publicKey,
      challenge: challenge.envelope.body.challenge,
      ...(enrollment === undefined ? {} : { enrollmentCode: enrollment.code }),
      agentVersion: '0.1.0',
      protocolMin: 1,
      protocolMax: 1,
    },
  }, identity.privateKey))
  const acceptedInput = await next()
  const accepted = verifyHubEnvelope(acceptedInput, options.hubIdentity.publicKey)
  if (!accepted.ok || accepted.envelope.body.type !== 'auth.accepted') {
    throw new Error(`invalid acceptance for ${nodeId}`)
  }
  journal.acknowledgeOutbound(accepted.envelope.body.hubAck)
  const peer = new ReliablePeer({
    nodeId,
    localBootId: bootId,
    expectedRemoteBootId: accepted.envelope.bootId,
    connectionGeneration: accepted.envelope.connectionGeneration,
    localPrivateKey: identity.privateKey,
    remotePublicKey: options.hubIdentity.publicKey,
    journal,
  })
  const node: SignedNode = {
    nodeId,
    runtimeId,
    identity,
    journal,
    socket,
    peer,
    next,
    async flush() {
      await Promise.all(this.peer.renderPending().map(frame => send(this.socket, frame)))
    },
    async nextCommand() {
      for (;;) {
        const received = this.peer.receive(await this.next())
        if (received.kind === 'duplicate') continue
        if (received.kind !== 'accepted') throw new Error(`${this.nodeId} rejected Hub frame: ${received.reason}`)
        const claimed = this.journal.claimInbound(received.record.sequence)
        if (claimed === undefined) continue
        this.journal.completeInbound(claimed.sequence)
        this.journal.pruneProcessed()
        if (claimed.body.type === 'transport.ack') continue
        if (claimed.body.type !== 'capability.invoke') {
          throw new Error(`${this.nodeId} received unexpected ${claimed.body.type}`)
        }
        return claimed.body
      }
    },
    async respond(commandId, value) {
      this.peer.enqueue({
        type: 'capability.result', commandId, status: 'ok', value: value as never,
      })
      await this.flush()
    },
  }
  node.peer.enqueue({
    type: 'runtime.hello',
    runtimeId,
    bootId: `runtime-${options.nodeName}-boot`,
    dshVersion: '0.1.0',
    connectorVersion: '0.1.0',
    capabilities: [sessionsCapability.descriptor, runtimeCapability.descriptor, webCapability.descriptor],
  })
  await node.flush()
  await vi.waitFor(() => {
    expect(options.storage.control.listRuntimes(nodeId)).toContainEqual(expect.objectContaining({
      runtimeId, online: true,
    }))
  })
  return node
}

describe('Hub simultaneous multi-node integration', () => {
  it('isolates concurrent commands, survives one stalled/disconnected node, and recovers only its backlog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hub-multi-node-'))
    roots.push(root)
    const storage = await HubStorage.open(join(root, 'hub.db'))
    const hubIdentity = generateHubIdentity()
    const server = new HubServer({
      storage,
      access,
      originGuard: { permits: () => true },
      hubIdentity,
      publicOrigin: 'https://hub.example.com',
    })
    servers.push(server)
    const address = await server.listen('127.0.0.1', 0)
    const [home, nas] = await Promise.all([
      openSignedNode({ storage, hubIdentity, port: address.port, nodeName: 'home-node' }),
      openSignedNode({ storage, hubIdentity, port: address.port, nodeName: 'nas-node' }),
    ])

    expect(server.agents.isOnline(home.nodeId)).toBe(true)
    expect(server.agents.isOnline(nas.nodeId)).toBe(true)

    const [homeRecord, nasRecord] = await Promise.all([
      server.agents.invoke(
        home.nodeId, home.runtimeId, 'dsh.sessions', '1.0.0', 'message.append',
        { clientMutationId: 'home-message', sessionId: 'home-session', text: 'from home', attachments: [] },
        'human:operator@example.com',
      ),
      server.agents.invoke(
        nas.nodeId, nas.runtimeId, 'dsh.sessions', '1.0.0', 'message.append',
        { clientMutationId: 'nas-message', sessionId: 'nas-session', text: 'from nas', attachments: [] },
        'human:operator@example.com',
      ),
    ])
    const [homeCommand, nasCommand] = await Promise.all([home.nextCommand(), nas.nextCommand()])
    expect(homeCommand).toMatchObject({
      commandId: homeRecord.commandId,
      runtimeId: home.runtimeId,
      payload: { sessionId: 'home-session', text: 'from home' },
    })
    expect(nasCommand).toMatchObject({
      commandId: nasRecord.commandId,
      runtimeId: nas.runtimeId,
      payload: { sessionId: 'nas-session', text: 'from nas' },
    })

    // Leave Home stalled while NAS completes: one node's control path must
    // not share a wait queue or timeout fate with another node.
    await nas.respond(nasCommand.commandId, { accepted: true, eventSequence: 12 })
    await vi.waitFor(() => { expect(storage.control.getCommand(nasRecord.commandId)?.status).toBe('ok') })
    expect(storage.control.getCommand(homeRecord.commandId)?.status).not.toBe('ok')
    await home.respond(homeCommand.commandId, { accepted: true, eventSequence: 7 })
    await vi.waitFor(() => { expect(storage.control.getCommand(homeRecord.commandId)?.status).toBe('ok') })

    const homeHistoryRequest = fetch(
      `http://127.0.0.1:${String(address.port)}/api/session.history?nodeId=home-node&runtimeId=default`,
      {
        method: 'POST',
        headers: { origin: 'https://hub.example.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'home-history-rpc', method: 'session.history',
          payload: { sessionId: 'home-session', maxMessages: 2_000 },
        }),
      },
    )
    const homeHistory = await home.nextCommand()
    expect(homeHistory).toMatchObject({
      capability: 'dsh.web', operation: 'fetch',
      payload: { path: '/api/session.history' },
    })

    // A stalled bulk Web read on Home must not hold NAS's independent Goal
    // control request or route the NAS result back to the wrong browser call.
    const nasGoalRequest = fetch(
      `http://127.0.0.1:${String(address.port)}/api/goals/pause?nodeId=nas-node&runtimeId=default`,
      {
        method: 'POST',
        headers: { origin: 'https://hub.example.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'nas-goal-rpc', method: 'goals/pause',
          payload: { sessionId: 'nas-session', ref: { id: 'nas-goal', revision: 1 } },
        }),
      },
    )
    const nasGoal = await nas.nextCommand()
    expect(nasGoal).toMatchObject({
      capability: 'dsh.web', operation: 'fetch',
      payload: { path: '/api/goals/pause' },
    })
    await nas.respond(nasGoal.commandId, {
      status: 200,
      headers: [['content-type', 'application/json; charset=utf-8']],
      encoding: 'utf8',
      body: JSON.stringify({
        type: 'server-response', rpcId: 'nas-goal-rpc',
        result: { ok: true, value: { goal: { id: 'nas-goal', revision: 2, phase: 'paused' } } },
      }),
    })
    const nasGoalResponse = await nasGoalRequest
    expect(nasGoalResponse.status).toBe(200)
    await expect(nasGoalResponse.json()).resolves.toMatchObject({
      rpcId: 'nas-goal-rpc', result: { ok: true },
    })

    const nasFleetSession = encodeFleetId('session', {
      nodeId: nas.nodeId, runtimeId: nas.runtimeId,
    }, 'nas-session')
    const nasClearRequest = fetch(
      `http://127.0.0.1:${String(address.port)}/api/goals/clear`,
      {
        method: 'POST',
        headers: { origin: 'https://hub.example.com', 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'nas-goal-clear-rpc', method: 'goals/clear',
          payload: {
            args: { agentId: nasFleetSession, ref: { id: 'nas-goal', revision: 2 } },
          },
        }),
      },
    )
    const nasClear = await nas.nextCommand()
    expect(nasClear).toMatchObject({
      capability: 'dsh.web', operation: 'fetch', payload: { path: '/api/goals/clear' },
    })
    const clearBody = JSON.parse(String((nasClear.payload as { body?: unknown }).body)) as {
      payload?: { args?: unknown }
    }
    expect(clearBody.payload?.args).toEqual({
      agentId: 'nas-session', ref: { id: 'nas-goal', revision: 2 },
    })
    await nas.respond(nasClear.commandId, {
      status: 200,
      headers: [['content-type', 'application/json; charset=utf-8']],
      encoding: 'utf8',
      body: JSON.stringify({
        type: 'server-response', rpcId: 'nas-goal-clear-rpc',
        result: { ok: true, value: { id: 'nas-goal', revision: 3 } },
      }),
    })
    expect((await nasClearRequest).status).toBe(200)
    expect(storage.control.getCommand(homeHistory.commandId)?.status).not.toBe('ok')

    await home.respond(homeHistory.commandId, {
      status: 200,
      headers: [['content-type', 'application/json; charset=utf-8']],
      encoding: 'utf8',
      body: JSON.stringify({
        type: 'server-response', rpcId: 'home-history-rpc',
        result: { ok: true, value: { events: [], hasMore: false } },
      }),
    })
    expect((await homeHistoryRequest).status).toBe(200)

    const homeClosed = new Promise<void>((resolve) => { home.socket.once('close', () => { resolve() }) })
    home.socket.close()
    await homeClosed
    await vi.waitFor(() => { expect(server.agents.isOnline(home.nodeId)).toBe(false) })
    expect(server.agents.isOnline(nas.nodeId)).toBe(true)

    const nasHealthRecord = await server.agents.invoke(
      nas.nodeId, nas.runtimeId, 'dsh.runtime', '1.0.0', 'health', {},
      'human:operator@example.com',
    )
    const nasHealth = await nas.nextCommand()
    expect(nasHealth.commandId).toBe(nasHealthRecord.commandId)
    await nas.respond(nasHealth.commandId, {
      status: 'healthy', startedAt: 1, dshVersion: '0.1.0', connectorVersion: '0.1.0',
      details: { node: 'nas-node' },
    })
    await vi.waitFor(() => { expect(storage.control.getCommand(nasHealthRecord.commandId)?.status).toBe('ok') })

    const homeOffline = await server.agents.invoke(
      home.nodeId, home.runtimeId, 'dsh.runtime', '1.0.0', 'health', {},
      'human:operator@example.com',
    )
    expect(homeOffline.status).toBe('sent')
    expect(storage.reliableJournal(`node:${nas.nodeId}`).pendingOutbound(100).some(record =>
      record.body.type === 'capability.invoke' && record.body.commandId === homeOffline.commandId)).toBe(false)

    const reconnectedHome = await openSignedNode({
      storage,
      hubIdentity,
      port: address.port,
      nodeName: 'home-node',
      existing: home,
    })
    const recovered = await reconnectedHome.nextCommand()
    expect(recovered).toMatchObject({
      commandId: homeOffline.commandId,
      runtimeId: home.runtimeId,
      capability: 'dsh.runtime',
      operation: 'health',
    })
    await reconnectedHome.respond(recovered.commandId, {
      status: 'healthy', startedAt: 2, dshVersion: '0.1.0', connectorVersion: '0.1.0',
      details: { node: 'home-node', recovered: true },
    })
    await vi.waitFor(() => { expect(storage.control.getCommand(homeOffline.commandId)?.status).toBe('ok') })
    expect(server.agents.isOnline(nas.nodeId)).toBe(true)
    expect(storage.control.getCommand(nasHealthRecord.commandId)?.status).toBe('ok')
    expect(storage.control.listAudit(200).filter(record =>
      record.action === 'command.completed'
      && [homeRecord.commandId, nasRecord.commandId, nasHealthRecord.commandId, homeOffline.commandId]
        .includes(record.resourceId ?? ''))).toHaveLength(4)
  })
})
