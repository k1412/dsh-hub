/** Outbound-only Node Agent WSS lifecycle and local Connector routing. */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import {
  filesCapability, pluginsCapability, resolveHubOperation, snapshotsCapability, terminalsCapability,
} from '@k1412/dsh-hub-capabilities'
import { HubMessageId, signHubEnvelope, verifyHubEnvelope, type HubEnvelopeBody } from '@k1412/dsh-hub-protocol'
import type { HubDroppedStream, HubJson, HubTransportStatusBody } from '@k1412/dsh-hub-protocol'
import { ReliablePeer, type ReliableInboundRecord } from '@k1412/dsh-hub-transport'
import { HubConnectorServer, type LocalRuntimeBaseline } from './ipc-server.ts'
import type { HubNodeAgentState } from './state.ts'
import { HubNodeSupervisor } from './supervisor.ts'

/** Public Node Agent package version sent during enrollment. */
export const HUB_NODE_AGENT_VERSION = '0.1.0-rc.10'

/** Sanitized lifecycle notice for service logs. */
export interface HubNodeAgentNotice {
  state: 'starting' | 'connecting' | 'connected' | 'disconnected' | 'stopped' | 'error'
  message: string
}

/** Node Agent runtime options. */
export interface HubNodeAgentOptions {
  state: HubNodeAgentState
  notice?: (notice: HubNodeAgentNotice) => void
}

interface ActiveHubConnection {
  socket: WebSocket
  peer: ReliablePeer
  sentSequence: number
  flushPromise: Promise<void> | undefined
  flushRequested: boolean
  messageChain: Promise<void>
  lastPongAt: number
  heartbeat: NodeJS.Timeout | undefined
  statusTimer: NodeJS.Timeout | undefined
}

const STREAM_RECORD_RESERVE = 2_000
const STREAM_BYTE_RESERVE = 16 * 1024 * 1024
const TRANSPORT_STATUS_INTERVAL_MS = 15_000
const DEFERRED_CONNECTOR_BODY_LIMIT = 2_048
const INTERACTION_STREAM_METHODS = new Set([
  'approval/requested',
  'approval/resolved',
  'question/requested',
  'question/resolved',
])

/** Human interaction frames are control messages: dropping one can strand or hide a live wait. */
function isInteractionStream(body: Extract<HubEnvelopeBody, { type: 'stream.frame' }>): boolean {
  if (body.capability !== 'dsh.web' || body.stream !== 'mux'
    || typeof body.payload !== 'object' || body.payload === null || Array.isArray(body.payload)) return false
  const envelope = body.payload as Record<string, unknown>
  return envelope.type === 'server-request'
    && typeof envelope.method === 'string'
    && INTERACTION_STREAM_METHODS.has(envelope.method)
}

function flushWasRequested(connection: ActiveHubConnection): boolean {
  return connection.flushRequested
}

function webSocketUrl(hubUrl: string, nodeId: string, bootId: string): string {
  const url = new URL(hubUrl)
  url.protocol = 'wss:'
  url.pathname = '/hub/v1/agent'
  url.search = new URLSearchParams({ nodeId, bootId }).toString()
  return url.toString()
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
      reject(new Error('Hub handshake timed out'))
    }, timeoutMs)
    const onMessage = (data: WebSocket.RawData, binary: boolean) => {
      cleanup()
      if (binary) {
        reject(new Error('Hub handshake requires JSON'))
        return
      }
      try {
        resolve(JSON.parse(webSocketText(data)) as unknown)
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Hub handshake contains invalid JSON'))
      }
    }
    const onClose = () => {
      cleanup()
      reject(new Error('Hub closed during handshake'))
    }
    const onError = () => {
      cleanup()
      reject(new Error('Hub connection failed during handshake'))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('message', onMessage)
      socket.off('close', onClose)
      socket.off('error', onError)
    }
    socket.once('message', onMessage)
    socket.once('close', onClose)
    socket.once('error', onError)
  })
}

