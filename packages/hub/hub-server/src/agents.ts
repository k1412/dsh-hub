/** Authenticated Node Agent WebSocket handshake, registry, and command delivery. */

import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { WebSocket } from 'ws'
import {
  hubCapabilityContracts, resolveHubOperation, resolveHubStream,
} from '@k1412/dsh-hub-capabilities'
import {
  HubCommandId, HubMessageId, HubNodeId, HubRuntimeId, hubSignedEnvelopeSchema,
  signHubEnvelope, verifyHubCapability, verifyHubEnvelope,
  type HubCapabilityDescriptor, type HubIdentityKeyPair, type HubJson,
  type HubNodeId as HubNodeIdType, type HubRuntimeId as HubRuntimeIdType,
  type HubTransportStatusBody,
} from '@k1412/dsh-hub-protocol'
import { type HubCommandRecord, type HubStorage } from '@k1412/dsh-hub-storage'
import { ReliablePeer, type ReliableInboundRecord } from '@k1412/dsh-hub-transport'
import type { HubServicePrincipal } from './auth.ts'
import type { HubEventBroker } from './events.ts'

/** Agent connection query validated before application authentication. */
export interface HubAgentUpgrade {
  nodeId: HubNodeIdType
  nodeBootId: string
}

interface ActiveNodeConnection {
  nodeId: HubNodeIdType
  nodeBootId: string
  agentVersion: string
  generation: number
  socket: WebSocket
  peer: ReliablePeer
  sentSequence: number
  runtimes: Map<string, Map<string, HubCapabilityDescriptor>>
  recoveryResyncRuntimes: Set<string>
  flushPromise: Promise<void> | undefined
  flushRequested: boolean
  messageChain: Promise<void>
  lastPongAt: number
  transportStatus?: HubTransportStatusBody
  heartbeat?: NodeJS.Timeout
  authenticationExpiry?: NodeJS.Timeout
}

/** Operator-visible live transport health derived from both reliable peers. */
export interface HubNodeTransportHealth {
  agentVersion?: string
  reportedAt?: number
  lastPongAt?: number
  pressure: 'normal' | 'warning' | 'critical' | 'unknown'
  nodeOutbox?: {
    records: number
    bytes: number
    maxRecords: number
    maxBytes: number
    oldestPendingAt?: number
  }
  hubOutbox: {
    records: number
    bytes: number
    maxRecords: number
    maxBytes: number
    oldestPendingAt?: number
  }
  droppedStreamFramesTotal: number
  droppedStreams: HubTransportStatusBody['droppedStreams']
  controlRequests: {
    pending: number
    oldestPendingAt?: number
    timeoutsLast24Hours: number
    lastTimeoutAt?: number
    lastTimeoutOperation?: string
  }
}

function flushWasRequested(connection: ActiveNodeConnection): boolean {
  return connection.flushRequested
}

/**
 * Parse and validate the public identifiers on an Agent WebSocket URL.
 * @param request - pending HTTP upgrade request.
 * @returns validated node and process-boot identifiers.
 */
export function parseAgentUpgrade(request: IncomingMessage): HubAgentUpgrade {
  const url = new URL(request.url ?? '/', 'http://hub.invalid')
  const nodeId = HubNodeId(url.searchParams.get('nodeId') ?? '')
  const nodeBootId = HubMessageId(url.searchParams.get('bootId') ?? '')
  return { nodeId, nodeBootId }
}

function sendSocket(socket: WebSocket, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(JSON.stringify(value), (error) => {
      if (error == null) resolve()
      else reject(error)
    })
  })
}

function webSocketText(data: WebSocket.RawData): string {
  const bytes = Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer ? Buffer.from(data) : data
  return bytes.toString('utf8')
}

