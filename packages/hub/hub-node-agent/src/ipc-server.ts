/** Owner-only local socket server for in-process DSH Connectors. */

import { randomBytes } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  encodeHubIpcFrame, HubIpcFrameDecoder, verifyHubIpcProof,
  type HubIpcBody, type HubIpcFrame, type HubIpcProof,
} from '@k1412/dsh-hub-node-ipc'
import { HubMessageId, verifyHubCapability, type HubEnvelopeBody } from '@k1412/dsh-hub-protocol'

/** Authenticated local runtime baseline. */
export interface LocalRuntimeBaseline {
  runtimeId: string
  runtimeBootId: string
  connectorVersion: string
  dshVersion: string
  capabilities: HubIpcProof['capabilities']
}

/** Callbacks from local Connector lifecycle into the WSS-owning Node Agent. */
export interface HubConnectorCallbacks {
  connected(baseline: LocalRuntimeBaseline): Promise<void> | void
  body(runtimeId: string, body: HubEnvelopeBody): Promise<void> | void
  disconnected(runtimeId: string): Promise<void> | void
}

interface ConnectorConnection {
  socket: Socket
  decoder: HubIpcFrameDecoder
  challenge: string
  authenticated: boolean
  baseline?: LocalRuntimeBaseline
  writes: Promise<void>
  lastHeartbeatAt: number
  authTimeout: NodeJS.Timeout
}

function writeFrame(connection: ConnectorConnection, frame: HubIpcFrame): Promise<void> {
  const operation = connection.writes.then(() => new Promise<void>((resolve) => {
    connection.socket.write(encodeHubIpcFrame(frame), () =>{  resolve() })
  }))
  connection.writes = operation.catch(() => undefined)
  return operation
}

/** Authenticated registry of Connector sockets, keyed by DSH runtime id. */
export class HubConnectorServer {
  private readonly server: Server
  private readonly runtimes = new Map<string, ConnectorConnection>()
  private heartbeat: NodeJS.Timeout | undefined

  public constructor(
    private readonly endpoint: string,
    private readonly secret: string,
    private readonly agentBootId: string,
    private readonly callbacks: HubConnectorCallbacks,
  ) {
    this.server = createServer((socket) =>{  this.acceptSocket(socket) })
  }

