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
  /** Authenticated outbound-node registry used by REST and terminal routing. */
  public readonly agents: HubAgentRegistry
  private readonly publicOrigin: string
  private readonly staticDirectory: string | undefined
  private readonly maintenance: NodeJS.Timeout

  public constructor(private readonly options: HubServerOptions) {
    this.publicOrigin = normalizePublicOrigin(options.publicOrigin)
    this.staticDirectory = options.staticDirectory === undefined ? undefined : resolve(options.staticDirectory)
    this.agents = new HubAgentRegistry(options.storage, this.events, options.hubIdentity)
    this.maintenance = setInterval(() => {
      options.storage.control.redactTerminalCommandContentBefore(Date.now() - 5 * 60_000)
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
      const hasTarget = url.searchParams.has('nodeId') && url.searchParams.has('runtimeId')
      if (url.pathname === '/' && !hasTarget) {
        this.redirect(response, target === undefined ? '/setup.html' : this.officialRuntimeUrl(target))
        return
      }
      if (url.pathname === '/setup.html' && target !== undefined) {
        this.redirect(response, this.officialRuntimeUrl(target))
        return
      }
    }
    if (method === 'GET' && url.pathname === '/hub/v1/nodes') {
      json(response, 200, {
        nodes: this.options.storage.control.listNodes().map(node => ({
          ...node,
          online: this.agents.isOnline(node.nodeId),
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
      const nodeId = HubNodeId(url.searchParams.get('nodeId') ?? '')
      const runtimeId = HubRuntimeId(url.searchParams.get('runtimeId') ?? '')
      const stream = url.pathname.endsWith('.mux') ? 'mux' : 'host'
      this.officialWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
        void this.openOfficialStream(webSocket, human, nodeId, runtimeId, stream).catch((error: unknown) => {
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
    const nodeId = HubNodeId(url.searchParams.get('nodeId') ?? '')
    const runtimeId = HubRuntimeId(url.searchParams.get('runtimeId') ?? '')
    if (!this.agents.isOnline(nodeId)) throw new HttpProblem(503, 'node is offline')
    const forwarded = new URL(url)
    forwarded.searchParams.delete('nodeId')
    forwarded.searchParams.delete('runtimeId')
    let body: string | undefined
    if (method === 'POST') {
      const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') throw new HttpProblem(415, 'application/json is required')
      body = await textBody(request, 160 * 1024 * 1024)
    }
    const command = await this.agents.invoke(
      nodeId,
      runtimeId,
      'dsh.web',
      '1.0.0',
      'fetch',
      {
        clientMutationId: crypto.randomUUID(),
        method,
        path: `${forwarded.pathname}${forwarded.search}`,
        headers: method === 'POST' ? [['content-type', 'application/json']] : [],
        ...(body === undefined ? {} : { body }),
      },
      `human:${human.email}`,
    )
    const completed = await this.waitCommand(command.commandId)
    this.redactCommand(completed)
    if (completed.status !== 'ok' || typeof completed.result !== 'object' || completed.result === null) {
      throw new HttpProblem(502, 'node Web request failed')
    }
    const result = completed.result as {
      status?: unknown
      headers?: unknown
      encoding?: unknown
      body?: unknown
    }
    if (typeof result.status !== 'number'
      || !Array.isArray(result.headers)
      || (result.encoding !== 'utf8' && result.encoding !== 'base64')
      || typeof result.body !== 'string') {
      throw new Error('node Web response is invalid')
    }
    const bytes = result.encoding === 'base64' ? Buffer.from(result.body, 'base64') : Buffer.from(result.body, 'utf8')
    securityHeaders(response)
    response.statusCode = result.status
    for (const header of result.headers) {
      if (!Array.isArray(header) || header.length !== 2
        || typeof header[0] !== 'string' || typeof header[1] !== 'string') continue
      const name = header[0].toLowerCase()
      if (name === 'connection' || name === 'content-length' || name === 'transfer-encoding'
        || name === 'set-cookie') continue
      response.setHeader(header[0], header[1])
    }
    response.setHeader('Content-Length', bytes.byteLength)
    if (method === 'HEAD') response.end()
    else response.end(bytes)
  }

  private async openOfficialStream(
    socket: WebSocket,
    human: HubHumanPrincipal,
    nodeId: ReturnType<typeof HubNodeId>,
    runtimeId: ReturnType<typeof HubRuntimeId>,
    stream: 'mux' | 'host',
  ): Promise<void> {
    if (!this.agents.isOnline(nodeId)) throw new Error('node is offline')
    const subscription = this.events.subscribe(undefined, (event) => {
      if (event.type !== 'stream.frame' || typeof event.data !== 'object' || event.data === null) return
      const data = event.data as {
        nodeId?: unknown
        runtimeId?: unknown
        capability?: unknown
        stream?: unknown
        payload?: unknown
      }
      if (data.nodeId !== nodeId || data.runtimeId !== runtimeId
        || data.capability !== 'dsh.web' || data.stream !== stream) return
      void this.sendWebSocket(socket, data.payload).catch(() => { socket.close() })
    })
    const expiry = setTimeout(() => { socket.close(4003, 'operator authentication expired') }, Math.min(
      2_147_483_647, Math.max(1_000, human.expiresAt * 1_000 - Date.now()),
    ))
    expiry.unref()
    await new Promise<void>(resolveClose => socket.once('close', resolveClose))
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

  private async waitCommand(commandId: string): Promise<NonNullable<ReturnType<HubStorage['control']['getCommand']>>> {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const command = this.options.storage.control.getCommand(commandId)
      if (command !== undefined && ['ok', 'error', 'outcome-unknown'].includes(command.status)) return command
      await new Promise(resolveWait => setTimeout(resolveWait, 25))
    }
    throw new Error('node command timed out')
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

  private firstOfficialRuntime(): { nodeId: string; runtimeId: string } | undefined {
    return this.options.storage.control.listRuntimes().find((runtime) => {
      if (!runtime.online || !this.agents.isOnline(runtime.nodeId) || !Array.isArray(runtime.capabilities)) return false
      return runtime.capabilities.some(capability => typeof capability === 'object' && capability !== null
        && 'name' in capability && capability.name === 'dsh.web')
    })
  }

  private officialRuntimeUrl(target: { nodeId: string; runtimeId: string }): string {
    const url = new URL('/', this.publicOrigin)
    url.searchParams.set('nodeId', target.nodeId)
    url.searchParams.set('runtimeId', target.runtimeId)
    return `${url.pathname}${url.search}`
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