function receiveOne(socket: WebSocket, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Agent authentication timed out'))
    }, timeoutMs)
    const onMessage = (data: WebSocket.RawData, binary: boolean) => {
      cleanup()
      if (binary) {
        reject(new Error('Agent authentication requires JSON'))
        return
      }
      try {
        resolve(JSON.parse(webSocketText(data)) as unknown)
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Agent authentication contains invalid JSON'))
      }
    }
    const onClose = () => {
      cleanup()
      reject(new Error('Agent disconnected during authentication'))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('message', onMessage)
      socket.off('close', onClose)
    }
    socket.once('message', onMessage)
    socket.once('close', onClose)
  })
}

function hubSessionId(nodeId: string, runtimeId: string, sourceId: string): string {
  return createHash('sha256').update(`${nodeId}\0${runtimeId}\0${sourceId}`, 'utf8').digest('base64url')
}

/** Registry of currently authenticated outbound Node Agent connections. */
export class HubAgentRegistry {
  private readonly connections = new Map<string, ActiveNodeConnection>()
  private readonly hubBootId = HubMessageId(randomBytes(18).toString('base64url'))

  public constructor(
    private readonly storage: HubStorage,
    private readonly events: HubEventBroker,
    private readonly hubIdentity: HubIdentityKeyPair,
  ) {}

