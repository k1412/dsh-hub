/** Native HTTP, SSE, static UI, and WebSocket upgrade server for DSH Hub. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { z } from 'zod'
import { WebSocket, WebSocketServer } from 'ws'
import { HubNodeId, HubRuntimeId, type HubIdentityKeyPair } from '@k1412/dsh-hub-protocol'
import type { HubStorage } from '@k1412/dsh-hub-storage'
import {
  HubAuthError, type HubHumanPrincipal, type HubRequestHeaders, type HubServicePrincipal,
} from './auth.ts'
import { HubAgentRegistry, parseAgentUpgrade } from './agents.ts'
import { HubEventBroker, type HubBrowserEvent } from './events.ts'
import {
  decodeFleetPayload, encodeFleetPayload, singleFleetTarget, type FleetWebTarget,
} from './fleet-web.ts'

/** Access verifier interface implemented by Cloudflare JWT validation. */
export interface HubAccessVerifier {
  verifyHuman(headers: HubRequestHeaders): Promise<HubHumanPrincipal>
  verifyService(headers: HubRequestHeaders): Promise<HubServicePrincipal>
}

/** Private-origin request guard. */
export interface HubRequestGuard {
  permits(headers: HubRequestHeaders): boolean
}

/** Complete Hub server assembly configuration. */
export interface HubServerOptions {
  storage: HubStorage
  access: HubAccessVerifier
  originGuard: HubRequestGuard
  hubIdentity: HubIdentityKeyPair
  publicOrigin: string
  staticDirectory?: string
  /** Receives internal diagnostics; implementations must keep secrets out of their sink. */
  reportError?: (error: unknown) => void
  /** Command wait bound; production keeps 30 seconds, tests may use a shorter deterministic interval. */
  commandTimeoutMs?: number
  /** Per-node Fleet-read bound; one degraded node must not stall the whole sidebar. */
  aggregateCommandTimeoutMs?: number
  /** Browser WebSocket heartbeat; production keeps 20 seconds, tests may shorten it. */
  browserWebSocketHeartbeatMs?: number
}

/** Actual bound address after `listen()`. */
export interface HubListenAddress {
  host: string
  port: number
}

class HttpProblem extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message)
  }
}

interface OfficialWebResponse {
  status: number
  headers: Array<[string, string]>
  encoding: 'utf8' | 'base64'
  body: string
}

interface OfficialRpcEnvelope {
  type: 'server-response'
  rpcId: string
  result: { ok: boolean; value?: unknown; error?: unknown }
}

interface FleetWorkspaceSnapshot {
  workspaceIds: string[]
  archivedSessionIds: string[]
}

const FLEET_AGGREGATE_METHODS = new Set(['session.list', 'session.search', 'workspace.list'])
const INTERACTION_TARGET_LIFETIME_MS = 60 * 60_000
const BROWSER_WEBSOCKET_HEARTBEAT_MS = 20_000
const AGGREGATE_COMMAND_TIMEOUT_MS = 2_500

const enrollmentSchema = z.strictObject({
  nodeId: z.string().min(1).max(64),
  displayName: z.string().min(1).max(128),
  expiresInSeconds: z.number().int().min(60).max(86_400).default(900),
})

const commandSchema = z.strictObject({
  nodeId: z.string().min(1).max(64),
  runtimeId: z.string().min(1).max(64),
  capability: z.string().min(3).max(128),
  capabilityVersion: z.string().min(1).max(128),
  operation: z.string().min(1).max(128),
  payload: z.json(),
})

const terminalClientFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('input'), data: z.string().max(1_048_576) }),
  z.strictObject({
    type: z.literal('resize'),
    columns: z.number().int().min(20).max(1_000),
    rows: z.number().int().min(5).max(1_000),
  }),
])

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

/** Browser policy shared with the production boot regression. */
export const HUB_CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; style-src-elem 'self' 'unsafe-inline'"

function securityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Security-Policy', HUB_CONTENT_SECURITY_POLICY)
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Frame-Options', 'DENY')
}

function json(response: ServerResponse, status: number, value: unknown): void {
  securityHeaders(response)
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(value))
}

function headers(request: IncomingMessage): HubRequestHeaders {
  return request.headers
}

async function jsonBody(request: IncomingMessage, maximumBytes = 1_048_576): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new HttpProblem(415, 'application/json is required')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    bytes += buffer.byteLength
    if (bytes > maximumBytes) throw new HttpProblem(413, 'request body is too large')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new HttpProblem(400, 'request body is not valid JSON')
  }
}

async function textBody(request: IncomingMessage, maximumBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    bytes += buffer.byteLength
    if (bytes > maximumBytes) throw new HttpProblem(413, 'request body is too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sse(response: ServerResponse, event: HubBrowserEvent): void {
  response.write(`id: ${event.id}\n`)
  response.write(`event: ${event.type}\n`)
  response.write(`data: ${JSON.stringify({ occurredAt: event.occurredAt, data: event.data })}\n\n`)
}

function normalizePublicOrigin(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('publicOrigin must be an HTTPS origin without path, credentials, query, or fragment')
  }
  return url.origin
}