  /** Bind the Unix socket or Windows named pipe and begin liveness checks. */
  public async listen(): Promise<void> {
    if (process.platform !== 'win32') {
      await mkdir(dirname(this.endpoint), { recursive: true, mode: 0o700 })
      await chmod(dirname(this.endpoint), 0o700)
      try {
        const existing = await lstat(this.endpoint)
        if (!existing.isSocket()) throw new Error(`refusing to replace non-socket IPC path ${this.endpoint}`)
        await unlink(this.endpoint)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) =>{  reject(error) }
      this.server.once('error', onError)
      this.server.listen(this.endpoint, () => {
        this.server.off('error', onError)
        resolve()
      })
    })
    if (process.platform !== 'win32') await chmod(this.endpoint, 0o600)
    this.heartbeat = setInterval(() => {
      const now = Date.now()
      for (const connection of this.runtimes.values()) {
        if (now - connection.lastHeartbeatAt > 90_000) connection.socket.destroy()
      }
    }, 30_000)
    this.heartbeat.unref()
  }

  /**
   * Current authenticated runtime baselines.
   * @returns one baseline for each connected Connector runtime.
   */
  public baselines(): LocalRuntimeBaseline[] {
    return [...this.runtimes.values()].flatMap(connection =>
      connection.baseline === undefined ? [] : [connection.baseline])
  }

  /**
   * Deliver one Hub body to the Connector owning a runtime.
   * @param runtimeId - target Connector runtime identifier.
   * @param body - validated Hub protocol body to deliver.
   * @returns whether an authenticated runtime accepted the frame for writing.
   */
  public async send(runtimeId: string, body: HubEnvelopeBody): Promise<boolean> {
    const connection = this.runtimes.get(runtimeId)
    if (connection === undefined || !connection.authenticated || connection.socket.destroyed) return false
    await writeFrame(connection, { type: 'ipc.hub-body', body })
    return true
  }

  /** Stop accepting Connectors and remove the Unix socket. */
  public async close(): Promise<void> {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    for (const connection of this.runtimes.values()) connection.socket.destroy()
    this.runtimes.clear()
    await new Promise<void>(resolve => this.server.close(() => { resolve() }))
    if (process.platform !== 'win32') {
      await unlink(this.endpoint).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
  }

  private acceptSocket(socket: Socket): void {
    socket.setNoDelay(true)
    const connection: ConnectorConnection = {
      socket,
      decoder: new HubIpcFrameDecoder(),
      challenge: HubMessageId(randomBytes(18).toString('base64url')),
      authenticated: false,
      writes: Promise.resolve(),
      lastHeartbeatAt: Date.now(),
      authTimeout: setTimeout(() => socket.destroy(), 10_000),
    }
    connection.authTimeout.unref()
    void writeFrame(connection, { type: 'ipc.challenge', challenge: connection.challenge })
      .catch(() => { socket.destroy() })
    let chain = Promise.resolve()
    socket.on('data', (chunk) => {
      chain = chain.then(async () => {
        for (const frame of connection.decoder.push(chunk)) await this.handleFrame(connection, frame)
      }).catch(() => { socket.destroy() })
    })
    socket.once('close', () =>{  this.removeConnection(connection) })
    socket.once('error', () =>{  this.removeConnection(connection) })
  }

  private async handleFrame(connection: ConnectorConnection, frame: HubIpcFrame): Promise<void> {
    connection.lastHeartbeatAt = Date.now()
    if (!connection.authenticated) {
      if (frame.type !== 'ipc.proof'
        || frame.challenge !== connection.challenge
        || !verifyHubIpcProof(this.secret, frame)) {
        throw new Error('Connector IPC proof failed')
      }
      const capabilities = frame.capabilities.map(verifyHubCapability)
      const baseline: LocalRuntimeBaseline = {
        runtimeId: frame.runtimeId,
        runtimeBootId: frame.runtimeBootId,
        connectorVersion: frame.connectorVersion,
        dshVersion: frame.dshVersion,
        capabilities,
      }
      connection.baseline = baseline
      connection.authenticated = true
      clearTimeout(connection.authTimeout)
      const prior = this.runtimes.get(frame.runtimeId)
      this.runtimes.set(frame.runtimeId, connection)
      prior?.socket.destroy()
      await writeFrame(connection, {
        type: 'ipc.accepted',
        challenge: connection.challenge,
        agentBootId: this.agentBootId,
      })
      await this.callbacks.connected(baseline)
      return
    }
    if (frame.type === 'ipc.heartbeat') return
    if (frame.type !== 'ipc.hub-body') throw new Error('unexpected authenticated IPC frame')
    this.assertConnectorBody(connection, frame)
    await this.callbacks.body(connection.baseline?.runtimeId as string, frame.body)
  }

  private assertConnectorBody(connection: ConnectorConnection, frame: HubIpcBody): void {
    const runtimeId = connection.baseline?.runtimeId
    if (runtimeId === undefined) throw new Error('Connector baseline is absent')
    const body = frame.body
    if (body.type === 'capability.result') return
    if (body.type === 'stream.frame' && body.runtimeId === runtimeId) return
    if (body.type === 'runtime.resync-required'
      && (body.runtimeId === undefined || body.runtimeId === runtimeId)) return
    throw new Error(`Connector cannot send local body ${body.type}`)
  }

  private removeConnection(connection: ConnectorConnection): void {
    clearTimeout(connection.authTimeout)
    const runtimeId = connection.baseline?.runtimeId
    if (runtimeId === undefined || this.runtimes.get(runtimeId) !== connection) return
    this.runtimes.delete(runtimeId)
    void this.callbacks.disconnected(runtimeId)
  }
}