  /**
   * Complete mutual application authentication and assume ownership of the node socket.
   * @param socket - accepted WebSocket awaiting application authentication.
   * @param upgrade - validated public connection identifiers.
   * @param service - authenticated Cloudflare Service Token principal.
   */
  public async accept(
    socket: WebSocket,
    upgrade: HubAgentUpgrade,
    service: HubServicePrincipal,
  ): Promise<void> {
    const challenge = HubMessageId(randomBytes(18).toString('base64url'))
    const now = Date.now()
    const proofPromise = receiveOne(socket, 10_000)
    await sendSocket(socket, signHubEnvelope({
      protocolVersion: 1,
      nodeId: upgrade.nodeId,
      bootId: this.hubBootId,
      connectionGeneration: 0,
      messageId: HubMessageId(randomBytes(18).toString('base64url')),
      directionSequence: 1,
      cumulativeAck: 0,
      issuedAt: now,
      expiresAt: now + 10_000,
      body: { type: 'auth.challenge', challenge, audience: 'node' },
    }, this.hubIdentity.privateKey))

    const proofInput = await proofPromise
    const parsed = hubSignedEnvelopeSchema.safeParse(proofInput)
    if (!parsed.success) throw new Error('invalid Node Agent proof')
    const proof = parsed.data
    const body = proof.body
    if (body.type !== 'auth.node-proof') throw new Error('invalid Node Agent proof')
    const verified = verifyHubEnvelope(proof, body.publicKey, Date.now())
    if (!verified.ok
      || proof.nodeId !== upgrade.nodeId
      || proof.bootId !== upgrade.nodeBootId
      || proof.connectionGeneration !== 0
      || body.challenge !== challenge
      || body.protocolMin > 1
      || body.protocolMax < 1) {
      throw new Error('Node Agent proof verification failed')
    }

    let node = this.storage.control.getNode(upgrade.nodeId)
    if (node === undefined) {
      if (body.enrollmentCode === undefined) throw new Error('enrollment code is required')
      node = this.storage.control.consumeEnrollment(body.enrollmentCode, body.publicKey, service.commonName)
      if (node.nodeId !== upgrade.nodeId) throw new Error('enrollment grant targets another node')
      this.storage.control.appendAudit({
        occurredAt: Date.now(),
        actor: `service:${service.commonName}`,
        action: 'node.enrolled',
        nodeId: node.nodeId,
        outcome: 'ok',
        details: { publicKeyHash: createHash('sha256').update(body.publicKey).digest('base64url') },
      })
    } else if (node.status !== 'active'
      || node.publicKey !== body.publicKey
      || node.serviceIdentity !== service.commonName
      || body.enrollmentCode !== undefined) {
      throw new Error('Node Agent identity does not match enrollment')
    }

    const generation = this.storage.control.beginConnection(node.nodeId)
    const journal = this.storage.reliableJournal(`node:${node.nodeId}`)
    journal.acknowledgeOutbound(proof.cumulativeAck)
    const peer = new ReliablePeer({
      nodeId: node.nodeId,
      localBootId: this.hubBootId,
      expectedRemoteBootId: upgrade.nodeBootId,
      connectionGeneration: generation,
      localPrivateKey: this.hubIdentity.privateKey,
      remotePublicKey: node.publicKey,
      journal,
    })
    const acceptedAt = Date.now()
    await sendSocket(socket, signHubEnvelope({
      protocolVersion: 1,
      nodeId: node.nodeId,
      bootId: this.hubBootId,
      connectionGeneration: generation,
      messageId: HubMessageId(randomBytes(18).toString('base64url')),
      directionSequence: 1,
      cumulativeAck: journal.inboundAcknowledgement(),
      issuedAt: acceptedAt,
      expiresAt: acceptedAt + 10_000,
      body: {
        type: 'auth.accepted',
        challenge,
        acceptedProtocol: 1,
        connectionGeneration: generation,
        hubPublicKey: this.hubIdentity.publicKey,
        hubAck: journal.inboundAcknowledgement(),
      },
    }, this.hubIdentity.privateKey))

    const connection: ActiveNodeConnection = {
      nodeId: node.nodeId,
      nodeBootId: upgrade.nodeBootId,
      agentVersion: body.agentVersion,
      generation,
      socket,
      peer,
      sentSequence: 0,
      runtimes: new Map(this.storage.control.listRuntimes(node.nodeId).map((runtime) => {
        const descriptors = (runtime.capabilities as unknown[]).map(verifyHubCapability)
        return [runtime.runtimeId, new Map(descriptors.map(descriptor => [descriptor.name, descriptor]))]
      })),
      recoveryResyncRuntimes: new Set(journal.pendingOutbound(10_000).flatMap(record =>
        record.body.type === 'runtime.resync-required' && record.body.runtimeId !== undefined
          ? [record.body.runtimeId]
          : [])),
      flushPromise: undefined,
      flushRequested: false,
      messageChain: Promise.resolve(),
      lastPongAt: Date.now(),
    }
    const prior = this.connections.get(node.nodeId)
    this.connections.set(node.nodeId, connection)
    prior?.socket.close(4001, 'superseded connection generation')
    this.installConnection(connection)
    connection.authenticationExpiry = setTimeout(() => {
      connection.socket.close(4003, 'service authentication expired')
    }, Math.min(2_147_483_647, Math.max(1_000, service.expiresAt * 1_000 - Date.now())))
    connection.authenticationExpiry.unref()
    this.recoverInbound(connection)
    this.recoverCommands(connection)
    await this.flush(connection)
    this.events.publish('node.connected', { nodeId: node.nodeId, generation })
    this.storage.control.appendAudit({
      occurredAt: Date.now(),
      actor: `node:${node.nodeId}`,
      action: 'node.connected',
      nodeId: node.nodeId,
      outcome: 'ok',
      details: { generation, agentVersion: body.agentVersion },
    })
  }

  /**
   * Return whether the current generation of a node is online.
   * @param nodeId - enrolled node identifier.
   * @returns whether the current socket generation is open.
   */
  public isOnline(nodeId: HubNodeIdType): boolean {
    return this.connections.get(nodeId)?.socket.readyState === WebSocket.OPEN
  }

