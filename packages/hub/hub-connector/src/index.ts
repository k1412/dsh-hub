/** In-process Connector that exposes one existing DSH runtime to a local Node Agent. */

import { createHash, randomBytes } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway/types'
import {
  runtimeCapability, sessionsCapability, settingsCapability, webCapability,
  resolveHubOperation,
} from '@k1412/dsh-hub-capabilities'
import {
  createHubIpcProof, encodeHubIpcFrame, HubIpcFrameDecoder,
  type HubIpcFrame,
} from '@k1412/dsh-hub-node-ipc'
import { HubMessageId, type HubEnvelopeBody, type HubJson } from '@k1412/dsh-hub-protocol'
import {
  RpcId, toFetchHandler,
  type ApiProxy, type RpcResponse, type SessionSummary,
} from '@deepseek-ai/dsh-host-apiproxy'
import { clientRequestSchema, serverResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api'
import { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-api-gateway/types' {
  interface TypertGateway {
    /** Compatibility dispatch exposed by the reviewed DSH Web/Host contract. */
    dispatch(endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown>
  }
}

/** Connector release sent in the authenticated local baseline. */
export const HUB_CONNECTOR_VERSION = '1.0.1'

/** Connector configuration stored in the DSH profile. */
export interface Config {
  /** Owner-only Unix socket path or Windows named-pipe name exposed by Node Agent. */
  ipcEndpoint?: string
  /** Owner-only file containing the local Connector IPC secret. */
  secretFile?: string
  /** Stable identifier for this independently running DSH runtime. */
  runtimeId?: string
  /** DSH version advertised during capability negotiation. */
  dshVersion?: string
  /** Maximum reconnect backoff after local Node Agent interruption. */
  reconnectMaximumMs?: number
}

interface ResolvedConfig {
  ipcEndpoint: string
  secretFile: string
  runtimeId: string
  dshVersion: string
  reconnectMaximumMs: number
}

const defaultStateDirectory = process.env.DSH_HUB_STATE_DIRECTORY?.trim() || join(homedir(), '.dsh-hub')
const defaultIpcEndpoint = process.platform === 'win32'
  ? String.raw`\\.\pipe\dsh-hub-node`
  : join(defaultStateDirectory, 'connector.sock')

/**
 * Detect the DSH CLI package that launched this existing runtime.
 * @param entrypoint - process entrypoint or an explicit executable for inspection.
 * @returns detected DSH package version, or undefined when the launcher hides it.
 */
export async function detectDshVersion(entrypoint: string | undefined = process.argv[1]): Promise<string | undefined> {
  if (entrypoint === undefined || entrypoint === '') return undefined
  let directory: string
  try {
    directory = dirname(await realpath(entrypoint))
  } catch {
    return undefined
  }
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
        name?: unknown
        version?: unknown
      }
      if (manifest.name === '@deepseek-ai/dsh'
        && typeof manifest.version === 'string'
        && manifest.version.length > 0
        && manifest.version.length <= 128) return manifest.version
    } catch {
      // The launcher normally lives below the package root; keep walking upward.
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/** Cordis configuration schema for the Hub Connector plugin. */
export const Config: z<Config> = z.object({
  ipcEndpoint: z.string().default(defaultIpcEndpoint),
  secretFile: z.string().default(join(defaultStateDirectory, 'connector.secret')),
  runtimeId: z.string().pattern(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/)
    .default(process.env.DSH_HUB_RUNTIME_ID?.trim() || 'default'),
  dshVersion: z.string().default(process.env.DSH_HUB_DSH_VERSION?.trim() || ''),
  reconnectMaximumMs: z.number().step(1).min(1_000).max(120_000).default(30_000),
})

export const inject = ['apiProxy', 'typertGateway']

interface ActiveIpc {
  socket: Socket
  writes: Promise<void>
  streams: AbortController
  heartbeat: NodeJS.Timeout
  indexTimer: NodeJS.Timeout | undefined
  invocations: InvocationScheduler
}

interface SessionView {
  sessionId: string
  title?: string
  workspacePath?: string
  updatedAt: number
  running: boolean
  eventSequence: number
}

/**
 * Bounded, two-lane execution for commands delivered over the ordered IPC
 * carrier. Bulk history/index reads may be large or slow, so they cannot own
 * every local execution slot while a human response or Goal mutation waits.
 */
class InvocationScheduler {
  private readonly interactive: Array<() => Promise<void>> = []
  private readonly bulk: Array<() => Promise<void>> = []
  private interactiveRunning = 0
  private bulkRunning = 0

  public constructor(private readonly failed: (error: unknown) => void) {}

  schedule(priority: 'interactive' | 'bulk', task: () => Promise<void>): void {
    ;(priority === 'interactive' ? this.interactive : this.bulk).push(task)
    this.pump(priority)
  }

  private pump(priority: 'interactive' | 'bulk'): void {
    const queue = priority === 'interactive' ? this.interactive : this.bulk
    const limit = priority === 'interactive' ? 2 : 4
    const running = priority === 'interactive' ? this.interactiveRunning : this.bulkRunning
    for (let count = running; count < limit && queue.length > 0; count += 1) {
      const task = queue.shift()
      if (task === undefined) return
      if (priority === 'interactive') this.interactiveRunning += 1
      else this.bulkRunning += 1
      void task().catch(this.failed).finally(() => {
        if (priority === 'interactive') this.interactiveRunning -= 1
        else this.bulkRunning -= 1
        this.pump(priority)
      })
    }
  }
}

const BULK_WEB_ENDPOINTS = new Set([
  'session.list', 'session.search', 'session.history', 'session.models',
  'subagent.list', 'subagent.history', 'host.listDirectory', 'workspace.list',
  'skill.list', 'agentPreset.list', 'agentPreset.read',
  'llm.providers', 'llm.models', 'llm.discoverModels',
])

/** Human-in-the-loop and mutation commands use capacity reserved from bulk reads. */
function invocationPriority(body: Extract<HubEnvelopeBody, { type: 'capability.invoke' }>): 'interactive' | 'bulk' {
  if (body.capability === 'dsh.sessions') {
    return body.operation === 'list' || body.operation === 'read' ? 'bulk' : 'interactive'
  }
  if (body.capability === 'dsh.settings') return 'interactive'
  if (body.capability !== 'dsh.web' || body.operation !== 'fetch'
    || typeof body.payload !== 'object' || body.payload === null || Array.isArray(body.payload)) return 'bulk'
  const path = (body.payload as Record<string, unknown>).path
  const method = (body.payload as Record<string, unknown>).method
  if (typeof path !== 'string' || method !== 'POST') return 'bulk'
  let pathname: string
  try {
    pathname = new URL(path, 'http://dsh.internal').pathname
  } catch {
    return 'bulk'
  }
  if (pathname === '/api/respond') return 'interactive'
  const endpoint = pathname.slice('/api/'.length)
  if (endpoint.startsWith('goals/')
    || endpoint.startsWith('settings/')
    || endpoint.startsWith('credentials/')) return 'interactive'
  if (endpoint.includes('/')) return 'bulk'
  return BULK_WEB_ENDPOINTS.has(endpoint) ? 'bulk' : 'interactive'
}

function rpcId(value?: string): ReturnType<typeof RpcId> {
  return RpcId(value ?? randomBytes(18).toString('base64url'))
}

function unwrap<T>(response: RpcResponse<T>): T {
  if (response.result.ok) return response.result.value
  const error = new Error(response.result.error.message)
  error.name = response.result.error.code
  throw error
}

function remoteFailure(error: unknown): {
  ok: false
  error: { code: string; message: string; details: Record<string, never> }
} {
  const candidateMessage = error instanceof Error ? error.message : 'Remote endpoint failed'
  const message = Array.from(candidateMessage, (character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127 ? ' ' : character
  }).join('').slice(0, 8_192)
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

function titleOf(summary: SessionSummary): string | undefined {
  const values = summary.projections?.values as Record<string, unknown> | undefined
  if (values === undefined) return undefined
  for (const key of ['sessionTitle', 'title']) {
    const candidate = values[key]
    if (typeof candidate === 'string' && candidate !== '') return candidate
    if (typeof candidate === 'object' && candidate !== null && 'title' in candidate
      && typeof (candidate as { title?: unknown }).title === 'string') {
      return (candidate as { title: string }).title
    }
  }
  return undefined
}

function sessionView(summary: SessionSummary): SessionView {
  const sequence = summary.projections?.asOfSeq ?? 0
  const title = titleOf(summary)
  return {
    sessionId: summary.sessionId,
    ...(title === undefined ? {} : { title }),
    ...(summary.cwd === undefined ? {} : { workspacePath: summary.cwd }),
    updatedAt: summary.updatedAt,
    running: summary.running,
    eventSequence: Math.max(0, sequence),
  }
}

function jsonHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('base64url')
}

function eventSequence(value: unknown): number {
  if (typeof value !== 'object' || value === null || !('seq' in value)) return 0
  const sequence = (value as { seq?: unknown }).seq
  return typeof sequence === 'number' && Number.isInteger(sequence) && sequence >= 0 ? sequence : 0
}

function eventRpcId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('data' in value)) return undefined
  const data = (value as { data?: unknown }).data
  if (typeof data !== 'object' || data === null || !('source' in data)) return undefined
  const source = (data as { source?: unknown }).source
  if (typeof source !== 'object' || source === null || !('rpcId' in source)) return undefined
  return typeof (source as { rpcId?: unknown }).rpcId === 'string'
    ? (source as { rpcId: string }).rpcId
    : undefined
}

