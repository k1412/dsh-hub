import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, connect } from 'node:net'
import type { Server, Socket } from 'node:net'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { isTailnetIP, tailscaleEndpoint } from './endpoints.ts'
import type { NetworkMode } from './endpoints.ts'
import { runCommand, spawnProcess, stopProcess, tailcatAddress, safeNetworkError } from './process.ts'
import type { CommandRunner, ProcessSpawner } from './process.ts'
import { NETWORK_VERSIONS } from './versions.ts'

export type NetworkState = 'starting' | 'needs-login' | 'ready' | 'unavailable'
export interface OverlayStatus {
  installed: boolean
  state: NetworkState
  endpoint?: string
  loginUrl?: string
  error?: string
}
export interface GatewayNetworkStatus {
  tailscale: OverlayStatus & { mode: 'managed' | 'host' }
  tailcat: OverlayStatus
  versions: typeof NETWORK_VERSIONS
}
export interface HubNetworkOptions {
  stateDirectory: string
  privatePort?: number
  overlayPort?: number
  binDirectory?: string
  tailscaleMode?: 'managed' | 'host'
  tailscaleSocket?: string
  hostname?: string
  run?: CommandRunner
  spawn?: ProcessSpawner
}

interface TailscaleStatus {
  BackendState?: string
  AuthURL?: string
  TailscaleIPs?: string[]
  Self?: { TailscaleIPs?: string[]; Online?: boolean }
}

/** Owns only the gateway's network identity and two private overlay listeners. */
export class GatewayNetworkManager {
  private readonly options: Required<Pick<HubNetworkOptions, 'privatePort' | 'overlayPort' | 'tailscaleMode' | 'hostname'>> & HubNetworkOptions
  private readonly run: CommandRunner
  private readonly spawn: ProcessSpawner
  private readonly tailscale: string
  private readonly tailscaled: string
  private readonly tailcat: string
  private readonly socket: string
  private readonly tailcatEnv: NodeJS.ProcessEnv
  private tailscaledProcess: ChildProcessWithoutNullStreams | undefined
  private tailcatProcess: ChildProcessWithoutNullStreams | undefined
  private hostListener: Server | undefined
  private hostIP: string | undefined
  private readonly hostConnections = new Set<Socket>()
  private poll: ReturnType<typeof setInterval> | undefined
  private closed = false
  private updating: Promise<void> | undefined
  private networkStatus: GatewayNetworkStatus

  constructor(options: HubNetworkOptions) {
    this.options = { ...options, privatePort: options.privatePort ?? 8081, overlayPort: options.overlayPort ?? 8081,
      tailscaleMode: options.tailscaleMode ?? 'managed', hostname: options.hostname ?? 'dsh-hub' }
    this.run = options.run ?? runCommand
    this.spawn = options.spawn ?? spawnProcess
    this.tailscale = options.binDirectory === undefined ? 'tailscale' : join(options.binDirectory, 'tailscale')
    this.tailscaled = options.binDirectory === undefined ? 'tailscaled' : join(options.binDirectory, 'tailscaled')
    this.tailcat = options.binDirectory === undefined ? 'tailcat' : join(options.binDirectory, 'tailcat')
    this.socket = options.tailscaleSocket ?? (this.options.tailscaleMode === 'host'
      ? '/var/run/tailscale/tailscaled.sock' : join(options.stateDirectory, 'tailscale.sock'))
    this.tailcatEnv = { ...process.env, XDG_CONFIG_HOME: join(options.stateDirectory, 'tailcat-config') }
    this.networkStatus = { tailscale: { installed: false, state: 'starting', mode: this.options.tailscaleMode },
      tailcat: { installed: false, state: 'starting' }, versions: NETWORK_VERSIONS }
  }