  /**
   * Return the latest node report together with Hub-side queue pressure.
   * @param nodeId - enrolled node identifier.
   * @returns transport health safe for the authenticated operator API.
   */
  public transportHealth(nodeId: HubNodeIdType): HubNodeTransportHealth {
    const connection = this.connections.get(nodeId)
    const status = connection?.transportStatus
    const hub = this.storage.reliableJournal(`node:${nodeId}`).outboundUsage()
    const hubRatio = Math.max(hub.records / hub.maxRecords, hub.bytes / hub.maxBytes)
    const hubPressure = hubRatio >= 0.95 ? 'critical' : hubRatio >= 0.75 ? 'warning' : 'normal'
    const pending = this.storage.control.listRecoverableCommands(nodeId)
    const since = Date.now() - 24 * 60 * 60_000
    const timeouts = this.storage.control.listAudit(1_000, nodeId)
      .filter(record => record.action === 'command.wait-timeout' && record.occurredAt >= since)
    const lastTimeout = timeouts[0]
    const lastTimeoutDetails = lastTimeout?.details !== null && typeof lastTimeout?.details === 'object'
      && !Array.isArray(lastTimeout.details)
      ? lastTimeout.details as Record<string, unknown>
      : undefined
    const pressure = status === undefined
      ? connection === undefined ? 'unknown' : hubPressure
      : status.pressure === 'critical' || hubPressure === 'critical'
        ? 'critical'
        : status.pressure === 'warning' || hubPressure === 'warning'
          ? 'warning'
          : 'normal'
    return {
      ...(connection === undefined ? {} : { agentVersion: connection.agentVersion }),
      ...(status === undefined ? {} : {
        reportedAt: status.observedAt,
        nodeOutbox: {
          records: status.outboxRecords,
          bytes: status.outboxBytes,
          maxRecords: status.maxOutboxRecords,
          maxBytes: status.maxOutboxBytes,
          ...(status.oldestPendingAt === undefined ? {} : { oldestPendingAt: status.oldestPendingAt }),
        },
      }),
      ...(connection === undefined ? {} : { lastPongAt: connection.lastPongAt }),
      pressure,
      hubOutbox: {
        records: hub.records,
        bytes: hub.bytes,
        maxRecords: hub.maxRecords,
        maxBytes: hub.maxBytes,
        ...(hub.oldestCreatedAt === 0 ? {} : { oldestPendingAt: hub.oldestCreatedAt }),
      },
      droppedStreamFramesTotal: status?.droppedStreamFramesTotal ?? 0,
      droppedStreams: status?.droppedStreams ?? [],
      controlRequests: {
        pending: pending.length,
        ...(pending[0] === undefined
          ? {}
          : { oldestPendingAt: pending.reduce(
            (oldest, command) => Math.min(oldest, command.createdAt),
            pending[0].createdAt,
          ) }),
        timeoutsLast24Hours: timeouts.length,
        ...(lastTimeout === undefined ? {} : { lastTimeoutAt: lastTimeout.occurredAt }),
        ...(typeof lastTimeoutDetails?.rpcMethod === 'string'
          ? { lastTimeoutOperation: lastTimeoutDetails.rpcMethod }
          : typeof lastTimeoutDetails?.operation === 'string'
            ? { lastTimeoutOperation: lastTimeoutDetails.operation }
            : {}),
      },
    }
  }

  /**
   * Fence an authenticated node immediately after administrative revocation.
   * @param nodeId - revoked node identifier.
   */
  public fence(nodeId: HubNodeIdType): void {
    const connection = this.connections.get(nodeId)
    if (connection === undefined) return
    this.connections.delete(nodeId)
    if (connection.heartbeat !== undefined) clearInterval(connection.heartbeat)
    if (connection.authenticationExpiry !== undefined) clearTimeout(connection.authenticationExpiry)
    this.storage.control.markNodeDisconnected(nodeId)
    this.events.publish('node.disconnected', { nodeId, generation: connection.generation })
    connection.socket.close(4003, 'node revoked')
  }