function send(socket: WebSocket, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(JSON.stringify(value), (error) => {
      if (error == null) resolve()
      else reject(error)
    })
  })
}

function waitForOpen(socket: WebSocket, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOpen = () => { cleanup(); resolve() }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onAbort = () => {
      cleanup()
      socket.close()
      reject(signal.reason instanceof Error ? signal.reason : new Error('Hub connection wait aborted'))
    }
    const cleanup = () => {
      socket.off('open', onOpen)
      socket.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    socket.once('open', onOpen)
    socket.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Hub reconnect delay aborted'))
      return
    }
    const timeout = setTimeout(() => { cleanup(); resolve() }, ms)
    const onAbort = () => {
      cleanup()
      reject(signal.reason instanceof Error ? signal.reason : new Error('Hub reconnect delay aborted'))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Long-running outbound Agent; the service manager owns restart and OS-account scope. */
export class HubNodeAgent {
  private readonly bootId = HubMessageId(randomBytes(18).toString('base64url'))
  private readonly connector: HubConnectorServer
  private readonly supervisors = new Map<string, HubNodeSupervisor>()
  private connection: ActiveHubConnection | undefined
  private readonly pendingCommands = new Map<string, number>()
  private readonly pendingRuntimeStates = new Map<string, LocalRuntimeBaseline | 'offline'>()
  private readonly deferredConnectorBodies: HubEnvelopeBody[] = []
  private readonly droppedStreams = new Map<string, HubDroppedStream>()
  private droppedStreamFramesTotal = 0
  private reportedPressure: HubTransportStatusBody['pressure'] = 'normal'

  public constructor(private readonly options: HubNodeAgentOptions) {
    for (const profile of options.state.config.management?.profiles ?? []) {
      this.supervisors.set(profile.runtimeId, new HubNodeSupervisor(
        join(options.state.config.stateDirectory, 'runtimes', profile.runtimeId),
        profile,
        (body) => { this.connectorBody(body) },
      ))
    }
    this.connector = new HubConnectorServer(
      options.state.config.ipcEndpoint,
      options.state.ipcSecret,
      this.bootId,
      {
        connected: (baseline) => { this.connectorConnected(baseline) },
        body: (_runtimeId, body) => { this.connectorBody(body) },
        disconnected: (runtimeId) => { this.connectorDisconnected(runtimeId) },
      },
    )
  }

  /**
   * Start local IPC, validate the pinned Hub key, and reconnect until aborted.
   * @param signal - service-lifetime cancellation signal.
   */
  public async run(signal: AbortSignal): Promise<void> {
    this.notice('starting', 'starting local Connector endpoint')
    await this.connector.listen()
    try {
      await this.verifyBootstrap(signal)
      let attempt = 0
      for (;;) {
        if (signal.aborted) break
        try {
          this.notice('connecting', 'opening outbound Hub connection')
          await this.connectOnce(signal)
          attempt = 0
          this.notice('disconnected', 'Hub connection closed; reconnecting')
        } catch (error) {
          this.notice('error', error instanceof Error ? error.message : 'Hub connection failed')
          attempt += 1
        }
        const ceiling = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6))
        await delay(Math.floor(ceiling / 2 + Math.random() * ceiling / 2), signal).catch(() => undefined)
      }
    } finally {
      this.connection?.socket.close(1001, 'Node Agent stopping')
      this.connection = undefined
      for (const supervisor of this.supervisors.values()) supervisor.close()
      await this.connector.close()
      this.notice('stopped', 'Node Agent stopped')
    }
  }

  private async verifyBootstrap(signal: AbortSignal): Promise<void> {
    const url = new URL('/hub/v1/bootstrap', this.options.state.config.hubUrl)
    const response = await fetch(url, {
      headers: this.accessHeaders(),
      signal,
    })
    if (!response.ok) throw new Error(`Hub bootstrap rejected with HTTP ${String(response.status)}`)
    const body = await response.json() as { protocolVersion?: unknown; hubPublicKey?: unknown; serviceIdentity?: unknown }
    if (body.protocolVersion !== 1
      || body.hubPublicKey !== this.options.state.config.hubPublicKey
      || body.serviceIdentity !== this.options.state.config.accessClientId) {
      throw new Error('Hub bootstrap identity does not match pinned Node Agent configuration')
    }
  }

  private async connectOnce(signal: AbortSignal): Promise<void> {
    const config = this.options.state.config
    const socket = new WebSocket(webSocketUrl(config.hubUrl, config.nodeId, this.bootId), {
      headers: this.accessHeaders(),
      maxPayload: 256 * 1024 * 1024,
      perMessageDeflate: false,
    })
    let connection: ActiveHubConnection | undefined
    try {
      const challengePromise = receiveOne(socket, 10_000)
      await waitForOpen(socket, signal)
      const challengeInput = await challengePromise
      const challengeVerification = verifyHubEnvelope(challengeInput, config.hubPublicKey)
      if (!challengeVerification.ok) throw new Error('Hub challenge verification failed')
      const challengeEnvelope = challengeVerification.envelope
      const challengeBody = challengeEnvelope.body
      if (challengeBody.type !== 'auth.challenge'
        || challengeBody.audience !== 'node'
        || challengeVerification.envelope.nodeId !== config.nodeId
        || challengeVerification.envelope.connectionGeneration !== 0) {
        throw new Error('Hub challenge verification failed')
      }
      const challenge = challengeBody.challenge
      const now = Date.now()
      const acceptedPromise = receiveOne(socket, 10_000)
      await send(socket, signHubEnvelope({
        protocolVersion: 1,
        nodeId: config.nodeId,
        bootId: this.bootId,
        connectionGeneration: 0,
        messageId: HubMessageId(randomBytes(18).toString('base64url')),
        directionSequence: 1,
        cumulativeAck: this.options.state.journal.inboundAcknowledgement(),
        issuedAt: now,
        expiresAt: now + 10_000,
        body: {
          type: 'auth.node-proof',
          publicKey: this.options.state.identity.publicKey,
          challenge,
          ...(config.enrollmentCode === undefined ? {} : { enrollmentCode: config.enrollmentCode }),
          agentVersion: HUB_NODE_AGENT_VERSION,
          protocolMin: 1,
          protocolMax: 1,
        },
      }, this.options.state.identity.privateKey))
      const acceptedInput = await acceptedPromise
      const acceptedVerification = verifyHubEnvelope(acceptedInput, config.hubPublicKey)
      if (!acceptedVerification.ok) throw new Error('Hub acceptance verification failed')
      const accepted = acceptedVerification.envelope
      const acceptedBody = accepted.body
      if (acceptedBody.type !== 'auth.accepted'
        || accepted.nodeId !== config.nodeId
        || acceptedVerification.envelope.bootId !== challengeEnvelope.bootId
        || acceptedBody.challenge !== challenge
        || acceptedBody.acceptedProtocol !== 1
        || acceptedBody.hubPublicKey !== config.hubPublicKey
        || accepted.connectionGeneration !== acceptedBody.connectionGeneration) {
        throw new Error('Hub acceptance verification failed')
      }
      this.options.state.journal.acknowledgeOutbound(acceptedBody.hubAck)
      await this.options.state.clearEnrollmentCode()
      connection = {
        socket,
        peer: new ReliablePeer({
          nodeId: config.nodeId,
          localBootId: this.bootId,
          expectedRemoteBootId: accepted.bootId,
          connectionGeneration: accepted.connectionGeneration,
          localPrivateKey: this.options.state.identity.privateKey,
          remotePublicKey: config.hubPublicKey,
          journal: this.options.state.journal,
        }),
        sentSequence: 0,
        flushPromise: undefined,
        flushRequested: false,
        messageChain: Promise.resolve(),
        lastPongAt: Date.now(),
        heartbeat: undefined,
        statusTimer: undefined,
      }
      this.connection = connection
      this.installConnection(connection)
      await this.flush(connection)
      await this.recoverInbound(connection)
      for (const baseline of this.connector.baselines()) {
        this.pendingRuntimeStates.set(baseline.runtimeId, baseline)
      }
      this.drainPendingRuntimeStates()
      this.enqueueTransportStatus()
      await this.flush(connection)
      this.notice('connected', `connected as node ${config.nodeId}`)
      await new Promise<void>((resolve) => {
        const onClose = () => { resolve() }
        const onAbort = () => { socket.close(1001, 'Node Agent stopping') }
        socket.once('close', onClose)
        signal.addEventListener('abort', onAbort, { once: true })
        socket.once('close', () => { signal.removeEventListener('abort', onAbort) })
      })
    } finally {
      if (connection?.heartbeat !== undefined) clearInterval(connection.heartbeat)
      if (connection?.statusTimer !== undefined) clearInterval(connection.statusTimer)
      if (connection !== undefined && this.connection === connection) this.connection = undefined
      if (socket.readyState === WebSocket.OPEN) socket.close(1001, 'Node Agent connection reset')
      else if (socket.readyState === WebSocket.CONNECTING) {
        socket.once('error', () => undefined)
        socket.terminate()
      }
    }
  }

  private installConnection(connection: ActiveHubConnection): void {
    connection.socket.on('pong', () => { connection.lastPongAt = Date.now() })
    connection.socket.on('error', () => { connection.socket.close() })
    connection.socket.on('message', (data, binary) => {
      connection.messageChain = connection.messageChain
        .then(() => this.handleHubMessage(connection, data, binary))
        .catch(() => { connection.socket.close(1011, 'Hub protocol failure') })
    })
    connection.heartbeat = setInterval(() => {
      if (Date.now() - connection.lastPongAt > 90_000) connection.socket.terminate()
      else if (connection.socket.readyState === WebSocket.OPEN) connection.socket.ping()
    }, 30_000)
    connection.heartbeat.unref()
    connection.statusTimer = setInterval(() => {
      this.enqueueTransportStatus()
      this.requestFlush()
    }, TRANSPORT_STATUS_INTERVAL_MS)
    connection.statusTimer.unref()
  }

  private async handleHubMessage(connection: ActiveHubConnection, data: WebSocket.RawData, binary: boolean): Promise<void> {
    if (this.connection !== connection) throw new Error('fenced Hub connection')
    if (binary) throw new Error('Hub protocol accepts JSON frames only')
    const received = connection.peer.receive(JSON.parse(webSocketText(data)) as unknown)
    if (received.kind === 'rejected') throw new Error(`Hub frame rejected: ${received.reason}`)
    this.drainDeferredConnectorBodies()
    this.drainPendingRuntimeStates()
    if (this.droppedStreams.size > 0) this.enqueueTransportStatus()
    this.updatePressureNotice()
    this.requestFlush()
    if (received.kind === 'duplicate') return
    const claimed = this.options.state.journal.claimInbound(received.record.sequence)
    if (claimed === undefined) throw new Error('accepted Hub frame was not claimable')
    const complete = await this.processHubInbound(claimed)
    if (complete) {
      this.options.state.journal.completeInbound(claimed.sequence)
      this.options.state.journal.pruneProcessed()
    }
    if (claimed.body.type !== 'transport.ack') {
      connection.peer.enqueueAcknowledgement()
      await this.flush(connection)
    }
  }

  private async processHubInbound(record: ReliableInboundRecord): Promise<boolean> {
    const body = record.body
    if (body.type === 'transport.ack') return true
    if (body.type === 'runtime.resync-required') {
      const targets = body.runtimeId === undefined
        ? this.connector.baselines().map(baseline => baseline.runtimeId)
        : [body.runtimeId]
      for (const runtimeId of targets) await this.connector.send(runtimeId, body)
      return true
    }
    if (body.type !== 'capability.invoke') throw new Error(`unexpected Hub body ${body.type}`)
    const existingResult = this.options.state.journal.pendingOutbound(10_000).some(outbound =>
      outbound.body.type === 'capability.result' && outbound.body.commandId === body.commandId)
    if (existingResult) return true
    const operation = resolveHubOperation(body.capability, body.capabilityVersion, body.operation)
    if (operation === undefined) {
      this.enqueueInvocationError(body.commandId, 'unsupported-operation', 'Connector operation is unavailable', false)
      return true
    }
    if (record.recovery && operation.idempotency === 'never-retry') {
      this.options.state.journal.enqueue({
        type: 'capability.result',
        commandId: body.commandId,
        status: 'outcome-unknown',
        error: { code: 'interrupted-never-retry', message: 'Node Agent restarted during a non-repeatable operation', retryable: false },
      })
      return true
    }
    if (body.capability === 'dsh.plugins'
      || body.capability === 'dsh.snapshots'
      || body.capability === 'dsh.files'
      || body.capability === 'dsh.terminals') {
      const supervisor = this.supervisors.get(body.runtimeId)
      if (supervisor === undefined) {
        this.enqueueInvocationError(body.commandId, 'management-disabled', 'Node management is not configured', false)
        return true
      }
      try {
        const request = operation.request.parse(body.payload)
        const result = operation.response.parse(
          await supervisor.invoke(body.capability, body.operation, request, body.runtimeId),
        )
        this.options.state.journal.enqueue({
          type: 'capability.result',
          commandId: body.commandId,
          status: 'ok',
          value: result as HubJson,
        })
      } catch (error) {
        this.enqueueInvocationError(
          body.commandId,
          error instanceof Error ? error.name : 'management-error',
          error instanceof Error ? error.message : 'Node management failed',
          false,
        )
      }
      return true
    }
    this.pendingCommands.set(body.commandId, record.sequence)
    if (!await this.connector.send(body.runtimeId, body)) {
      this.pendingCommands.delete(body.commandId)
      this.enqueueInvocationError(body.commandId, 'runtime-offline', 'Target DSH runtime is offline', true)
      return true
    }
    return false
  }

  private async recoverInbound(connection: ActiveHubConnection): Promise<void> {
    let cursor = 0
    for (;;) {
      const page = this.options.state.journal.recoverableInboundAfter(cursor)
      if (page.length === 0) break
      for (const pending of page) {
        cursor = pending.sequence
        const claimed = this.options.state.journal.claimInbound(pending.sequence)
        if (claimed === undefined) continue
        if (await this.processHubInbound(claimed)) {
          this.options.state.journal.completeInbound(claimed.sequence)
        }
      }
    }
    this.options.state.journal.pruneProcessed()
    await this.flush(connection)
  }

  private connectorConnected(baseline: LocalRuntimeBaseline): void {
    this.pendingRuntimeStates.set(baseline.runtimeId, baseline)
    this.drainPendingRuntimeStates()
    this.requestFlush()
  }

  private connectorDisconnected(runtimeId: string): void {
    this.pendingRuntimeStates.set(runtimeId, 'offline')
    this.drainPendingRuntimeStates()
    this.requestFlush()
  }

  private connectorBody(body: HubEnvelopeBody): void {
    if (body.type === 'stream.frame' && !isInteractionStream(body) && this.shouldSuppressStream()) {
      this.recordDroppedStream(body)
      return
    }
    try {
      this.acceptConnectorBody(body)
    } catch (error) {
      if (error instanceof Error && error.message === 'reliable outbox quota exceeded') {
        if (this.deferredConnectorBodies.length < DEFERRED_CONNECTOR_BODY_LIMIT) {
          this.deferredConnectorBodies.push(body)
        } else {
          this.notice('error', 'reliable control backlog exhausted its emergency memory reserve')
        }
        this.enqueueTransportStatus()
        return
      }
      this.notice('error', error instanceof Error ? error.message : 'Connector body was rejected')
      return
    }
    this.requestFlush()
  }

  private acceptConnectorBody(body: HubEnvelopeBody): void {
    if (body.type === 'capability.result') {
      const sequence = this.pendingCommands.get(body.commandId)
      if (sequence === undefined) {
        const duplicate = this.options.state.journal.pendingOutbound(10_000).some(outbound =>
          outbound.body.type === 'capability.result' && outbound.body.commandId === body.commandId)
        if (duplicate) return
        throw new Error('Connector result does not match a pending Hub command')
      }
      this.options.state.journal.enqueue(body)
      this.options.state.journal.completeInbound(sequence)
      this.options.state.journal.pruneProcessed()
      this.pendingCommands.delete(body.commandId)
    } else {
      this.options.state.journal.enqueue(body)
    }
  }

  private drainDeferredConnectorBodies(): void {
    for (;;) {
      const body = this.deferredConnectorBodies[0]
      if (body === undefined) return
      try {
        this.acceptConnectorBody(body)
        this.deferredConnectorBodies.shift()
      } catch (error) {
        if (error instanceof Error && error.message === 'reliable outbox quota exceeded') return
        this.deferredConnectorBodies.shift()
        this.notice('error', error instanceof Error ? error.message : 'Deferred Connector body was rejected')
      }
    }
  }

  private drainPendingRuntimeStates(): void {
    for (const [runtimeId, state] of this.pendingRuntimeStates) {
      try {
        if (state === 'offline') {
          this.options.state.journal.enqueue({ type: 'runtime.goodbye', runtimeId, reason: 'connector-stopped' })
        } else {
          this.enqueueRuntimeHello(state)
        }
        this.pendingRuntimeStates.delete(runtimeId)
      } catch (error) {
        if (error instanceof Error && error.message === 'reliable outbox quota exceeded') return
        this.pendingRuntimeStates.delete(runtimeId)
        this.notice('error', error instanceof Error ? error.message : 'Runtime state was rejected')
      }
    }
  }

  private shouldSuppressStream(): boolean {
    const usage = this.options.state.journal.outboundUsage()
    const recordThreshold = usage.maxRecords - Math.min(STREAM_RECORD_RESERVE, Math.ceil(usage.maxRecords * 0.2))
    const byteThreshold = usage.maxBytes - Math.min(STREAM_BYTE_RESERVE, Math.ceil(usage.maxBytes * 0.25))
    return usage.records >= recordThreshold || usage.bytes >= byteThreshold
  }

  private recordDroppedStream(body: Extract<HubEnvelopeBody, { type: 'stream.frame' }>): void {
    const key = `${body.runtimeId}\u0000${body.capability}\u0000${body.stream}`
    const current = this.droppedStreams.get(key)
    if (current !== undefined) {
      this.droppedStreams.set(key, { ...current, frames: current.frames + 1 })
    } else if (this.droppedStreams.size < 128) {
      this.droppedStreams.set(key, {
        runtimeId: body.runtimeId,
        capability: body.capability,
        stream: body.stream,
        frames: 1,
      })
    }
    this.droppedStreamFramesTotal += 1
    this.updatePressureNotice()
  }

  private enqueueTransportStatus(): void {
    const usage = this.options.state.journal.outboundUsage()
    const pressure = this.transportPressure(usage.records, usage.maxRecords, usage.bytes, usage.maxBytes)
    const droppedStreams = [...this.droppedStreams.values()]
    try {
      this.options.state.journal.enqueue({
        type: 'transport.status',
        observedAt: Date.now(),
        pressure,
        outboxRecords: usage.records,
        outboxBytes: usage.bytes,
        maxOutboxRecords: usage.maxRecords,
        maxOutboxBytes: usage.maxBytes,
        ...(usage.oldestCreatedAt === 0 ? {} : { oldestPendingAt: usage.oldestCreatedAt }),
        droppedStreamFramesTotal: this.droppedStreamFramesTotal,
        droppedStreams,
      })
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'reliable outbox quota exceeded') {
        this.notice('error', error instanceof Error ? error.message : 'Transport status was rejected')
      }
      this.updatePressureNotice()
      return
    }
    this.droppedStreams.clear()
    for (const runtimeId of new Set(droppedStreams.map(stream => stream.runtimeId))) {
      void this.connector.send(runtimeId, {
        type: 'runtime.resync-required', runtimeId, reason: 'retention-exceeded',
      }).catch((error: unknown) => {
        this.notice('error', error instanceof Error ? error.message : 'Runtime resynchronization failed')
      })
    }
    this.updatePressureNotice()
  }

  private transportPressure(records: number, maxRecords: number, bytes: number, maxBytes: number): HubTransportStatusBody['pressure'] {
    const ratio = Math.max(records / maxRecords, bytes / maxBytes)
    if (ratio >= 0.95 || this.deferredConnectorBodies.length > 0) return 'critical'
    if (ratio >= 0.75 || this.droppedStreams.size > 0) return 'warning'
    return 'normal'
  }

  private updatePressureNotice(): void {
    const usage = this.options.state.journal.outboundUsage()
    const pressure = this.transportPressure(usage.records, usage.maxRecords, usage.bytes, usage.maxBytes)
    if (pressure === this.reportedPressure) return
    this.reportedPressure = pressure
    if (pressure === 'normal') {
      this.notice('connected', 'reliable transport queue pressure recovered')
    } else {
      this.notice('error', `reliable transport queue pressure is ${pressure} (${String(usage.records)}/${String(usage.maxRecords)} records)`)
    }
  }

  private enqueueRuntimeHello(baseline: LocalRuntimeBaseline): void {
    const capabilities = !this.supervisors.has(baseline.runtimeId)
      ? baseline.capabilities
      : [
        ...baseline.capabilities,
        pluginsCapability.descriptor,
        snapshotsCapability.descriptor,
        filesCapability.descriptor,
        terminalsCapability.descriptor,
      ]
    this.options.state.journal.enqueue({
      type: 'runtime.hello',
      runtimeId: baseline.runtimeId,
      bootId: baseline.runtimeBootId,
      dshVersion: baseline.dshVersion,
      connectorVersion: baseline.connectorVersion,
      capabilities,
    })
  }

  private enqueueInvocationError(commandId: string, code: string, message: string, retryable: boolean): void {
    this.options.state.journal.enqueue({
      type: 'capability.result',
      commandId,
      status: 'error',
      error: { code, message, retryable },
    })
  }

  private flushCurrent(): Promise<void> {
    return this.connection === undefined ? Promise.resolve() : this.flush(this.connection)
  }

  private requestFlush(): void {
    void this.flushCurrent().catch((error: unknown) => {
      this.notice('error', error instanceof Error ? error.message : 'Hub flush failed')
      this.connection?.socket.close(1011, 'Hub flush failed')
    })
  }

  private flush(connection: ActiveHubConnection): Promise<void> {
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
            if (this.connection !== connection || connection.socket.readyState !== WebSocket.OPEN) return
            await send(connection.socket, acknowledgement)
            break
          }
          refreshAcknowledgement = false
          for (const frame of frames) {
            if (this.connection !== connection || connection.socket.readyState !== WebSocket.OPEN) return
            await send(connection.socket, frame)
            connection.sentSequence = frame.directionSequence
          }
        }
        if (!flushWasRequested(connection)) break
      }
    })().finally(() => {
      connection.flushPromise = undefined
      if (connection.flushRequested && this.connection === connection
        && connection.socket.readyState === WebSocket.OPEN) void this.flush(connection)
    })
    return connection.flushPromise
  }

  private accessHeaders(): Record<string, string> {
    return {
      'CF-Access-Client-Id': this.options.state.config.accessClientId,
      'CF-Access-Client-Secret': this.options.state.config.accessClientSecret,
    }
  }

  private notice(state: HubNodeAgentNotice['state'], message: string): void {
    this.options.notice?.({ state, message })
  }
}