async function privateSecret(path: string): Promise<string> {
  const metadata = await stat(path)
  if (!metadata.isFile()) throw new Error('Hub Connector secret must be a regular file')
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error('Hub Connector secret file must be owner-only')
  }
  const value = (await readFile(path, 'utf8')).trim()
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('Hub Connector secret is invalid')
  return value
}

function waitForConnect(socket: Socket, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const connected = () => { cleanup(); resolve() }
    const failed = (error: Error) => { cleanup(); reject(error) }
    const aborted = () => {
      cleanup()
      socket.destroy()
      reject(signal.reason instanceof Error ? signal.reason : new Error('Connector IPC wait aborted'))
    }
    const cleanup = () => {
      socket.off('connect', connected)
      socket.off('error', failed)
      signal.removeEventListener('abort', aborted)
    }
    socket.once('connect', connected)
    socket.once('error', failed)
    signal.addEventListener('abort', aborted, { once: true })
  })
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Connector reconnect delay aborted'))
      return
    }
    const timeout = setTimeout(() => { cleanup(); resolve() }, milliseconds)
    const aborted = () => {
      cleanup()
      reject(signal.reason instanceof Error ? signal.reason : new Error('Connector reconnect delay aborted'))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', aborted)
    }
    signal.addEventListener('abort', aborted, { once: true })
  })
}