  /**
   * Validate, persist, enqueue, and asynchronously flush one capability command.
   * @param nodeId - destination node identifier.
   * @param runtimeId - destination DSH runtime identifier.
   * @param capabilityName - exact capability namespace.
   * @param capabilityVersion - exact advertised capability version.
   * @param operationName - operation within the capability contract.
   * @param payloadInput - untrusted browser command payload.
   * @param actor - authenticated audit actor.
   * @returns persisted command record after initial delivery handling.
   */
  public async invoke(
    nodeId: HubNodeIdType,
    runtimeId: HubRuntimeIdType,
    capabilityName: string,
    capabilityVersion: string,
    operationName: string,
    payloadInput: unknown,
    actor: string,
  ): Promise<HubCommandRecord> {
    const connection = this.connections.get(nodeId)
    const node = this.storage.control.getNode(nodeId)
    if (node === undefined || node.status !== 'active') throw new Error('active node not found')
    const storedRuntime = this.storage.control.listRuntimes(nodeId).find(runtime => runtime.runtimeId === runtimeId)
    const storedCapabilities = storedRuntime === undefined
      ? new Map<string, HubCapabilityDescriptor>()
      : new Map((storedRuntime.capabilities as unknown[]).map(verifyHubCapability)
        .map(descriptor => [descriptor.name, descriptor]))
    const advertised = connection?.runtimes.get(runtimeId)?.get(capabilityName)
      ?? storedCapabilities.get(capabilityName)
    if (advertised === undefined || advertised.version !== capabilityVersion
      || !advertised.operations.some(operation => operation.name === operationName)) {
      throw new Error('runtime did not advertise the requested operation')
    }
    const contract = resolveHubOperation(capabilityName, capabilityVersion, operationName)
    if (contract === undefined) throw new Error('Hub does not implement the requested operation contract')
    const payload = contract.request.parse(payloadInput) as HubJson
    const commandId = HubCommandId(randomBytes(18).toString('base64url'))
    const idempotencyKey = contract.idempotency === 'read' || contract.idempotency === 'never-retry'
      ? undefined
      : HubMessageId(randomBytes(18).toString('base64url'))
    let command = this.storage.control.createCommand({
      commandId,
      nodeId,
      runtimeId,
      capability: capabilityName,
      capabilityVersion,
      operation: operationName,
      idempotency: contract.idempotency,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      payload,
      createdAt: Date.now(),
    })
    try {
      this.storage.reliableJournal(`node:${nodeId}`).enqueue({
        type: 'capability.invoke',
        commandId,
        runtimeId,
        capability: capabilityName,
        capabilityVersion,
        operation: operationName,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        payload,
      })
      command = this.storage.control.transitionCommand(commandId, 'sent', undefined)
    } catch (error) {
      command = this.storage.control.transitionCommand(commandId, 'error', {
        code: 'delivery-failed',
        message: error instanceof Error ? error.message : 'delivery failed',
      })
    }
    if (command.status === 'sent' && connection !== undefined && connection.socket.readyState === WebSocket.OPEN) {
      await this.flush(connection).catch(() => undefined)
    }
    this.storage.control.appendAudit({
      occurredAt: Date.now(),
      actor,
      action: 'command.created',
      nodeId,
      runtimeId,
      resourceId: commandId,
      outcome: command.status === 'error' ? 'error' : 'ok',
      details: { capability: capabilityName, operation: operationName },
    })
    return command
  }

  /** Close every active connection during Hub shutdown. */
  public close(): void {
    for (const connection of this.connections.values()) {
      if (connection.heartbeat !== undefined) clearInterval(connection.heartbeat)
      if (connection.authenticationExpiry !== undefined) clearTimeout(connection.authenticationExpiry)
      connection.socket.close(1001, 'Hub shutdown')
    }
    this.connections.clear()
  }

  private installConnection(connection: ActiveNodeConnection): void {
    connection.socket.on('pong', () => { connection.lastPongAt = Date.now() })
    connection.socket.on('message', (data, binary) => {
      connection.messageChain = connection.messageChain
        .then(() => this.handleMessage(connection, data, binary))
        .catch(() => { connection.socket.close(1011, 'Agent protocol failure') })
    })
    connection.socket.on('close', () => { this.disconnected(connection) })
    connection.socket.on('error', () => { this.disconnected(connection) })
    connection.heartbeat = setInterval(() => {
      if (Date.now() - connection.lastPongAt > 90_000) connection.socket.terminate()
      else if (connection.socket.readyState === WebSocket.OPEN) connection.socket.ping()
    }, 30_000)
    connection.heartbeat.unref()
  }