/** Complete single-process Hub control-plane server. */
export class HubServer {
  private readonly http: Server
  private readonly agentWebSockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024, perMessageDeflate: false })
  private readonly terminalWebSockets = new WebSocketServer({ noServer: true, maxPayload: 1_048_576, perMessageDeflate: false })
  private readonly officialWebSockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024, perMessageDeflate: false })
  private readonly events = new HubEventBroker()
  private readonly interactionTargets = new Map<string, { target: FleetWebTarget; expiresAt: number }>()
  private readonly workspaceSnapshots = new Map<string, FleetWorkspaceSnapshot>()
  /** Authenticated outbound-node registry used by REST and terminal routing. */
  public readonly agents: HubAgentRegistry
  private readonly publicOrigin: string
  private readonly staticDirectory: string | undefined
  private readonly browserWebSocketHeartbeatMs: number
  private readonly aggregateCommandTimeoutMs: number
  private readonly maintenance: NodeJS.Timeout

  public constructor(private readonly options: HubServerOptions) {
    this.publicOrigin = normalizePublicOrigin(options.publicOrigin)
    this.staticDirectory = options.staticDirectory === undefined ? undefined : resolve(options.staticDirectory)
    this.browserWebSocketHeartbeatMs = options.browserWebSocketHeartbeatMs ?? BROWSER_WEBSOCKET_HEARTBEAT_MS
    this.aggregateCommandTimeoutMs = options.aggregateCommandTimeoutMs ?? AGGREGATE_COMMAND_TIMEOUT_MS
    if (!Number.isSafeInteger(this.browserWebSocketHeartbeatMs)
      || this.browserWebSocketHeartbeatMs < 10 || this.browserWebSocketHeartbeatMs > 60_000) {
      throw new Error('browserWebSocketHeartbeatMs must be an integer from 10 to 60000')
    }
    if (!Number.isSafeInteger(this.aggregateCommandTimeoutMs)
      || this.aggregateCommandTimeoutMs < 10 || this.aggregateCommandTimeoutMs > 30_000) {
      throw new Error('aggregateCommandTimeoutMs must be an integer from 10 to 30000')
    }
    this.agents = new HubAgentRegistry(options.storage, this.events, options.hubIdentity)
    this.maintenance = setInterval(() => {
      options.storage.control.redactTerminalCommandContentBefore(Date.now() - 5 * 60_000)
      const now = Date.now()
      for (const [rpcId, record] of this.interactionTargets) {
        if (record.expiresAt <= now) this.interactionTargets.delete(rpcId)
      }
    }, 60_000)
    this.maintenance.unref()
    this.http = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => { this.handleError(response, error) })
    })
    this.http.on('upgrade', (request, socket, head) => {
      void this.handleUpgrade(request, socket, head).catch((error: unknown) => {
        this.options.reportError?.(error)
        socket.destroy()
      })
    })
  }

  /**
   * Bind the Hub listener; deployments normally use an unprivileged container port.
   * @param host - explicit local bind address.
   * @param port - unprivileged TCP port, or zero for an ephemeral test port.
   * @returns actual bound address.
   */
  public listen(host: string, port: number): Promise<HubListenAddress> {
    return new Promise((resolveListen, reject) => {
      const onError = (error: Error) => {
        this.http.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        this.http.off('error', onError)
        const address = this.http.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('Hub did not bind a TCP address'))
          return
        }
        resolveListen({ host: address.address, port: address.port })
      }
      this.http.once('error', onError)
      this.http.once('listening', onListening)
      this.http.listen(port, host)
    })
  }

  /** Stop accepting requests and close active Agent connections. */
  public async close(): Promise<void> {
    clearInterval(this.maintenance)
    this.agents.close()
    this.agentWebSockets.close()
    this.terminalWebSockets.close()
    this.officialWebSockets.close()
    await new Promise<void>((resolveClose, reject) => {
      this.http.close((error) => {
        if (error === undefined) resolveClose()
        else reject(error)
      })
    })
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.options.originGuard.permits(headers(request))) throw new HttpProblem(404, 'not found')
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', this.publicOrigin)
    if (method === 'GET' && url.pathname === '/healthz') {
      json(response, 200, { status: 'ok' })
      return
    }
    if (method === 'GET' && url.pathname === '/hub/v1/bootstrap') {
      const service = await this.options.access.verifyService(headers(request))
      json(response, 200, {
        protocolVersion: 1,
        hubPublicKey: this.options.hubIdentity.publicKey,
        serviceIdentity: service.commonName,
      })
      return
    }
    const human = await this.options.access.verifyHuman(headers(request))
    if (method !== 'GET' && method !== 'HEAD') this.requireSameOrigin(request)

    if ((method === 'GET' || method === 'HEAD' || method === 'POST') && url.pathname.startsWith('/api/')) {
      await this.proxyOfficialRequest(request, response, url, human, method)
      return
    }

    if (method === 'GET' && url.pathname === '/hub/v1/events') {
      this.openEvents(request, response, human)
      return
    }
    if (method === 'GET' && url.pathname === '/hub/v1/me') {
      json(response, 200, { email: human.email, expiresAt: human.expiresAt })
      return
    }
    if ((method === 'GET' || method === 'HEAD') && (url.pathname === '/' || url.pathname === '/setup.html')) {
      const target = this.firstOfficialRuntime()
      const hasKnownRuntime = this.officialRuntimes(true).length > 0
      if (url.pathname === '/' && target === undefined && !hasKnownRuntime) {
        this.redirect(response, '/setup.html')
        return
      }
      if (url.pathname === '/setup.html' && (target !== undefined || hasKnownRuntime)) {
        this.redirect(response, '/')
        return
      }
    }
    if (method === 'GET' && url.pathname === '/hub/v1/nodes') {
      json(response, 200, {
        nodes: this.options.storage.control.listNodes().map(node => ({
          ...node,
          online: this.agents.isOnline(node.nodeId),
          transport: this.agents.transportHealth(node.nodeId),
        })),
        runtimes: this.options.storage.control.listRuntimes(),
      })
      return
    }
    if (method === 'GET' && url.pathname === '/hub/v1/enrollments') {
      json(response, 200, {
        enrollments: this.options.storage.control.listPendingEnrollments(),
      })
      return
    }
    if (method === 'GET' && url.pathname === '/hub/v1/sessions') {
      const node = url.searchParams.get('nodeId')
      json(response, 200, {
        sessions: this.options.storage.control.listSessionIndex(node === null ? undefined : HubNodeId(node)),
      })
      return
    }
    if (method === 'GET' && url.pathname === '/hub/v1/commands') {
      const limit = Number(url.searchParams.get('limit') ?? '100')
      const node = url.searchParams.get('nodeId')
      json(response, 200, {
        commands: this.options.storage.control.listCommands(
          limit, node === null ? undefined : HubNodeId(node),
        ).map(({ payload: _payload, result: _result, ...command }) => command),
      })
      return
    }
    if (method === 'GET' && url.pathname === '/hub/v1/audit') {
      const limit = Number(url.searchParams.get('limit') ?? '100')
      const node = url.searchParams.get('nodeId')
      json(response, 200, {
        records: this.options.storage.control.listAudit(
          limit, node === null ? undefined : HubNodeId(node),
        ),
      })
      return
    }
    const commandStatus = /^\/hub\/v1\/commands\/([^/]+)$/.exec(url.pathname)
    if (method === 'GET' && commandStatus !== null) {
      const command = this.options.storage.control.getCommand(decodeURIComponent(commandStatus[1] as string))
      if (command === undefined) throw new HttpProblem(404, 'command not found')
      json(response, 200, { command })
      return
    }
    if (method === 'POST' && commandStatus !== null) {
      await jsonBody(request)
      const command = this.options.storage.control.getCommand(decodeURIComponent(commandStatus[1] as string))
      if (command === undefined) throw new HttpProblem(404, 'command not found')
      if (command.terminalAt === undefined) throw new HttpProblem(409, 'command is not complete')
      this.options.storage.control.redactTerminalCommandContent(command.commandId)
      json(response, 200, { acknowledged: true })
      return
    }
    if (method === 'POST' && url.pathname === '/hub/v1/enrollments') {
      const input = enrollmentSchema.parse(await jsonBody(request))
      const grant = this.options.storage.control.createEnrollment(
        HubNodeId(input.nodeId), input.displayName, Date.now() + input.expiresInSeconds * 1_000,
      )
      this.options.storage.control.appendAudit({
        occurredAt: Date.now(),
        actor: `human:${human.email}`,
        action: 'node.enrollment.created',
        nodeId: grant.nodeId,
        outcome: 'ok',
        details: { expiresAt: grant.expiresAt },
      })
      json(response, 201, grant)
      return
    }
    const cancelEnrollment = /^\/hub\/v1\/enrollments\/([^/]+)\/cancel$/.exec(url.pathname)
    if (method === 'POST' && cancelEnrollment !== null) {
      const nodeId = HubNodeId(decodeURIComponent(cancelEnrollment[1] as string))
      await jsonBody(request)
      this.options.storage.control.cancelEnrollment(nodeId)
      this.options.storage.control.appendAudit({
        occurredAt: Date.now(),
        actor: `human:${human.email}`,
        action: 'node.enrollment.cancelled',
        nodeId,
        outcome: 'ok',
        details: {},
      })
      json(response, 200, { cancelled: true })
      return
    }
    const revoke = /^\/hub\/v1\/nodes\/([^/]+)\/revoke$/.exec(url.pathname)
    if (method === 'POST' && revoke !== null) {
      const nodeId = HubNodeId(decodeURIComponent(revoke[1] as string))
      await jsonBody(request)
      this.options.storage.control.revokeNode(nodeId)
      this.agents.fence(nodeId)
      this.options.storage.control.appendAudit({
        occurredAt: Date.now(),
        actor: `human:${human.email}`,
        action: 'node.revoked',
        nodeId,
        outcome: 'ok',
        details: {},
      })
      json(response, 200, { revoked: true })
      return
    }
    if (method === 'POST' && url.pathname === '/hub/v1/commands') {
      const input = commandSchema.parse(await jsonBody(request))
      const command = await this.agents.invoke(
        HubNodeId(input.nodeId), HubRuntimeId(input.runtimeId), input.capability,
        input.capabilityVersion, input.operation, input.payload, `human:${human.email}`,
      )
      json(response, 202, { command })
      return
    }
    if (method === 'GET' || method === 'HEAD') {
      if (await this.serveStatic(url.pathname, method === 'HEAD', response)) return
    }
    throw new HttpProblem(404, 'not found')
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ): Promise<void> {
    if (!this.options.originGuard.permits(headers(request))) throw new Error('private origin guard rejected upgrade')
    const url = new URL(request.url ?? '/', this.publicOrigin)
    if (url.pathname === '/hub/v1/agent') {
      const service = await this.options.access.verifyService(headers(request))
      const upgrade = parseAgentUpgrade(request)
      this.agentWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
        void this.agents.accept(webSocket, upgrade, service).catch((error: unknown) => {
          this.options.reportError?.(error)
          webSocket.close(4003, 'Agent authentication failed')
        })
      })
      return
    }
    if (url.pathname === '/hub/v1/terminal') {
      const human = await this.options.access.verifyHuman(headers(request))
      if (request.headers.origin !== this.publicOrigin) throw new Error('terminal WebSocket requires same origin')
      const nodeId = HubNodeId(url.searchParams.get('nodeId') ?? '')
      const runtimeId = HubRuntimeId(url.searchParams.get('runtimeId') ?? '')
      const cwd = url.searchParams.get('cwd') ?? undefined
      const columns = Number(url.searchParams.get('columns') ?? '80')
      const rows = Number(url.searchParams.get('rows') ?? '24')
      if (!Number.isInteger(columns) || columns < 20 || columns > 1_000
        || !Number.isInteger(rows) || rows < 5 || rows > 1_000) throw new Error('terminal dimensions are invalid')
      this.terminalWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
        void this.openBrowserTerminal(webSocket, human, nodeId, runtimeId, cwd, columns, rows).catch((error: unknown) => {
          this.options.reportError?.(error)
          webSocket.close(1011, 'terminal session failed')
        })
      })
      return
    }
    if (url.pathname === '/api/events.mux' || url.pathname === '/api/events.host') {
      const human = await this.options.access.verifyHuman(headers(request))
      if (request.headers.origin !== this.publicOrigin) throw new Error('official Web stream requires same origin')
      const stream = url.pathname.endsWith('.mux') ? 'mux' : 'host'
      this.officialWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
        void this.openOfficialStream(webSocket, human, stream).catch((error: unknown) => {
          this.options.reportError?.(error)
          webSocket.close(1011, 'official Web stream failed')
        })
      })
      return
    }
    throw new Error('unknown WebSocket endpoint')
  }

  private async proxyOfficialRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    human: HubHumanPrincipal,
    method: string,
  ): Promise<void> {
    const forwarded = new URL(url)
    const requestedTarget = this.resolveOfficialTarget({
      nodeId: url.searchParams.get('nodeId') ?? '',
      runtimeId: url.searchParams.get('runtimeId') ?? '',
    })
    forwarded.searchParams.delete('nodeId')
    forwarded.searchParams.delete('runtimeId')
    let bodyValue: unknown
    if (method === 'POST') {
      const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') throw new HttpProblem(415, 'application/json is required')
      const body = await textBody(request, 160 * 1024 * 1024)
      try {
        bodyValue = JSON.parse(body) as unknown
      } catch {
        throw new HttpProblem(400, 'request body is not valid JSON')
      }
    }

    let decodedBody: ReturnType<typeof decodeFleetPayload>
    try {
      decodedBody = decodeFleetPayload(bodyValue)
    } catch (error) {
      throw new HttpProblem(400, error instanceof Error ? error.message : 'fleet identity is malformed')
    }
    let payloadTarget: FleetWebTarget | undefined
    try {
      payloadTarget = singleFleetTarget(decodedBody.targets)
    } catch (error) {
      throw new HttpProblem(409, error instanceof Error ? error.message : 'request spans multiple Runtimes')
    }
    let queryTarget: FleetWebTarget | undefined
    for (const [name, value] of [...forwarded.searchParams.entries()]) {
      let decoded: ReturnType<typeof decodeFleetPayload>
      try {
        decoded = decodeFleetPayload(value, name)
      } catch (error) {
        throw new HttpProblem(400, error instanceof Error ? error.message : 'fleet identity is malformed')
      }
      let candidate: FleetWebTarget | undefined
      try {
        candidate = singleFleetTarget(decoded.targets)
      } catch (error) {
        throw new HttpProblem(409, error instanceof Error ? error.message : 'request spans multiple Runtimes')
      }
      if (candidate !== undefined) {
        if (queryTarget !== undefined
          && (queryTarget.nodeId !== candidate.nodeId || queryTarget.runtimeId !== candidate.runtimeId)) {
          throw new HttpProblem(409, 'one request cannot address multiple DSH Runtimes')
        }
        queryTarget = candidate
      }
      forwarded.searchParams.set(name, String(decoded.value))
    }
    if (payloadTarget !== undefined && queryTarget !== undefined
      && (payloadTarget.nodeId !== queryTarget.nodeId || payloadTarget.runtimeId !== queryTarget.runtimeId)) {
      throw new HttpProblem(409, 'one request cannot address multiple DSH Runtimes')
    }
    const rpc = this.officialRpcRequest(decodedBody.value)
    if (method === 'POST' && rpc?.type === 'client-request'
      && payloadTarget === undefined && queryTarget === undefined
      && FLEET_AGGREGATE_METHODS.has(rpc.method)) {
      const aggregated = await this.aggregateOfficialRequest(
        rpc.method,
        `${forwarded.pathname}${forwarded.search}`,
        decodedBody.value,
        human,
      )
      this.writeOfficialResponse(response, aggregated, method)
      return
    }

    const responseTarget = rpc?.type === 'client-response'
      ? this.interactionTarget(rpc.rpcId)
      : undefined
    const target = this.requireOfficialTarget(
      payloadTarget ?? queryTarget ?? responseTarget ?? requestedTarget ?? this.firstOfficialRuntime(),
    )
    const result = await this.invokeOfficialRequest(
      target,
      method,
      `${forwarded.pathname}${forwarded.search}`,
      decodedBody.value,
      human,
    )
    this.writeOfficialResponse(
      response,
      this.encodeOfficialResponse(result, target, rpc?.method),
      method,
    )
  }

  private writeOfficialResponse(response: ServerResponse, result: OfficialWebResponse, method: string): void {
    const bytes = result.encoding === 'base64'
      ? Buffer.from(result.body, 'base64')
      : Buffer.from(result.body, 'utf8')
    securityHeaders(response)
    response.statusCode = result.status
    for (const header of result.headers) {
      const name = header[0].toLowerCase()
      if (name === 'connection' || name === 'content-length' || name === 'transfer-encoding'
        || name === 'set-cookie') continue
      response.setHeader(header[0], header[1])
    }
    response.setHeader('Content-Length', bytes.byteLength)
    if (method === 'HEAD') response.end()
    else response.end(bytes)
  }

  private async invokeOfficialRequest(
    target: FleetWebTarget,
    method: string,
    path: string,
    body: unknown,
    human: HubHumanPrincipal,
    waitTimeoutMs?: number,
  ): Promise<OfficialWebResponse> {
    if (!this.agents.isOnline(HubNodeId(target.nodeId))) throw new HttpProblem(503, 'node is offline')
    const command = await this.agents.invoke(
      HubNodeId(target.nodeId),
      HubRuntimeId(target.runtimeId),
      'dsh.web',
      '1.0.0',
      'fetch',
      {
        clientMutationId: crypto.randomUUID(),
        method,
        path,
        headers: method === 'POST' ? [['content-type', 'application/json']] : [],
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      },
      `human:${human.email}`,
    )
    const rpcMethod = typeof body === 'object' && body !== null && 'method' in body
      && typeof (body as { method?: unknown }).method === 'string'
      ? (body as { method: string }).method.slice(0, 128)
      : undefined
    const completed = await this.waitCommand(command.commandId, rpcMethod, waitTimeoutMs)
    const commandResult = completed.result
    this.redactCommand(completed)
    if (completed.status !== 'ok') {
      return this.officialCommandFailure(body, commandResult)
    }
    if (typeof commandResult !== 'object' || commandResult === null) {
      throw new HttpProblem(502, 'node Web request failed')
    }
    const result = commandResult as Partial<OfficialWebResponse>
    if (typeof result.status !== 'number'
      || !Array.isArray(result.headers)
      || (result.encoding !== 'utf8' && result.encoding !== 'base64')
      || typeof result.body !== 'string') {
      throw new Error('node Web response is invalid')
    }
    return result as OfficialWebResponse
  }

  private officialCommandFailure(body: unknown, failure: unknown): OfficialWebResponse {
    const rpc = this.officialRpcRequest(body)
    if (rpc === undefined || rpc.type !== 'client-request') {
      throw new HttpProblem(502, 'node Web request failed')
    }
    const record = typeof failure === 'object' && failure !== null && !Array.isArray(failure)
      ? failure as Record<string, unknown>
      : {}
    const candidateMessage = typeof record.message === 'string' ? record.message : 'Node request failed'
    const message = Array.from(candidateMessage, (character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 31 || codePoint === 127 ? ' ' : character
    }).join('').slice(0, 8_192)
    return {
      status: 200,
      headers: [['content-type', 'application/json; charset=utf-8']],
      encoding: 'utf8',
      body: JSON.stringify({
        type: 'server-response',
        rpcId: rpc.rpcId,
        result: { ok: false, error: { code: 'internal', message, details: {} } },
      }),
    }
  }

  private encodeOfficialResponse(
    result: OfficialWebResponse,
    target: FleetWebTarget,
    rpcMethod?: string,
  ): OfficialWebResponse {
    if (result.encoding !== 'utf8'
      || !result.headers.some(([name, value]) => name.toLowerCase() === 'content-type'
        && value.toLowerCase().includes('json'))) return result
    let value: unknown
    try {
      value = JSON.parse(result.body) as unknown
    } catch {
      throw new Error('node Web JSON response is invalid')
    }
    const encoded = encodeFleetPayload(value, target)
    this.updateWorkspaceRpcSnapshot(value, target, rpcMethod)
    this.installFleetWorkspaceSnapshot(encoded, rpcMethod)
    return { ...result, body: JSON.stringify(encoded) }
  }

  private offlineOfficialTargets(): FleetWebTarget[] {
    const online = new Set(this.officialRuntimes().map(target => this.workspaceTargetKey(target)))
    return this.officialRuntimes(true).filter(target => !online.has(this.workspaceTargetKey(target)))
  }

  private cachedSessionsFor(targets: FleetWebTarget[], suffix: string): unknown[] {
    const sessions = this.options.storage.control.listSessionIndex()
    return targets.flatMap((target) => {
      const cachedTarget = { ...target, displayName: `${target.displayName ?? target.nodeId}${suffix}` }
      return sessions.filter(session => session.nodeId === target.nodeId && session.runtimeId === target.runtimeId)
        .map(session => encodeFleetPayload({
          sessionId: session.sourceId,
          updatedAt: session.updatedAt,
          running: false,
          blank: false,
          cwd: session.workspacePath ?? '',
          projections: {
            asOfSeq: 0,
            values: {
              ...(session.title === undefined ? {} : { title: session.title }),
              sessionListMetadata: { blank: false, lastPromptAt: session.updatedAt },
            },
          },
        }, cachedTarget))
    })
  }

  private cachedWorkspacesFor(targets: FleetWebTarget[], suffix: string): unknown[] {
    const sessions = this.options.storage.control.listSessionIndex()
    return targets.flatMap((target) => {
      const cachedTarget = { ...target, displayName: `${target.displayName ?? target.nodeId}${suffix}` }
      const grouped = new Map<string, typeof sessions>()
      for (const session of sessions) {
        if (session.nodeId !== target.nodeId || session.runtimeId !== target.runtimeId
          || session.workspacePath === undefined) continue
        const rows = grouped.get(session.workspacePath) ?? []
        rows.push(session)
        grouped.set(session.workspacePath, rows)
      }
      return [...grouped].map(([path, rows]) => {
        const updatedAt = Math.max(...rows.map(row => row.updatedAt))
        const segments = path.split(/[\\/]/u).filter(Boolean)
        return encodeFleetPayload({
          workspaceId: `offline:${path}`,
          path,
          title: segments.at(-1) ?? path,
          sessionIds: rows.map(row => row.sourceId),
          createdAt: new Date(updatedAt).toISOString(),
          updatedAt: new Date(updatedAt).toISOString(),
        }, cachedTarget)
      })
    })
  }

  private async aggregateOfficialRequest(
    rpcMethod: string,
    path: string,
    body: unknown,
    human: HubHumanPrincipal,
  ): Promise<OfficialWebResponse> {
    const targets = this.officialRuntimes()
    const offlineTargets = this.offlineOfficialTargets()
    const cachedSessions = rpcMethod === 'session.list'
      ? this.cachedSessionsFor(offlineTargets, '（离线）')
      : []
    const cachedWorkspaces = rpcMethod === 'workspace.list'
      ? this.cachedWorkspacesFor(offlineTargets, '（离线）')
      : []
    if (targets.length === 0 && rpcMethod !== 'session.list' && rpcMethod !== 'workspace.list') {
      throw new HttpProblem(503, 'no DSH Web Runtime is online')
    }
    const settled = await Promise.all(targets.map(async (target) => {
      try {
        return {
          target,
          response: await this.invokeOfficialRequest(
            target, 'POST', path, body, human, this.aggregateCommandTimeoutMs,
          ),
        }
      } catch (error) {
        // waitCommand already records and reports bounded node timeouts.
        if (!(error instanceof HttpProblem && error.status === 504)) this.options.reportError?.(error)
        return { target, error }
      }
    }))
    const envelopes: Array<{ target: FleetWebTarget; response: OfficialWebResponse; envelope: OfficialRpcEnvelope }> = []
    const failedTargets: FleetWebTarget[] = []
    for (const item of settled) {
      if ('error' in item) {
        failedTargets.push(item.target)
        continue
      }
      const envelope = this.parseOfficialEnvelope(item.response)
      if (envelope?.result.ok === true) envelopes.push({ ...item, envelope })
      else failedTargets.push(item.target)
    }
    if (rpcMethod === 'session.list') {
      cachedSessions.push(...this.cachedSessionsFor(failedTargets, '（暂不可用）'))
    } else if (rpcMethod === 'workspace.list') {
      cachedWorkspaces.push(...this.cachedWorkspacesFor(failedTargets, '（暂不可用）'))
    }
    if (envelopes.length === 0 && cachedSessions.length === 0 && cachedWorkspaces.length === 0
      && targets.length > 0) throw new HttpProblem(502, 'no node returned a usable Web response')
    const request = this.officialRpcRequest(body)
    const rpcId = envelopes[0]?.envelope.rpcId ?? request?.rpcId
    if (rpcId === undefined) throw new HttpProblem(400, 'official Web request is invalid')
    let value: unknown
    if (rpcMethod === 'session.list') {
      const items = envelopes.flatMap(({ target, envelope }) => {
        const rows = (envelope.result.value as { items?: unknown } | undefined)?.items
        return Array.isArray(rows) ? rows.map(row => encodeFleetPayload(row, target)) : []
      }).concat(cachedSessions).sort((left, right) => Number((right as { updatedAt?: unknown }).updatedAt ?? 0)
        - Number((left as { updatedAt?: unknown }).updatedAt ?? 0))
      value = { items }
    } else if (rpcMethod === 'workspace.list') {
      for (const { target, envelope } of envelopes) {
        this.updateWorkspaceListSnapshot(target, envelope.result.value)
      }
      value = {
        items: envelopes.flatMap(({ target, envelope }) => {
          const rows = (envelope.result.value as { items?: unknown } | undefined)?.items
          return Array.isArray(rows) ? rows.map(row => encodeFleetPayload(row, target)) : []
        }).concat(cachedWorkspaces),
        archivedSessionIds: envelopes.flatMap(({ target, envelope }) => {
          const rows = (envelope.result.value as { archivedSessionIds?: unknown } | undefined)?.archivedSessionIds
          return Array.isArray(rows)
            ? encodeFleetPayload({ sessionIds: rows }, target) as { sessionIds: unknown[] }
            : { sessionIds: [] }
        }).flatMap(record => record.sessionIds),
      }
    } else {
      const lists = envelopes.map(({ target, envelope }) => {
        const items = (envelope.result.value as { items?: unknown } | undefined)?.items
        return Array.isArray(items) ? items.map(item => encodeFleetPayload(item, target)) : []
      })
      const rows: unknown[] = []
      for (let rank = 0; rows.length < 20 && lists.some(list => rank < list.length); rank += 1) {
        for (const list of lists) {
          if (rows.length === 20) break
          if (rank < list.length) rows.push(list[rank])
        }
      }
      const total = lists.reduce((sum, list) => sum + list.length, 0)
      value = {
        items: rows,
        hasMore: total > 20 || envelopes.some(({ envelope }) =>
          (envelope.result.value as { hasMore?: unknown } | undefined)?.hasMore === true),
      }
    }
    return {
      status: 200,
      headers: [['content-type', 'application/json; charset=utf-8']],
      encoding: 'utf8',
      body: JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }),
    }
  }

  private parseOfficialEnvelope(response: OfficialWebResponse): OfficialRpcEnvelope | undefined {
    if (response.status !== 200 || response.encoding !== 'utf8') return undefined
    try {
      const value = JSON.parse(response.body) as Partial<OfficialRpcEnvelope>
      if (value.type !== 'server-response' || typeof value.rpcId !== 'string'
        || typeof value.result !== 'object'
        || typeof value.result.ok !== 'boolean') return undefined
      return value as OfficialRpcEnvelope
    } catch {
      return undefined
    }
  }

  private officialRpcRequest(value: unknown): {
    type: 'client-request' | 'client-response'
    rpcId: string
    method: string
  } | undefined {
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as { type?: unknown; rpcId?: unknown; method?: unknown }
    if ((record.type !== 'client-request' && record.type !== 'client-response')
      || typeof record.rpcId !== 'string') return undefined
    return {
      type: record.type,
      rpcId: record.rpcId,
      method: typeof record.method === 'string' ? record.method : '',
    }
  }

  private async openOfficialStream(
    socket: WebSocket,
    human: HubHumanPrincipal,
    stream: 'mux' | 'host',
  ): Promise<void> {
    if (this.officialRuntimes().length === 0) throw new Error('no DSH Web Runtime is online')
    const subscription = this.events.subscribe(undefined, (event) => {
      if (event.type === 'stream.interrupted' && typeof event.data === 'object' && event.data !== null) {
        const interrupted = event.data as { capability?: unknown; stream?: unknown }
        if (interrupted.capability === 'dsh.web' && interrupted.stream === stream) {
          socket.close(1012, 'node stream resynchronization required')
        }
        return
      }
      if (event.type !== 'stream.frame' || typeof event.data !== 'object' || event.data === null) return
      const data = event.data as {
        nodeId?: unknown
        runtimeId?: unknown
        capability?: unknown
        stream?: unknown
        payload?: unknown
      }
      if (typeof data.nodeId !== 'string' || typeof data.runtimeId !== 'string'
        || data.capability !== 'dsh.web' || data.stream !== stream) return
      const target = this.resolveOfficialTarget({ nodeId: data.nodeId, runtimeId: data.runtimeId })
      if (target === undefined) return
      const rewritten = encodeFleetPayload(data.payload, target)
      this.updateWorkspaceHostSnapshot(data.payload, target)
      this.installFleetWorkspaceHostSnapshot(rewritten)
      if (typeof data.payload === 'object' && data.payload !== null
        && 'rpcId' in data.payload && typeof data.payload.rpcId === 'string') {
        this.rememberInteractionTarget(data.payload.rpcId, target)
      }
      void this.sendWebSocket(socket, rewritten).catch(() => { socket.close() })
    })
    const expiry = setTimeout(() => { socket.close(4003, 'operator authentication expired') }, Math.min(
      2_147_483_647, Math.max(1_000, human.expiresAt * 1_000 - Date.now()),
    ))
    const stopHeartbeat = this.startBrowserWebSocketHeartbeat(socket)
    expiry.unref()
    await new Promise<void>(resolveClose => socket.once('close', resolveClose))
    stopHeartbeat()
    clearTimeout(expiry)
    subscription.unsubscribe()
  }

  private async openBrowserTerminal(
    socket: WebSocket,
    human: HubHumanPrincipal,
    nodeId: ReturnType<typeof HubNodeId>,
    runtimeId: ReturnType<typeof HubRuntimeId>,
    cwd: string | undefined,
    columns: number,
    rows: number,
  ): Promise<void> {
    const stopHeartbeat = this.startBrowserWebSocketHeartbeat(socket)
    if (!this.agents.isOnline(nodeId)) throw new Error('node is offline')
    const openedCommand = await this.agents.invoke(
      nodeId, runtimeId, 'dsh.terminals', '1.0.0', 'open', {
        clientMutationId: crypto.randomUUID(),
        ...(cwd === undefined || cwd === '' ? {} : { cwd }),
        columns,
        rows,
      }, `human:${human.email}`,
    )
    const opened = await this.waitCommand(openedCommand.commandId)
    this.redactCommand(opened)
    if (opened.status !== 'ok'
      || typeof opened.result !== 'object' || opened.result === null
      || typeof (opened.result as { terminalId?: unknown }).terminalId !== 'string') {
      throw new Error('terminal open failed')
    }
    const terminalId = (opened.result as { terminalId: string }).terminalId
    await this.sendWebSocket(socket, { type: 'opened', terminalId })
    const subscription = this.events.subscribe(undefined, (event) => {
      if (event.type !== 'stream.frame' || typeof event.data !== 'object' || event.data === null) return
      const data = event.data as { nodeId?: unknown; runtimeId?: unknown; capability?: unknown; payload?: unknown }
      if (data.nodeId !== nodeId || data.runtimeId !== runtimeId || data.capability !== 'dsh.terminals'
        || typeof data.payload !== 'object' || data.payload === null
        || (data.payload as { terminalId?: unknown }).terminalId !== terminalId) return
      void this.sendWebSocket(socket, { type: 'output', ...(data.payload as Record<string, unknown>) })
        .catch(() => { socket.close() })
    })
    let chain = Promise.resolve()
    socket.on('message', (data, binary) => {
      chain = chain.then(async () => {
        if (binary) throw new Error('terminal browser protocol requires JSON')
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer ? Buffer.from(data) : data
        const text = bytes.toString('utf8')
        const frame = terminalClientFrameSchema.parse(JSON.parse(text) as unknown)
        const operation = frame.type === 'input' ? 'write' : 'resize'
        if (!this.agents.isOnline(nodeId)) throw new Error('node is offline')
        const payload = frame.type === 'input'
          ? { terminalId, encoding: 'utf8', data: frame.data }
          : { terminalId, columns: frame.columns, rows: frame.rows }
        const command = await this.agents.invoke(
          nodeId, runtimeId, 'dsh.terminals', '1.0.0', operation, payload, `human:${human.email}`,
        )
        const completed = await this.waitCommand(command.commandId)
        this.redactCommand(completed)
        if (completed.status !== 'ok') throw new Error(`terminal ${operation} failed`)
      }).catch((error: unknown) => {
        this.options.reportError?.(error)
        socket.close(1011, 'terminal command failed')
      })
    })
    const expiry = setTimeout(() => { socket.close(4003, 'operator authentication expired') }, Math.min(
      2_147_483_647, Math.max(1_000, human.expiresAt * 1_000 - Date.now()),
    ))
    expiry.unref()
    await new Promise<void>(resolveClose => socket.once('close', resolveClose))
    stopHeartbeat()
    clearTimeout(expiry)
    subscription.unsubscribe()
    await chain.catch(() => undefined)
    const closeCommand = this.agents.isOnline(nodeId)
      ? await this.agents.invoke(
        nodeId, runtimeId, 'dsh.terminals', '1.0.0', 'close', { terminalId }, `human:${human.email}`,
      ).catch(() => undefined)
      : undefined
    if (closeCommand !== undefined) {
      const closed = await this.waitCommand(closeCommand.commandId).catch(() => undefined)
      if (closed !== undefined) this.redactCommand(closed)
    }
  }

  private async waitCommand(
    commandId: string,
    rpcMethod?: string,
    timeoutOverrideMs?: number,
  ): Promise<NonNullable<ReturnType<HubStorage['control']['getCommand']>>> {
    const startedAt = Date.now()
    const timeoutMs = timeoutOverrideMs ?? this.options.commandTimeoutMs ?? 30_000
    const terminal = (): NonNullable<ReturnType<HubStorage['control']['getCommand']>> | undefined => {
      const command = this.options.storage.control.getCommand(commandId)
      return command !== undefined && ['ok', 'error', 'outcome-unknown'].includes(command.status)
        ? command
        : undefined
    }
    const immediate = terminal()
    if (immediate !== undefined) return immediate
    return new Promise((resolveWait, rejectWait) => {
      let settled = false
      const finish = (result: NonNullable<ReturnType<HubStorage['control']['getCommand']>>): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        subscription.unsubscribe()
        resolveWait(result)
      }
      const inspect = (): void => {
        const result = terminal()
        if (result !== undefined) finish(result)
      }
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        subscription.unsubscribe()
        rejectWait(this.commandTimeoutProblem(commandId, rpcMethod, startedAt))
      }, timeoutMs)
      const subscription = this.events.subscribe(undefined, (event) => {
        if (event.type !== 'command.result' || typeof event.data !== 'object'
          || event.data === null || Array.isArray(event.data)
          || event.data.commandId !== commandId) return
        inspect()
      })
      // Fence a result committed between the first read and subscription.
      inspect()
    })
  }

  private commandTimeoutProblem(commandId: string, rpcMethod: string | undefined, startedAt: number): HttpProblem {
    const command = this.options.storage.control.getCommand(commandId)
    const elapsedMs = Date.now() - startedAt
    if (command === undefined) return new HttpProblem(504, `node request timed out after ${String(elapsedMs)} ms`)
    this.options.storage.control.appendAudit({
      occurredAt: Date.now(),
      actor: 'hub:timeout-monitor',
      action: 'command.wait-timeout',
      nodeId: command.nodeId,
      ...(command.runtimeId === undefined ? {} : { runtimeId: command.runtimeId }),
      resourceId: command.commandId,
      outcome: 'timeout',
      details: {
        capability: command.capability,
        operation: command.operation,
        commandStatus: command.status,
        elapsedMs,
        ...(rpcMethod === undefined ? {} : { rpcMethod }),
      },
    })
    this.options.reportError?.(new Error(
      `node command timed out: ${command.nodeId}/${command.runtimeId ?? '-'} ${rpcMethod ?? `${command.capability}.${command.operation}`} after ${String(elapsedMs)} ms`,
    ))
    return new HttpProblem(
      504,
      `node request timed out after ${String(elapsedMs)} ms (${command.nodeId}/${command.runtimeId ?? '-'} ${rpcMethod ?? `${command.capability}.${command.operation}`})`,
    )
  }

  private redactCommand(command: NonNullable<ReturnType<HubStorage['control']['getCommand']>>): void {
    if (command.terminalAt !== undefined && (command.payload !== null || command.result !== undefined)) {
      this.options.storage.control.redactTerminalCommandContent(command.commandId)
    }
  }

  private sendWebSocket(socket: WebSocket, value: unknown): Promise<void> {
    return new Promise((resolveSend, reject) => {
      socket.send(JSON.stringify(value), (error) => {
        if (error == null) resolveSend()
        else reject(error)
      })
    })
  }

  private startBrowserWebSocketHeartbeat(socket: WebSocket): () => void {
    let awaitingPong = false
    let stopped = false
    const onPong = () => { awaitingPong = false }
    socket.on('pong', onPong)
    const heartbeat = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return
      if (awaitingPong) {
        socket.terminate()
        return
      }
      awaitingPong = true
      socket.ping()
    }, this.browserWebSocketHeartbeatMs)
    heartbeat.unref()
    const stop = () => {
      if (stopped) return
      stopped = true
      clearInterval(heartbeat)
      socket.off('pong', onPong)
      socket.off('close', stop)
    }
    socket.once('close', stop)
    return stop
  }

  private requireSameOrigin(request: IncomingMessage): void {
    if (request.headers.origin !== this.publicOrigin) throw new HttpProblem(403, 'same-origin mutation required')
    const fetchSite = request.headers['sec-fetch-site']
    if (fetchSite !== undefined && fetchSite !== 'same-origin') throw new HttpProblem(403, 'cross-site mutation rejected')
  }

  private openEvents(request: IncomingMessage, response: ServerResponse, human: HubHumanPrincipal): void {
    securityHeaders(response)
    response.statusCode = 200
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    response.setHeader('Connection', 'keep-alive')
    response.setHeader('X-Accel-Buffering', 'no')
    response.flushHeaders()
    const lastEventHeader = request.headers['last-event-id']
    const lastEventId = Array.isArray(lastEventHeader) ? lastEventHeader[0] : lastEventHeader
    const subscription = this.events.subscribe(lastEventId, (event) => { sse(response, event) })
    sse(response, {
      id: subscription.cursor,
      type: 'hub.baseline',
      occurredAt: Date.now(),
      data: { cursor: subscription.cursor },
    })
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000)
    const expiry = setTimeout(
      () => response.end(),
      Math.min(2_147_483_647, Math.max(1_000, human.expiresAt * 1_000 - Date.now())),
    )
    heartbeat.unref()
    expiry.unref()
    request.once('close', () => {
      clearInterval(heartbeat)
      clearTimeout(expiry)
      subscription.unsubscribe()
    })
  }

  private async serveStatic(pathname: string, headOnly: boolean, response: ServerResponse): Promise<boolean> {
    if (this.staticDirectory === undefined) return false
    const requested = pathname === '/' ? '/index.html' : pathname
    let candidate = resolve(this.staticDirectory, `.${requested}`)
    if (candidate !== this.staticDirectory && !candidate.startsWith(`${this.staticDirectory}${sep}`)) {
      throw new HttpProblem(404, 'not found')
    }
    let metadata = await stat(candidate).catch(() => undefined)
    if (metadata === undefined || !metadata.isFile()) {
      candidate = resolve(this.staticDirectory, 'index.html')
      metadata = await stat(candidate).catch(() => undefined)
    }
    if (metadata === undefined || !metadata.isFile()) return false
    securityHeaders(response)
    response.statusCode = 200
    response.setHeader('Content-Type', MIME_TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream')
    response.setHeader('Content-Length', metadata.size)
    if (headOnly) response.end()
    else response.end(await readFile(candidate))
    return true
  }

  private officialRuntimes(includeOffline = false): FleetWebTarget[] {
    const displayNames = new Map(
      this.options.storage.control.listNodes().map(node => [String(node.nodeId), node.displayName]),
    )
    return this.options.storage.control.listRuntimes().filter((runtime) => {
      if ((!includeOffline && (!runtime.online || !this.agents.isOnline(runtime.nodeId)))
        || !Array.isArray(runtime.capabilities)) return false
      return runtime.capabilities.some((capability) => {
        if (typeof capability !== 'object' || capability === null
          || !('name' in capability) || capability.name !== 'dsh.web'
          || !('version' in capability) || capability.version !== '1.0.0'
          || !('operations' in capability) || !Array.isArray(capability.operations)) return false
        return capability.operations.some(operation => typeof operation === 'object' && operation !== null
          && 'name' in operation && operation.name === 'fetch')
      })
    }).map(runtime => ({
      nodeId: String(runtime.nodeId),
      runtimeId: String(runtime.runtimeId),
      displayName: displayNames.get(String(runtime.nodeId)) ?? String(runtime.nodeId),
    }))
  }

  private workspaceTargetKey(target: Pick<FleetWebTarget, 'nodeId' | 'runtimeId'>): string {
    return `${target.nodeId}\u0000${target.runtimeId}`
  }

  private workspaceSnapshot(target: FleetWebTarget): FleetWorkspaceSnapshot {
    const key = this.workspaceTargetKey(target)
    const current = this.workspaceSnapshots.get(key)
    if (current !== undefined) return current
    const created = { workspaceIds: [], archivedSessionIds: [] }
    this.workspaceSnapshots.set(key, created)
    return created
  }

  private stringArray(value: unknown): string[] | undefined {
    return Array.isArray(value) && value.every(item => typeof item === 'string')
      ? value
      : undefined
  }

  private updateWorkspaceListSnapshot(target: FleetWebTarget, value: unknown): void {
    if (typeof value !== 'object' || value === null) return
    const record = value as { items?: unknown; archivedSessionIds?: unknown }
    if (!Array.isArray(record.items)) return
    const workspaceIds = record.items.flatMap(item =>
      typeof item === 'object' && item !== null && typeof (item as { workspaceId?: unknown }).workspaceId === 'string'
        ? [(item as { workspaceId: string }).workspaceId]
        : [])
    const archivedSessionIds = this.stringArray(record.archivedSessionIds)
    if (archivedSessionIds === undefined) return
    this.workspaceSnapshots.set(this.workspaceTargetKey(target), { workspaceIds, archivedSessionIds })
  }

  private updateWorkspaceRpcSnapshot(value: unknown, target: FleetWebTarget, method?: string): void {
    if (method !== 'workspace.insertBefore' && method !== 'workspace.archiveSession') return
    const envelope = value as { result?: { ok?: unknown; value?: unknown } }
    if (envelope.result?.ok !== true || typeof envelope.result.value !== 'object'
      || envelope.result.value === null) return
    const snapshot = this.workspaceSnapshot(target)
    const result = envelope.result.value as { workspaceIds?: unknown; archivedSessionIds?: unknown }
    if (method === 'workspace.insertBefore') {
      const workspaceIds = this.stringArray(result.workspaceIds)
      if (workspaceIds !== undefined) snapshot.workspaceIds = workspaceIds
    } else {
      const archivedSessionIds = this.stringArray(result.archivedSessionIds)
      if (archivedSessionIds !== undefined) snapshot.archivedSessionIds = archivedSessionIds
    }
  }

  private fleetWorkspaceIds(): string[] {
    return this.officialRuntimes().flatMap(target =>
      (this.workspaceSnapshots.get(this.workspaceTargetKey(target))?.workspaceIds ?? [])
        .map(sourceId => encodeFleetPayload({ workspaceId: sourceId }, target) as { workspaceId: string })
        .map(record => record.workspaceId))
  }

  private fleetArchivedSessionIds(): string[] {
    return this.officialRuntimes().flatMap(target =>
      (this.workspaceSnapshots.get(this.workspaceTargetKey(target))?.archivedSessionIds ?? [])
        .map(sourceId => encodeFleetPayload({ sessionId: sourceId }, target) as { sessionId: string })
        .map(record => record.sessionId))
  }

  private installFleetWorkspaceSnapshot(value: unknown, method?: string): void {
    if (method !== 'workspace.insertBefore' && method !== 'workspace.archiveSession') return
    const envelope = value as { result?: { ok?: unknown; value?: unknown } }
    if (envelope.result?.ok !== true || typeof envelope.result.value !== 'object'
      || envelope.result.value === null) return
    const result = envelope.result.value as { workspaceIds?: unknown; archivedSessionIds?: unknown }
    if (method === 'workspace.insertBefore') result.workspaceIds = this.fleetWorkspaceIds()
    else result.archivedSessionIds = this.fleetArchivedSessionIds()
  }

  private updateWorkspaceHostSnapshot(value: unknown, target: FleetWebTarget): void {
    if (typeof value !== 'object' || value === null) return
    const envelope = value as { payload?: unknown }
    if (typeof envelope.payload !== 'object' || envelope.payload === null) return
    const payload = envelope.payload as {
      type?: unknown
      workspaceIds?: unknown
      archivedSessionIds?: unknown
      workspaceId?: unknown
      workspace?: { workspaceId?: unknown }
    }
    const snapshot = this.workspaceSnapshot(target)
    if (payload.type === 'host/workspace-order-changed') {
      const ids = this.stringArray(payload.workspaceIds)
      if (ids !== undefined) snapshot.workspaceIds = ids
    } else if (payload.type === 'host/archived-sessions-changed') {
      const ids = this.stringArray(payload.archivedSessionIds)
      if (ids !== undefined) snapshot.archivedSessionIds = ids
    } else if (payload.type === 'host/workspace-changed'
      && typeof payload.workspace?.workspaceId === 'string'
      && !snapshot.workspaceIds.includes(payload.workspace.workspaceId)) {
      snapshot.workspaceIds = [payload.workspace.workspaceId, ...snapshot.workspaceIds]
    } else if (payload.type === 'host/workspace-removed' && typeof payload.workspaceId === 'string') {
      snapshot.workspaceIds = snapshot.workspaceIds.filter(id => id !== payload.workspaceId)
    }
  }

  private installFleetWorkspaceHostSnapshot(value: unknown): void {
    if (typeof value !== 'object' || value === null) return
    const envelope = value as { payload?: unknown }
    if (typeof envelope.payload !== 'object' || envelope.payload === null) return
    const payload = envelope.payload as {
      type?: unknown
      workspaceIds?: unknown
      archivedSessionIds?: unknown
    }
    if (payload.type === 'host/workspace-order-changed') payload.workspaceIds = this.fleetWorkspaceIds()
    else if (payload.type === 'host/archived-sessions-changed') {
      payload.archivedSessionIds = this.fleetArchivedSessionIds()
    }
  }

  private firstOfficialRuntime(): FleetWebTarget | undefined {
    return this.officialRuntimes()[0]
  }

  private resolveOfficialTarget(target: Pick<FleetWebTarget, 'nodeId' | 'runtimeId'>): FleetWebTarget | undefined {
    return this.officialRuntimes().find(candidate =>
      candidate.nodeId === target.nodeId && candidate.runtimeId === target.runtimeId)
  }

  private requireOfficialTarget(target: FleetWebTarget | undefined): FleetWebTarget {
    if (target === undefined) throw new HttpProblem(503, 'no DSH Web Runtime is online')
    const resolved = this.resolveOfficialTarget(target)
    if (resolved === undefined) throw new HttpProblem(409, 'target Runtime does not provide DSH Web access')
    return resolved
  }

  private rememberInteractionTarget(rpcId: string, target: FleetWebTarget): void {
    this.interactionTargets.set(rpcId, {
      target,
      expiresAt: Date.now() + INTERACTION_TARGET_LIFETIME_MS,
    })
    if (this.interactionTargets.size <= 10_000) return
    const oldest = this.interactionTargets.keys().next().value
    if (oldest !== undefined) this.interactionTargets.delete(oldest)
  }

  private interactionTarget(rpcId: string): FleetWebTarget | undefined {
    const record = this.interactionTargets.get(rpcId)
    if (record === undefined) return undefined
    this.interactionTargets.delete(rpcId)
    return record.expiresAt > Date.now() ? record.target : undefined
  }

  private redirect(response: ServerResponse, location: string): void {
    securityHeaders(response)
    response.statusCode = 302
    response.setHeader('Location', location)
    response.end()
  }

  private handleError(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.destroy()
      return
    }
    if (error instanceof HttpProblem) json(response, error.status, { error: error.message })
    else if (error instanceof HubAuthError) json(response, error.code === 'forbidden' ? 403 : 401, { error: 'authentication failed' })
    else if (error instanceof z.ZodError) json(response, 400, { error: 'request validation failed', issues: error.issues })
    else {
      this.options.reportError?.(error)
      json(response, 500, { error: 'internal server error' })
    }
  }
}