/** Local Connector client. It never opens a network listener or imports the Web plugin. */
export class HubConnector {
  private readonly runtimeBootId = HubMessageId(randomBytes(18).toString('base64url'))
  private active: ActiveIpc | undefined
  private indexRevision = 0
  private webMuxFrameSequence = 0
  private webHostFrameSequence = 0
  private detectedDshVersion: string | undefined

  public constructor(
    private readonly api: ApiProxy,
    private readonly gateway: TypertGateway,
    private readonly config: ResolvedConfig,
  ) {}

  /**
   * Maintain the authenticated local IPC connection until aborted.
   * @param signal - service-lifetime cancellation signal.
   */
  public async run(signal: AbortSignal): Promise<void> {
    const secret = await privateSecret(this.config.secretFile)
    let attempt = 0
    for (;;) {
      if (signal.aborted) return
      try {
        await this.connectOnce(secret, signal)
        attempt = 0
      } catch {
        attempt += 1
        const maximum = this.config.reconnectMaximumMs
        const ceiling = Math.min(maximum, 500 * 2 ** Math.min(attempt, 7))
        await delay(Math.floor(ceiling / 2 + Math.random() * ceiling / 2), signal)
      }
    }
  }

  private async connectOnce(secret: string, signal: AbortSignal): Promise<void> {
    const socket = connect(this.config.ipcEndpoint)
    socket.setNoDelay(true)
    await waitForConnect(socket, signal)
    const decoder = new HubIpcFrameDecoder()
    let chain = Promise.resolve()
    let streamTask: Promise<void> | undefined
    let authenticated = false
    const closed = new Promise<void>((resolve, reject) => {
      socket.once('close', resolve)
      socket.once('error', reject)
    })
    const streams = new AbortController()
    const heartbeat = setInterval(() => {
      if (authenticated) {
        // The IPC peer can close between the timer's readiness check and the
        // queued socket write. Heartbeats are best effort; turn that race into
        // an ordinary reconnect instead of an unhandled rejection that can
        // terminate the parent DSH runtime.
        void this.send({ type: 'ipc.heartbeat', timestamp: Date.now() })
          .catch(() => { socket.destroy() })
      }
    }, 30_000)
    heartbeat.unref()
    const invocations = new InvocationScheduler((error) => {
      socket.destroy(error instanceof Error ? error : new Error(String(error)))
    })
    const active: ActiveIpc = {
      socket, writes: Promise.resolve(), streams, heartbeat, indexTimer: undefined, invocations,
    }
    this.active = active
    socket.on('data', (chunk) => {
      chain = chain.then(async () => {
        for (const frame of decoder.push(chunk)) {
          if (!authenticated) {
            if (frame.type !== 'ipc.challenge') throw new Error('Node Agent did not begin IPC authentication')
            const dshVersion = await this.resolveDshVersion()
            await this.send({
              type: 'ipc.proof',
              challenge: frame.challenge,
              runtimeId: this.config.runtimeId,
              runtimeBootId: this.runtimeBootId,
              connectorVersion: HUB_CONNECTOR_VERSION,
              dshVersion,
              capabilities: [
                sessionsCapability.descriptor,
                runtimeCapability.descriptor,
                settingsCapability.descriptor,
                webCapability.descriptor,
              ],
              proof: createHubIpcProof(
                secret, frame.challenge, this.config.runtimeId, this.runtimeBootId, HUB_CONNECTOR_VERSION,
              ),
            })
            authenticated = true
            return
          }
          if (frame.type === 'ipc.accepted') {
            streamTask ??= this.pumpStreams(streams.signal).catch((error: unknown) => {
              if (!streams.signal.aborted) {
                socket.destroy(error instanceof Error ? error : new Error(String(error)))
              }
            })
            await this.publishIndex()
          } else if (frame.type === 'ipc.hub-body') {
            if (frame.body.type === 'capability.invoke') {
              invocations.schedule(invocationPriority(frame.body), async () => {
                await this.handleBody(active, frame.body)
              })
            } else {
              await this.handleBody(active, frame.body)
            }
          } else if (frame.type !== 'ipc.heartbeat') {
            throw new Error(`unexpected Node Agent frame ${frame.type}`)
          }
        }
      }).catch(() => { socket.destroy() })
    })
    const abort = () => socket.destroy()
    signal.addEventListener('abort', abort, { once: true })
    try {
      await closed
      await chain
    } finally {
      signal.removeEventListener('abort', abort)
      clearInterval(heartbeat)
      if (this.active.socket === socket && this.active.indexTimer !== undefined) {
        clearTimeout(this.active.indexTimer)
      }
      streams.abort(new Error('Connector IPC disconnected'))
      // The event iterators use services owned by this Cordis Context. Let
      // them observe cancellation and finish before plugin disposal makes
      // those services inactive.
      await streamTask
      if (this.active.socket === socket) this.active = undefined
      socket.destroy()
    }
  }