  async start(): Promise<void> {
    await mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 })
    await this.update()
    if (!this.closed && this.poll === undefined) {
      this.poll = setInterval(() => { void this.update() }, 5000)
      this.poll.unref()
    }
  }

  async status(): Promise<GatewayNetworkStatus> {
    await this.update()
    return structuredClone(this.networkStatus)
  }

  async endpoint(mode: NetworkMode): Promise<string> {
    const status = await this.status()
    const entry = status[mode]
    if (entry.state !== 'ready' || entry.endpoint === undefined) {
      throw new Error(mode === 'tailscale' && entry.state === 'needs-login'
        ? '请先登录 Hub 的 Tailscale，再创建邀请。'
        : `${mode === 'tailscale' ? 'Tailscale' : 'Tailcat'} 尚未连接，请检查网络状态。`)
    }
    return entry.endpoint
  }

  async loginTailscale(): Promise<GatewayNetworkStatus> {
    if (this.options.tailscaleMode === 'host') throw new Error('宿主 Tailscale 由宿主管理；Hub 只读取其状态。')
    await this.update()
    if (!this.networkStatus.tailscale.installed) throw new Error('Tailscale is not installed')
    if (this.networkStatus.tailscale.state === 'ready') return structuredClone(this.networkStatus)
    // Standard CLI applies settings only to our own userspace daemon. The one
    // second timeout obtains the login URL without leaving the UI waiting.
    await this.run(this.tailscale, [this.socketArgument(), 'up', '--accept-dns=false',
      `--hostname=${this.options.hostname}`, '--timeout=1s'], { timeoutMs: 4000 })
    await this.update()
    return structuredClone(this.networkStatus)
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.poll !== undefined) clearInterval(this.poll)
    await this.updating
    this.closeHostListener()
    await Promise.all([stopProcess(this.tailscaledProcess), stopProcess(this.tailcatProcess)])
    this.tailscaledProcess = undefined
    this.tailcatProcess = undefined
  }

  private socketArgument(): string { return `--socket=${this.socket}` }
  private async update(): Promise<void> {
    if (this.closed) return
    if (this.updating !== undefined) return this.updating
    this.updating = Promise.allSettled([this.updateTailscale(), this.updateTailcat()]).then(() => {})
    try { await this.updating } finally { this.updating = undefined }
  }

  private async updateTailscale(): Promise<void> {
    const mode = this.options.tailscaleMode
    try {
      const version = await this.run(this.tailscale, ['version'], { timeoutMs: 4000 })
      if (version.code !== 0) throw new Error('binary unavailable')
      this.networkStatus.tailscale.installed = true
      if (mode === 'managed' && this.tailscaledProcess === undefined) {
        await mkdir(join(this.options.stateDirectory, 'tailscale'), { recursive: true, mode: 0o700 })
        const child = this.spawn(this.tailscaled, ['--tun=userspace-networking', `--socket=${this.socket}`,
          `--statedir=${join(this.options.stateDirectory, 'tailscale')}`, '--port=0'])
        this.tailscaledProcess = child
        child.stdout.resume()
        child.stderr.resume()
        child.on('error', () => {
          if (this.tailscaledProcess === child) this.tailscaledProcess = undefined
          this.markTailscaleUnavailable('Hub Tailscale 无法启动。')
        })
        child.on('exit', () => {
          if (this.tailscaledProcess === child) this.tailscaledProcess = undefined
          this.markTailscaleUnavailable('Hub Tailscale 已断开，正在恢复。')
        })
      }
      const response = await this.run(this.tailscale, [this.socketArgument(), 'status', '--json'], { timeoutMs: 4000 })
      if (response.code !== 0) {
        this.networkStatus.tailscale = { installed: true, state: 'starting', mode,
          error: mode === 'host' ? '无法读取宿主 Tailscale socket。' : 'Hub Tailscale 正在启动。' }
        this.closeHostListener()
        return
      }
      const status = JSON.parse(response.stdout) as TailscaleStatus
      const ip = (status.Self?.TailscaleIPs ?? status.TailscaleIPs ?? []).find(isTailnetIP)
      if (status.BackendState !== 'Running' || status.Self?.Online === false || ip === undefined) {
        this.networkStatus.tailscale = { installed: true, state: 'needs-login', mode,
          ...(typeof status.AuthURL === 'string' && status.AuthURL.startsWith('https://') ? { loginUrl: status.AuthURL } : {}) }
        this.closeHostListener()
        return
      }
      const endpoint = tailscaleEndpoint(ip, this.options.overlayPort)
      if (mode === 'host') await this.ensureHostListener(ip)
      else if (this.networkStatus.tailscale.endpoint !== endpoint) {
        const serve = await this.run(this.tailscale, [this.socketArgument(), 'serve', '--bg',
          '--yes', `--tcp=${this.options.overlayPort}`, `tcp://127.0.0.1:${this.options.privatePort}`], { timeoutMs: 8000 })
        if (serve.code !== 0) throw new Error('private listener unavailable')
      }
      this.networkStatus.tailscale = { installed: true, state: 'ready', endpoint, mode }
    } catch (error) {
      this.markTailscaleUnavailable(safeNetworkError(error, 'Tailscale 私有入口不可用，请检查工具和网络配置。'))
      this.closeHostListener()
    }
  }

  private markTailscaleUnavailable(error: string): void {
    this.networkStatus.tailscale = { installed: this.networkStatus.tailscale.installed,
      state: 'unavailable', mode: this.options.tailscaleMode, error }
  }

  private async ensureHostListener(ip: string): Promise<void> {
    if (this.hostListener !== undefined && this.hostIP === ip) return
    this.closeHostListener()
    const server = createServer(client => {
      const upstream = connect({ host: '127.0.0.1', port: this.options.privatePort })
      this.hostConnections.add(client)
      this.hostConnections.add(upstream)
      client.on('close', () => { this.hostConnections.delete(client); upstream.destroy() })
      upstream.on('close', () => { this.hostConnections.delete(upstream); client.destroy() })
      client.on('error', () => { upstream.destroy() })
      upstream.on('error', () => { client.destroy() })
      client.pipe(upstream).pipe(client)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.overlayPort, ip, () => { server.off('error', reject); resolve() })
    })
    server.on('error', () => { this.markTailscaleUnavailable('宿主 Tailscale 私有入口监听失败。'); this.closeHostListener() })
    this.hostListener = server
    this.hostIP = ip
  }

  private closeHostListener(): void {
    for (const socket of this.hostConnections) socket.destroy()
    this.hostConnections.clear()
    this.hostListener?.close()
    this.hostListener = undefined
    this.hostIP = undefined
  }

  private async updateTailcat(): Promise<void> {
    if (this.tailcatProcess !== undefined) return
    try {
      const help = await this.run(this.tailcat, ['--help'], { env: this.tailcatEnv, timeoutMs: 4000 })
      if (help.code !== 0) throw new Error('binary unavailable')
      this.networkStatus.tailcat = { installed: true, state: 'starting' }
      const key = join(this.options.stateDirectory, 'tailcat-config', 'tailcat', 'keys', 'gateway-hub.private.json')
      if (!existsSync(key)) {
        const generated = await this.run(this.tailcat, ['genkey', '--key=gateway-hub', '--fixed-region'],
          { env: this.tailcatEnv, timeoutMs: 20_000 })
        if (generated.code !== 0) throw new Error('key initialization failed')
      }
      if (this.closed) return
      const child = this.spawn(this.tailcat, ['serve', '--full-address', '--key=gateway-hub', String(this.options.privatePort)], this.tailcatEnv)
      this.tailcatProcess = child
      let output = ''
      const read = (chunk: Buffer): void => {
        output = (output + chunk.toString()).slice(-8192)
        const address = tailcatAddress(output)
        if (address !== undefined) this.networkStatus.tailcat = { installed: true, state: 'ready',
          endpoint: `tailcat://${address}:${this.options.privatePort}` }
      }
      child.stdout.on('data', read)
      child.stderr.on('data', read)
      child.on('error', () => {
        if (this.tailcatProcess === child) this.tailcatProcess = undefined
        this.networkStatus.tailcat = { installed: true, state: 'unavailable', error: 'Tailcat 无法启动。' }
      })
      child.on('exit', () => {
        if (this.tailcatProcess === child) this.tailcatProcess = undefined
        this.networkStatus.tailcat = { installed: true, state: 'unavailable', error: 'Tailcat 已断开，正在恢复。' }
      })
    } catch (error) {
      this.networkStatus.tailcat = { installed: this.networkStatus.tailcat.installed, state: 'unavailable',
        error: safeNetworkError(error, 'Tailcat 私有入口不可用，请检查中继网络。') }
    }
  }
}

export { GatewayNetworkManager as HubNetworkManager }
