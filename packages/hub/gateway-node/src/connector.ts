import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import WebSocket from 'ws'
import { connectNodeNetwork } from '@k1412/dsh-gateway-network'
import { serveSurface, ControlRPC, type ControlHandler, type GatewaySurface } from '@k1412/dsh-gateway-transport'

export interface NodeConnectionConfig {
  protocol: 1
  nodeId: string
  credential: string
  clientId: string
  name: string
  mode: 'tailscale' | 'tailcat'
  endpoint: string
  stateDir: string
  hubUrl: string
  binDirectory?: string
  tailscaleSocket?: string
}

export interface NodeMetadata { name: string; runtimeId: string; dshVersion: string; protocol: 1 }

/** Config is deliberately separate from profile settings and never sent to the browser. */
export async function readConnectionConfig(path: string): Promise<NodeConnectionConfig> {
  const info = await stat(path)
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('Gateway connection file must be owner-only (chmod 600)')
  const value = JSON.parse(await readFile(path, 'utf8')) as Partial<NodeConnectionConfig>
  if (value.protocol !== 1 || !['tailscale', 'tailcat'].includes(value.mode ?? '')
    || !value.nodeId || !/^[a-zA-Z0-9_-]+$/.test(value.nodeId)
    || !value.credential || !/^[a-zA-Z0-9_-]{32,}$/.test(value.credential)
    || !value.clientId || !value.name || !value.endpoint || !value.stateDir || !isAbsolute(value.stateDir)
    || !value.hubUrl) throw new Error('Invalid gateway connection file')
  if (value.tailscaleSocket !== undefined && !isAbsolute(value.tailscaleSocket)) throw new Error('Tailscale socket path must be absolute')
  const hub = new URL(value.hubUrl)
  if (!['https:', 'http:'].includes(hub.protocol) || hub.username || hub.password) throw new Error('Invalid gateway Hub URL')
  return value as NodeConnectionConfig
}

export interface ConnectorStatus { state: 'connecting' | 'connected' | 'disconnected' | 'login-required' | 'revoked'; message: string }
class GatewayAuthenticationError extends Error {}

const sleep = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, milliseconds)
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Reconnect the paired outbound carrier; each generation disposes all native streams. */
export function startNodeConnector(options: {
  config: NodeConnectionConfig
  metadata: NodeMetadata
  surface: GatewaySurface
  role?: 'supervisor'
  control?: { capabilities: string[]; handle: ControlHandler; connected(rpc: ControlRPC | undefined): void }
  onStatus?: (status: ConnectorStatus) => void
}): { close(): Promise<void> } {
  const controller = new AbortController()
  const { config, metadata } = options
  let attempt = 0
  const loop = (async () => {
    while (!controller.signal.aborted) {
      let network: Awaited<ReturnType<typeof connectNodeNetwork>> | undefined
      let websocket: WebSocket | undefined
      let release: (() => void | Promise<void>) | undefined
      try {
        options.onStatus?.({ state: 'connecting', message: `Connecting through ${config.mode}` })
        network = await connectNodeNetwork({ mode: config.mode, endpoint: config.endpoint, stateDirectory: config.stateDir,
          ...(config.binDirectory ? { binDirectory: config.binDirectory } : {}),
          ...(config.tailscaleSocket ? { tailscaleSocket: config.tailscaleSocket } : {}), waitForLoginMs: 0 })
        if (controller.signal.aborted) break
        const url = new URL(options.role === 'supervisor' ? '/supervise' : '/connect', network.url)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        url.searchParams.set('nodeId', config.nodeId)
        websocket = new WebSocket(url, {
          headers: { ...(options.control ? { 'x-dsh-control': '2', 'x-dsh-control-capabilities': options.control.capabilities.join(',') } : {}), authorization: `Bearer ${config.credential}`, 'x-dsh-version': metadata.dshVersion,
            'x-dsh-runtime': metadata.runtimeId, 'x-dsh-name': encodeURIComponent(metadata.name) },
          handshakeTimeout: 15_000, maxPayload: 262144, perMessageDeflate: false,
        })
        let controlAccepted = false
        websocket.once('upgrade', response => { controlAccepted = response.headers['x-dsh-control'] === '2' })
        const socket = websocket
        const stop = () => { socket.terminate() }
        controller.signal.addEventListener('abort', stop, { once: true })
        try {
          await new Promise<void>((resolve, reject) => {
            const fail = (error: Error) => { socket.off('open', opened); reject(error) }
            const opened = () => { socket.off('error', fail); resolve() }
            socket.once('open', opened); socket.once('error', fail)
            socket.once('unexpected-response', (_request, response) => {
              response.resume()
              const refused = response.statusCode === 401 || response.statusCode === 403
              reject(refused ? new GatewayAuthenticationError('Hub rejected node identity') : new Error('Hub handshake failed'))
              socket.terminate()
            })
          })
          if (controller.signal.aborted) break
          const served = serveSurface(socket, options.surface, { control: !!options.control && controlAccepted })
          const control = options.control && controlAccepted ? new ControlRPC(socket, options.control.handle) : undefined
          options.control?.connected(control)
          let lastPong = Date.now()
          socket.on('pong', () => { lastPong = Date.now() })
          const heartbeat = setInterval(() => {
            if (Date.now() - lastPong > 45_000 || network?.closed) socket.terminate()
            else if (socket.readyState === WebSocket.OPEN) socket.ping()
          }, 15_000)
          heartbeat.unref()
          release = () => { clearInterval(heartbeat); options.control?.connected(undefined); control?.close(); served.close() }
          attempt = 0
          options.onStatus?.({ state: 'connected', message: 'Native DSH surface connected' })
          const code = await new Promise<number>((resolve) => { socket.once('close', resolve); socket.once('error', () => socket.terminate()) })
          if (code === 4003 || code === 4403) {
            options.onStatus?.({ state: 'revoked', message: 'Hub revoked this node. Pair again to reconnect.' })
            break
          }
        } finally { controller.signal.removeEventListener('abort', stop) }
      } catch (error) {
        if (error instanceof GatewayAuthenticationError) {
          options.onStatus?.({ state: 'revoked', message: 'Hub rejected this node identity. Create a new invitation and pair again.' })
          break
        }
        if (!controller.signal.aborted) {
          const login = error instanceof Error && error.name === 'TailscaleLoginRequiredError'
          options.onStatus?.({ state: login ? 'login-required' : 'disconnected', message: login ? 'Tailscale login required; run the gateway installer to sign in.' : 'Connection failed; retrying the selected transport.' })
        }
      } finally {
        websocket?.terminate()
        await release?.()
        await network?.close()
      }
      if (!controller.signal.aborted) {
        options.onStatus?.({ state: 'disconnected', message: 'Connection interrupted; native streams will reconnect in a new generation.' })
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5))
        await sleep(Math.round(delay * (0.75 + Math.random() * 0.5)), controller.signal)
      }
    }
  })()
  return { close: async () => { controller.abort(); await loop } }
}