  private async send(frame: HubIpcFrame, expectedActive: ActiveIpc | undefined = this.active): Promise<void> {
    const active = expectedActive
    if (active === undefined || active.socket.destroyed) throw new Error('Connector IPC is offline')
    const operation = active.writes.then(() => new Promise<void>((resolve, reject) => {
      if (this.active !== active || active.socket.destroyed) {
        reject(new Error('Connector IPC is offline'))
        return
      }
      active.socket.write(encodeHubIpcFrame(frame), (error) => {
        if (error == null) resolve()
        else reject(error)
      })
    }))
    active.writes = operation.catch(() => undefined)
    return operation
  }

  private async handleBody(active: ActiveIpc, body: HubEnvelopeBody): Promise<void> {
    if (body.type === 'runtime.resync-required') {
      if (body.runtimeId !== undefined && body.runtimeId !== this.config.runtimeId) {
        throw new Error('Connector received resynchronization for another runtime')
      }
      // All ApiProxy streams are reconstructible, but their pending question
      // and approval baselines are emitted only when a fresh iterator opens.
      // Reconnect the local carrier so connectOnce cancels both old iterators
      // and pumpStreams opens a new generation. This does not restart DSH or
      // its live Agents; it only re-establishes the owner-only Connector IPC.
      this.active?.socket.destroy()
      return
    }
    if (body.type !== 'capability.invoke' || body.runtimeId !== this.config.runtimeId) {
      throw new Error('Connector received an invalid runtime command')
    }
    try {
      const operation = resolveHubOperation(body.capability, body.capabilityVersion, body.operation)
      if (operation === undefined) throw new Error('unsupported Connector operation')
      const request = operation.request.parse(body.payload)
      const value = operation.response.parse(await this.invoke(body.capability, body.operation, request, body.commandId))
      await this.send({ type: 'ipc.hub-body', body: {
        type: 'capability.result', commandId: body.commandId, status: 'ok', value: value as HubJson,
      } }, active)
    } catch (error) {
      await this.send({ type: 'ipc.hub-body', body: {
        type: 'capability.result',
        commandId: body.commandId,
        status: 'error',
        error: {
          code: error instanceof Error ? error.name : 'connector-error',
          message: error instanceof Error ? error.message : 'Connector operation failed',
          retryable: false,
        },
      } }, active)
    }
  }