  private async handleMessage(connection: ActiveNodeConnection, data: WebSocket.RawData, binary: boolean): Promise<void> {
    if (this.connections.get(connection.nodeId) !== connection) throw new Error('fenced Agent connection')
    if (binary) throw new Error('Agent protocol accepts JSON frames only')
    const input = JSON.parse(webSocketText(data)) as unknown
    const received = connection.peer.receive(input)
    if (received.kind === 'rejected') {
      if (received.reason === 'sequence-gap') {
        connection.peer.enqueue({ type: 'runtime.resync-required', reason: 'sequence-gap' })
        await this.flush(connection)
      }
      throw new Error(`rejected Agent frame: ${received.reason}`)
    }
    if (received.kind === 'duplicate') return
    const claimed = this.storage.reliableJournal(`node:${connection.nodeId}`).claimInbound(received.record.sequence)
    if (claimed === undefined) throw new Error('accepted Agent frame was not claimable')
    this.processInbound(connection, claimed)
    const journal = this.storage.reliableJournal(`node:${connection.nodeId}`)
    journal.completeInbound(claimed.sequence)
    journal.pruneProcessed()
    if (claimed.body.type !== 'transport.ack') {
      connection.peer.enqueueAcknowledgement()
      await this.flush(connection)
    }
  }