  private async invoke(capability: string, operation: string, input: unknown, commandId: string): Promise<unknown> {
    if (capability === 'dsh.sessions') return this.invokeSessions(operation, input, commandId)
    if (capability === 'dsh.runtime') return this.invokeRuntime(operation, input, commandId)
    if (capability === 'dsh.settings') return this.invokeSettings(operation, input, commandId)
    if (capability === 'dsh.web') return this.invokeWeb(operation, input)
    throw new Error('capability is not implemented by the Connector')
  }

  private async invokeWeb(operation: string, value: unknown): Promise<unknown> {
    if (operation !== 'fetch') throw new Error(`unsupported Web operation ${operation}`)
    const input = value as {
      method: 'GET' | 'HEAD' | 'POST'
      path: string
      headers: Array<[string, string]>
      body?: string
    }
    const url = new URL(input.path, 'http://dsh.internal')
    const request = new Request(url, {
      method: input.method,
      headers: input.headers,
      ...(input.body === undefined || input.method === 'GET' || input.method === 'HEAD'
        ? {}
        : { body: input.body }),
    })
    let remoteResponse: Response | undefined
    let parsedBody: ReturnType<typeof clientRequestSchema.safeParse> | undefined
    if (input.method === 'POST' && url.pathname.startsWith('/api/')) {
      const endpoint = url.pathname.slice('/api/'.length)
      let body: unknown
      try {
        body = JSON.parse(input.body ?? '') as unknown
      } catch {
        return { status: 400, headers: [['content-type', 'text/plain; charset=utf-8']], encoding: 'utf8', body: 'body is not JSON' }
      }
      parsedBody = clientRequestSchema.safeParse(body)
      // Generic Typert Remote endpoints contain a namespace/method slash and
      // are claimed ahead of ApiProxy by the ordinary node Connection route.
      // Preserve that order in this in-process carrier: ApiProxy treats an
      // unknown method as its own error response, so waiting for a 404 loses
      // the Remote endpoint before the Gateway can see it.
      if (endpoint.includes('/') && parsedBody.success && parsedBody.data.method === endpoint) {
        const result = await this.gateway.dispatch(
          endpoint, parsedBody.data.payload, new AbortController().signal,
        ).catch(remoteFailure)
        const envelope = serverResponseSchema.parse({
          type: 'server-response',
          rpcId: parsedBody.data.rpcId,
          result,
        })
        remoteResponse = Response.json(envelope)
      }
    }
    let response = remoteResponse ?? await toFetchHandler(this.api).fetch(request)
    if (response.status === 404 && parsedBody?.success === true) {
      const endpoint = url.pathname.slice('/api/'.length)
      if (parsedBody.data.method === endpoint) {
        const result = await this.gateway.dispatch(
          endpoint, parsedBody.data.payload, new AbortController().signal,
        ).catch(remoteFailure)
        response = Response.json(serverResponseSchema.parse({
          type: 'server-response', rpcId: parsedBody.data.rpcId, result,
        }))
      }
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    const textual = contentType.startsWith('text/')
      || contentType.includes('json')
      || contentType.includes('javascript')
      || contentType.includes('xml')
    return {
      status: response.status,
      headers: [...response.headers.entries()],
      encoding: textual ? 'utf8' : 'base64',
      body: textual ? bytes.toString('utf8') : bytes.toString('base64'),
    }
  }

  private async listSessions(): Promise<SessionView[]> {
    const listed = unwrap(await this.api.sessions.list({ rpcId: rpcId(), payload: {} }))
    return listed.items.map(sessionView)
  }

  private async history(sessionId: string, maximum = 2_000): Promise<unknown[]> {
    const history = unwrap(await this.api.sessions.history({
      rpcId: rpcId(), payload: { sessionId: SessionId(sessionId), maxMessages: maximum },
    }))
    return history.events.map(entry => entry.event)
  }

  private async hasMutation(sessionId: string, mutationId: string): Promise<boolean> {
    return (await this.history(sessionId)).some(event => eventRpcId(event) === mutationId)
  }

  private async currentSession(sessionId: string): Promise<SessionView> {
    const item = (await this.listSessions()).find(candidate => candidate.sessionId === sessionId)
    if (item === undefined) throw new Error(`session ${sessionId} is unavailable`)
    const events = await this.history(sessionId)
    return {
      ...item,
      eventSequence: events.reduce<number>((maximum, event) => Math.max(maximum, eventSequence(event)), 0),
    }
  }

  private async invokeSessions(operation: string, value: unknown, commandId: string): Promise<unknown> {
    const input = value as Record<string, unknown>
    if (operation === 'list') {
      const sessions = (await this.listSessions()).slice(0, Number(input.limit))
      return { sessions }
    }
    if (operation === 'read') {
      const sessionId = String(input.sessionId)
      const after = Number(input.afterSequence)
      const maximum = Number(input.limit)
      const events = (await this.history(sessionId)).filter(event => eventSequence(event) > after)
      return {
        session: await this.currentSession(sessionId),
        events: events.slice(0, maximum),
        hasMore: events.length > maximum,
      }
    }
    if (operation === 'create') {
      const mutationId = String(input.clientMutationId)
      const requestedSessionId = SessionId(`hub-${jsonHash(mutationId).slice(0, 32)}`)
      const existing = (await this.listSessions()).find(session => session.sessionId === requestedSessionId)
      const sessionId = existing === undefined
        ? unwrap(await this.api.sessions.create({
          rpcId: rpcId(mutationId),
          payload: {
            sessionId: requestedSessionId,
            ...(typeof input.workspacePath === 'string' ? { cwd: input.workspacePath } : {}),
            ...(typeof input.preset === 'string' ? { agentPreset: input.preset } : {}),
          },
        })).sessionId
        : requestedSessionId
      if (typeof input.model === 'string' && input.model.includes('/')) {
        const [provider, ...modelParts] = input.model.split('/')
        unwrap(await this.api.sessions.selectModel({
          rpcId: rpcId(`${mutationId}-model`),
          payload: { sessionId, provider: provider as string, model: modelParts.join('/') },
        }))
      }
      if (typeof input.title === 'string') {
        unwrap(await this.api.sessions.rename({
          rpcId: rpcId(`${mutationId}-title`), payload: { sessionId, title: input.title },
        }))
      }
      if (typeof input.initialMessage === 'string'
        && !await this.hasMutation(sessionId, `${mutationId}-initial`)) {
        unwrap(await this.api.sessions.prompt({
          rpcId: rpcId(`${mutationId}-initial`),
          payload: { sessionId, mode: 'queue', content: [{ type: 'text', text: input.initialMessage }] },
        }))
      }
      return this.currentSession(sessionId)
    }
    if (operation === 'message.append' || operation === 'message.steer') {
      const sessionId = String(input.sessionId)
      const mutationId = String(input.clientMutationId)
      if (!await this.hasMutation(sessionId, mutationId)) {
        unwrap(await this.api.sessions.prompt({
          rpcId: rpcId(mutationId),
          payload: {
            sessionId: SessionId(sessionId),
            mode: operation === 'message.steer' ? 'steer' : 'queue',
            content: [{ type: 'text', text: String(input.text) }],
          },
        }))
      }
      const session = await this.currentSession(sessionId)
      return operation === 'message.steer'
        ? { ok: true }
        : { accepted: true, eventSequence: session.eventSequence }
    }
    if (operation === 'cancel') {
      unwrap(await this.api.sessions.cancel({
        rpcId: rpcId(commandId), payload: { sessionId: SessionId(String(input.sessionId)) },
      }))
      return { ok: true }
    }
    if (operation === 'interaction.respond') {
      await this.api.respond({
        type: 'client-response',
        rpcId: rpcId(String(input.requestId)),
        result: { ok: true, value: input.response },
      })
      return { ok: true }
    }
    throw new Error(`unsupported sessions operation ${operation}`)
  }

  private async invokeRuntime(operation: string, _value: unknown, commandId: string): Promise<unknown> {
    if (operation === 'health') {
      const host = unwrap(await this.api.host.describe({ rpcId: rpcId(commandId), payload: {} }))
      return {
        status: 'healthy',
        startedAt: Math.max(0, Date.now() - Math.round(process.uptime() * 1_000)),
        dshVersion: await this.resolveDshVersion(),
        connectorVersion: HUB_CONNECTOR_VERSION,
        details: { cwd: host.cwd, attachedSessions: host.attachedSessions },
      }
    }
    throw new Error(`unsupported runtime operation ${operation}`)
  }

  private async resolveDshVersion(): Promise<string> {
    if (this.config.dshVersion !== '') return this.config.dshVersion
    if (this.detectedDshVersion !== undefined) return this.detectedDshVersion
    const packageVersion = await detectDshVersion()
    if (packageVersion !== undefined) {
      this.detectedDshVersion = packageVersion
      return packageVersion
    }
    const host = unwrap(await this.api.host.describe({ rpcId: rpcId(), payload: {} }))
    this.detectedDshVersion = host.version
    return this.detectedDshVersion
  }

  private async settingsView(commandId: string): Promise<{
    revision: string
    schema: HubJson
    values: HubJson
    redactedPaths: string[]
  }> {
    const described = unwrap(await this.api.settings.describe({ rpcId: rpcId(commandId), payload: {} }))
    const schema = Object.fromEntries(described.namespaces.map(namespace => [namespace.ns, namespace.schema])) as HubJson
    const values = Object.fromEntries(described.namespaces.map(namespace => [namespace.ns, namespace.value])) as HubJson
    const redactedPaths = described.namespaces.flatMap(namespace =>
      namespace.secrets.map(secret => [namespace.ns, ...secret.path].join('.')))
    return { revision: jsonHash(described.namespaces), schema, values, redactedPaths }
  }

  private async invokeSettings(operation: string, value: unknown, commandId: string): Promise<unknown> {
    if (operation === 'read') return this.settingsView(commandId)
    if (operation === 'update') {
      const input = value as { expectedRevision: string; patch: unknown }
      const before = await this.settingsView(`${commandId}-before`)
      if (before.revision !== input.expectedRevision) throw new Error('settings revision conflict')
      const patch = input.patch
      if (typeof patch !== 'object' || patch === null) {
        throw new Error('settings patch must contain namespace and object values')
      }
      const fields = patch as Record<string, unknown>
      const namespace = fields.namespace
      const values = fields.values
      const namespaceRevision = fields.namespaceRevision
      if (typeof namespace !== 'string'
        || typeof values !== 'object' || values === null || Array.isArray(values)) {
        throw new Error('settings patch must contain namespace and object values')
      }
      const updated = unwrap(await this.api.settings.update({
        rpcId: rpcId(commandId),
        payload: {
          ns: namespace,
          patch: values,
          ...(typeof namespaceRevision === 'number' ? { expectedRevision: namespaceRevision } : {}),
        },
      }))
      const after = await this.settingsView(`${commandId}-after`)
      await this.send({ type: 'ipc.hub-body', body: {
        type: 'stream.frame', runtimeId: this.config.runtimeId, capability: 'dsh.settings',
        streamId: HubMessageId(jsonHash(`${this.config.runtimeId}:dsh.settings:changed`).slice(0, 24)),
        stream: 'changed', frameSequence: Date.now(),
        payload: { revision: after.revision },
      } })
      return { revision: after.revision, restartRequired: updated.applies === 'restart' }
    }
    throw new Error(`unsupported settings operation ${operation}`)
  }

  private async publishIndex(): Promise<void> {
    const sessions = await this.listSessions()
    this.indexRevision += 1
    await this.send({ type: 'ipc.hub-body', body: {
      type: 'stream.frame', runtimeId: this.config.runtimeId, capability: 'dsh.sessions',
      streamId: HubMessageId(jsonHash(`${this.config.runtimeId}:dsh.sessions:index`).slice(0, 24)),
      stream: 'index', frameSequence: this.indexRevision,
      payload: { revision: this.indexRevision, sessions } as unknown as HubJson,
    } })
  }

  private scheduleIndexRefresh(): void {
    const active = this.active
    if (active === undefined || active.indexTimer !== undefined) return
    active.indexTimer = setTimeout(() => {
      active.indexTimer = undefined
      void this.publishIndex().catch(() => { active.socket.destroy() })
    }, 100)
    active.indexTimer.unref()
  }

  private async pumpStreams(signal: AbortSignal): Promise<void> {
    const mux = this.api.events.mux({ rpcId: rpcId(), payload: {} }, signal)
    const host = this.api.events.host({ rpcId: rpcId(), payload: {} }, signal)
    const consumeMux = async () => {
      for await (const frame of mux) {
        if (signal.aborted) return
        this.webMuxFrameSequence += 1
        await this.send({ type: 'ipc.hub-body', body: {
          type: 'stream.frame',
          runtimeId: this.config.runtimeId,
          streamId: HubMessageId(jsonHash(`${this.config.runtimeId}:dsh.web:mux`).slice(0, 24)),
          capability: 'dsh.web',
          stream: 'mux',
          frameSequence: this.webMuxFrameSequence,
          payload: {
            type: 'server-request',
            rpcId: frame.rpcId,
            method: frame.payload.type,
            payload: frame.payload,
          } as unknown as HubJson,
        } })
        if (frame.payload.type !== 'session/event') continue
        // dsh.web:mux is the official UI's canonical live event lane. Sending
        // the same session event again through dsh.sessions:events doubles the
        // reliable queue and its SQLite/ack work without serving a consumer.
        // Session history remains authoritative through the unary capability.
        this.scheduleIndexRefresh()
      }
    }
    const consumeHost = async () => {
      for await (const frame of host) {
        if (signal.aborted) return
        this.webHostFrameSequence += 1
        await this.send({ type: 'ipc.hub-body', body: {
          type: 'stream.frame',
          runtimeId: this.config.runtimeId,
          streamId: HubMessageId(jsonHash(`${this.config.runtimeId}:dsh.web:host`).slice(0, 24)),
          capability: 'dsh.web',
          stream: 'host',
          frameSequence: this.webHostFrameSequence,
          payload: {
            type: 'server-request',
            rpcId: frame.rpcId,
            method: frame.payload.type,
            payload: frame.payload,
          } as unknown as HubJson,
        } })
        if (frame.payload.type === 'stream/error') continue
        await this.publishIndex()
      }
    }
    await Promise.all([consumeMux(), consumeHost()])
  }
}

/** Mount one Connector into the same Context as ApiProxy and every local client surface. */
export function apply(ctx: Context, config: Config): () => Promise<void> {
  const controller = new AbortController()
  const connector = new HubConnector(ctx.apiProxy, ctx.typertGateway, {
    ipcEndpoint: config.ipcEndpoint ?? defaultIpcEndpoint,
    secretFile: config.secretFile ?? join(defaultStateDirectory, 'connector.secret'),
    runtimeId: config.runtimeId ?? (process.env.DSH_HUB_RUNTIME_ID?.trim() || 'default'),
    dshVersion: config.dshVersion ?? '',
    reconnectMaximumMs: config.reconnectMaximumMs ?? 30_000,
  })
  const task = connector.run(controller.signal).catch((error: unknown) => {
    if (!controller.signal.aborted) ctx.logger.error(`Hub Connector stopped: ${String(error)}`)
  })
  return async () => {
    controller.abort(new Error('Hub Connector disposed'))
    await task
  }
}