  private processInbound(connection: ActiveNodeConnection, record: ReliableInboundRecord): void {
    const body = record.body
    if (body.type === 'transport.ack') return
    if (body.type === 'transport.status') {
      const priorPressure = connection.transportStatus?.pressure ?? 'normal'
      if (connection.transportStatus === undefined || body.observedAt >= connection.transportStatus.observedAt) {
        connection.transportStatus = body
      }
      if (priorPressure !== body.pressure) {
        this.storage.control.appendAudit({
          occurredAt: Date.now(),
          actor: `node:${connection.nodeId}`,
          action: 'transport.pressure',
          nodeId: connection.nodeId,
          outcome: body.pressure === 'normal' ? 'ok' : body.pressure,
          details: {
            pressure: body.pressure,
            outboxRecords: body.outboxRecords,
            outboxBytes: body.outboxBytes,
          },
        })
      }
      this.events.publish('transport.status', {
        nodeId: connection.nodeId,
        ...body,
      } as unknown as HubJson)
      for (const dropped of body.droppedStreams) {
        this.events.publish('stream.interrupted', {
          nodeId: connection.nodeId,
          runtimeId: dropped.runtimeId,
          capability: dropped.capability,
          stream: dropped.stream,
          frames: dropped.frames,
        })
      }
      return
    }
    if (body.type === 'runtime.hello') {
      const descriptors = body.capabilities.map(verifyHubCapability)
      connection.runtimes.set(body.runtimeId, new Map(descriptors.map(descriptor => [descriptor.name, descriptor])))
      this.storage.control.upsertRuntime({
        nodeId: connection.nodeId,
        runtimeId: HubRuntimeId(body.runtimeId),
        bootId: body.bootId,
        dshVersion: body.dshVersion,
        connectorVersion: body.connectorVersion,
        capabilities: descriptors as unknown as HubJson,
        online: true,
        lastSeenAt: Date.now(),
      })
      this.events.publish('runtime.hello', {
        nodeId: connection.nodeId,
        runtimeId: body.runtimeId,
        dshVersion: body.dshVersion,
        connectorVersion: body.connectorVersion,
        capabilities: descriptors as unknown as HubJson,
      })
      return
    }
    if (body.type === 'runtime.goodbye') {
      connection.runtimes.delete(body.runtimeId)
      this.storage.control.markRuntimeDisconnected(connection.nodeId, HubRuntimeId(body.runtimeId))
      this.events.publish('runtime.goodbye', {
        nodeId: connection.nodeId,
        runtimeId: body.runtimeId,
        reason: body.reason,
      })
      return
    }
    if (body.type === 'capability.result') {
      const command = this.storage.control.getCommand(body.commandId)
      if (command === undefined) throw new Error('result references an unknown command')
      if (command.nodeId !== connection.nodeId) throw new Error('result node does not own command')
      if (command.status === 'ok' || command.status === 'error' || command.status === 'outcome-unknown') return
      let result: HubJson
      if (body.status === 'ok') {
        const operation = resolveHubOperation(command.capability, command.capabilityVersion, command.operation)
        if (operation === undefined) throw new Error('result operation contract is unavailable')
        result = operation.response.parse(body.value) as HubJson
      } else {
        result = body.error as unknown as HubJson
      }
      const completed = this.storage.control.transitionCommand(body.commandId, body.status, result)
      this.storage.control.appendAudit({
        occurredAt: Date.now(),
        actor: `node:${connection.nodeId}`,
        action: 'command.completed',
        nodeId: connection.nodeId,
        ...(command.runtimeId === undefined ? {} : { runtimeId: command.runtimeId }),
        resourceId: body.commandId,
        outcome: body.status,
        details: { resultHash: completed.resultHash ?? null },
      })
      this.events.publish('command.result', {
        commandId: body.commandId,
        nodeId: connection.nodeId,
        status: body.status,
        result,
      })
      return
    }
    if (body.type === 'stream.frame') {
      const descriptor = connection.runtimes.get(body.runtimeId)?.get(body.capability)
      if (descriptor === undefined) throw new Error('stream capability was not advertised')
      const stream = resolveHubStream(body.capability, descriptor.version, body.stream)
      if (stream === undefined) throw new Error('stream contract is unavailable')
      if (record.recovery) {
        if (stream.reconstructible) {
          if (!connection.recoveryResyncRuntimes.has(body.runtimeId)) {
            connection.recoveryResyncRuntimes.add(body.runtimeId)
            connection.peer.enqueue({
              type: 'runtime.resync-required',
              runtimeId: body.runtimeId,
              reason: 'baseline-changed',
            })
          }
        } else {
          this.events.publish('stream.interrupted', {
            nodeId: connection.nodeId,
            runtimeId: body.runtimeId,
            capability: body.capability,
            stream: body.stream,
          })
        }
        return
      }
      const payload = stream.frame.parse(body.payload) as HubJson
      if (body.capability === 'dsh.sessions' && body.stream === 'index') {
        const baseline = payload as { sessions: Array<{
          sessionId: string
          title?: string
          workspacePath?: string
          updatedAt: number
          running: boolean
        }> }
        this.storage.control.replaceSessionIndex(
          connection.nodeId,
          HubRuntimeId(body.runtimeId),
          baseline.sessions.map(session => ({
            hubSessionId: hubSessionId(connection.nodeId, body.runtimeId, session.sessionId),
            nodeId: connection.nodeId,
            runtimeId: HubRuntimeId(body.runtimeId),
            sourceId: session.sessionId,
            ...(session.title === undefined ? {} : { title: session.title }),
            ...(session.workspacePath === undefined ? {} : { workspacePath: session.workspacePath }),
            updatedAt: session.updatedAt,
            running: session.running,
            stale: false,
          })),
        )
      }
      this.events.publish('stream.frame', {
        nodeId: connection.nodeId,
        runtimeId: body.runtimeId,
        capability: body.capability,
        stream: body.stream,
        frameSequence: body.frameSequence,
        payload,
      })
      return
    }
    if (body.type === 'runtime.resync-required') {
      this.events.publish('runtime.resync-required', {
        nodeId: connection.nodeId,
        runtimeId: body.runtimeId ?? null,
        reason: body.reason,
      })
      return
    }
    throw new Error(`unexpected authenticated Agent body ${body.type}`)
  }

  private recoverInbound(connection: ActiveNodeConnection): void {
    const journal = this.storage.reliableJournal(`node:${connection.nodeId}`)
    let cursor = 0
    for (;;) {
      const page = journal.recoverableInboundAfter(cursor)
      if (page.length === 0) break
      for (const pending of page) {
        cursor = pending.sequence
        const claimed = journal.claimInbound(pending.sequence)
        if (claimed === undefined) continue
        this.processInbound(connection, claimed)
        journal.completeInbound(claimed.sequence)
      }
    }
    journal.pruneProcessed()
  }

  private recoverCommands(connection: ActiveNodeConnection): void {
    const journal = this.storage.reliableJournal(`node:${connection.nodeId}`)
    const queued = new Set(journal.pendingOutbound(10_000).flatMap(record =>
      record.body.type === 'capability.invoke' ? [record.body.commandId] : []))
    for (const command of this.storage.control.listRecoverableCommands(connection.nodeId)) {
      if (command.status !== 'pending') continue
      if (!queued.has(command.commandId)) {
        if (command.runtimeId === undefined) throw new Error('recoverable command has no runtime')
        journal.enqueue({
          type: 'capability.invoke',
          commandId: command.commandId,
          runtimeId: command.runtimeId,
          capability: command.capability,
          capabilityVersion: command.capabilityVersion,
          operation: command.operation,
          ...(command.idempotencyKey === undefined ? {} : { idempotencyKey: command.idempotencyKey }),
          payload: command.payload,
        })
      }
      this.storage.control.transitionCommand(command.commandId, 'sent', undefined)
    }
  }

  private flush(connection: ActiveNodeConnection): Promise<void> {
    if (connection.flushPromise !== undefined) {
      connection.flushRequested = true
      return connection.flushPromise
    }
    connection.flushRequested = false
    connection.flushPromise = (async () => {
      for (;;) {
        connection.flushRequested = false
        let refreshAcknowledgement = true
        for (;;) {
          const frames = connection.peer.renderPendingAfter(connection.sentSequence)
          if (frames.length === 0) {
            const acknowledgement = refreshAcknowledgement
              ? connection.peer.renderPendingAcknowledgement()
              : undefined
            refreshAcknowledgement = false
            if (acknowledgement === undefined || acknowledgement.directionSequence > connection.sentSequence) break
            if (this.connections.get(connection.nodeId) !== connection
              || connection.socket.readyState !== WebSocket.OPEN) return
            await sendSocket(connection.socket, acknowledgement)
            break
          }
          refreshAcknowledgement = false
          for (const frame of frames) {
            if (this.connections.get(connection.nodeId) !== connection
              || connection.socket.readyState !== WebSocket.OPEN) return
            await sendSocket(connection.socket, frame)
            connection.sentSequence = frame.directionSequence
          }
        }
        if (!flushWasRequested(connection)) break
      }
    })().finally(() => {
      connection.flushPromise = undefined
      if (connection.flushRequested && this.connections.get(connection.nodeId) === connection
        && connection.socket.readyState === WebSocket.OPEN) void this.flush(connection)
    })
    return connection.flushPromise
  }

  private disconnected(connection: ActiveNodeConnection): void {
    if (connection.heartbeat !== undefined) clearInterval(connection.heartbeat)
    if (connection.authenticationExpiry !== undefined) clearTimeout(connection.authenticationExpiry)
    if (this.connections.get(connection.nodeId) !== connection) return
    this.connections.delete(connection.nodeId)
    this.storage.control.markNodeDisconnected(connection.nodeId)
    this.storage.control.appendAudit({
      occurredAt: Date.now(),
      actor: `node:${connection.nodeId}`,
      action: 'node.disconnected',
      nodeId: connection.nodeId,
      outcome: 'ok',
      details: { generation: connection.generation },
    })
    this.events.publish('node.disconnected', {
      nodeId: connection.nodeId,
      generation: connection.generation,
    })
  }
}

/** Required standard descriptors used by complete-profile tests and operator displays. */
export const standardHubCapabilityDescriptors = hubCapabilityContracts.map(contract => contract.descriptor)
