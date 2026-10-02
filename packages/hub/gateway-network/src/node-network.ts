import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { NetworkMode } from './endpoints.ts'
import { parseTailscaleEndpoint, parseTailcatEndpoint } from './endpoints.ts'
import { runCommand, spawnProcess, stopProcess } from './process.ts'
import type { CommandRunner, ProcessSpawner } from './process.ts'

export interface NodeNetworkOptions {
  mode: NetworkMode
  endpoint: string
  stateDirectory: string
  binDirectory?: string
  tailscaleSocket?: string
  allowManagedTailscale?: boolean
  onLogin?: (url: string) => void
  waitForLoginMs?: number
  run?: CommandRunner
  spawn?: ProcessSpawner
}
export interface LocalOverlayTunnel {
  mode: NetworkMode
  url: string
  readonly closed: boolean
  close(): Promise<void>
}
export class TailscaleLoginRequiredError extends Error {
  constructor(public readonly loginUrl: string | undefined) {
    super(loginUrl === undefined ? '请登录节点的 Tailscale 后重试。' : `请完成 Tailscale 登录：${loginUrl}`)
    this.name = 'TailscaleLoginRequiredError'
  }
}

const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds))
const sleepUntil = async (test: () => Promise<boolean>, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  do {
    if (await test()) return true
    await delay(200)
  } while (Date.now() < deadline)
  return false
}

/** Loopback is a local adapter to an overlay, never a raw LAN fallback. */
export async function connectNodeNetwork(options: NodeNetworkOptions): Promise<LocalOverlayTunnel> {
  if (options.mode === 'tailcat') return connectTailcat(options)
  if (options.mode === 'tailscale') return connectTailscale(options)
  throw new Error('Only Tailscale and Tailcat are supported')
}

async function connectTailcat(options: NodeNetworkOptions): Promise<LocalOverlayTunnel> {
  const destination = parseTailcatEndpoint(options.endpoint)
  const run = options.run ?? runCommand
  const spawn = options.spawn ?? spawnProcess
  const binary = options.binDirectory === undefined ? 'tailcat' : join(options.binDirectory, 'tailcat')
  const env = { ...process.env, XDG_CONFIG_HOME: join(options.stateDirectory, 'tailcat-config') }
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 })
  const key = join(env.XDG_CONFIG_HOME, 'tailcat', 'keys', 'gateway-node.private.json')
  if (!existsSync(key)) {
    const generated = await run(binary, ['genkey', '--client', '--key=gateway-node'], { env, timeoutMs: 8000 })
    if (generated.code !== 0) throw new Error('Tailcat 节点身份初始化失败。')
  }
  // A single long-lived CLI process multiplexes concurrent HTTP/WebSocket
  // sockets. Starting one client process per TCP socket would reuse a
  // WireGuard identity concurrently and can disrupt earlier connections.
  const child = spawn(binary, ['--key=gateway-node', 'forward', '--bind=127.0.0.1', destination.host,
    `0:${destination.port}`], env)
  let closed = false
  child.once('exit', () => { closed = true })
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error('Tailcat 连接准备超时，请检查中继网络。')), 15_000)
      const onData = (chunk: Buffer): void => {
        output = (output + chunk.toString()).slice(-8192)
        const match = /127\.0\.0\.1:(\d+)/.exec(output)
        if (match === null || Number(match[1]) < 1 || Number(match[1]) > 65_535) return
        cleanup()
        resolve(Number(match[1]))
      }
      const onError = (): void => { cleanup(); reject(new Error('Tailcat 连接进程无法启动。')) }
      const onExit = (): void => { cleanup(); reject(new Error('Tailcat 连接失败，请检查工具和中继网络。')) }
      const cleanup = (): void => {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.stderr.off('data', onData)
        child.off('error', onError)
        child.off('exit', onExit)
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.once('error', onError)
      child.once('exit', onExit)
    })
    child.stdout.resume()
    child.stderr.resume()
    child.on('error', () => { closed = true })
    return { mode: 'tailcat', url: `http://127.0.0.1:${port}`, get closed() { return closed },
      async close() { closed = true; await stopProcess(child) } }
  } catch (error) { await stopProcess(child); throw error }
}

interface Status { BackendState?: string; AuthURL?: string }
async function connectTailscale(options: NodeNetworkOptions): Promise<LocalOverlayTunnel> {
  const destination = parseTailscaleEndpoint(options.endpoint)
  const run = options.run ?? runCommand
  const spawn = options.spawn ?? spawnProcess
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 })
  const binary = options.binDirectory === undefined ? 'tailscale' : join(options.binDirectory, 'tailscale')
  const daemonBinary = options.binDirectory === undefined ? 'tailscaled' : join(options.binDirectory, 'tailscaled')
  let socket = options.tailscaleSocket
  let ownedDaemon: ChildProcessWithoutNullStreams | undefined
  let closed = false
  const readStatus = async (selectedBinary: string, selectedSocket: string | undefined): Promise<Status | undefined> => {
    try {
      const result = await run(selectedBinary, [...(selectedSocket === undefined ? [] : [`--socket=${selectedSocket}`]),
        'status', '--json'], { timeoutMs: 4000 })
      return result.code === 0 ? JSON.parse(result.stdout) as Status : undefined
    } catch { return undefined }
  }

  // Prefer an existing, already logged-in daemon. Never call up/login/serve
  // on the host socket, or alter that node's existing identity or routes.
  let selectedBinary = binary
  try {
    let status = await readStatus('tailscale', socket)
    if (status?.BackendState === 'Running') selectedBinary = 'tailscale'
    else {
      status = await readStatus(binary, socket)
      if (status?.BackendState !== 'Running') {
        if (options.allowManagedTailscale === false) throw new TailscaleLoginRequiredError(undefined)
        socket = join(options.stateDirectory, 'node-tailscale.sock')
        status = await readStatus(binary, socket)
        if (status === undefined) {
          await mkdir(join(options.stateDirectory, 'tailscale'), { recursive: true, mode: 0o700 })
          ownedDaemon = spawn(daemonBinary, ['--tun=userspace-networking', `--socket=${socket}`,
            `--statedir=${join(options.stateDirectory, 'tailscale')}`, '--port=0'])
          ownedDaemon.stdout.resume()
          ownedDaemon.stderr.resume()
          ownedDaemon.on('error', () => { closed = true })
          ownedDaemon.once('exit', () => { closed = true })
          const started = await sleepUntil(async () => {
            status = await readStatus(binary, socket)
            return status !== undefined || closed
          }, 8000)
          if (!started || closed) {
            await stopProcess(ownedDaemon)
            throw new Error('节点专用 Tailscale 服务无法启动。')
          }
        }
        if (status?.BackendState !== 'Running') {
          await run(binary, [`--socket=${socket}`, 'up', '--accept-dns=false', '--hostname=dsh-node', '--timeout=1s'],
            { timeoutMs: 4000 })
          status = await readStatus(binary, socket)
          const loginUrl = status?.AuthURL?.startsWith('https://') === true ? status.AuthURL : undefined
          if (loginUrl !== undefined) options.onLogin?.(loginUrl)
          if (options.waitForLoginMs !== undefined && options.waitForLoginMs > 0) {
            await sleepUntil(async () => {
              status = await readStatus(binary, socket)
              return status?.BackendState === 'Running' || closed
            }, options.waitForLoginMs)
          }
          if (status?.BackendState !== 'Running' || closed) {
            await stopProcess(ownedDaemon)
            throw new TailscaleLoginRequiredError(loginUrl)
          }
        }
      }
    }
  } catch (error) {
    await stopProcess(ownedDaemon)
    throw error
  }
  const sessions = new Set<ChildProcessWithoutNullStreams>()
  const clients = new Set<Socket>()
  const server = createServer(client => {
    if (closed) { client.destroy(); return }
    const child = spawn(selectedBinary, [...(socket === undefined ? [] : [`--socket=${socket}`]),
      'nc', destination.host, String(destination.port)])
    sessions.add(child)
    clients.add(client)
    child.stderr.resume()
    child.stdout.on('error', () => { client.destroy() })
    child.stdin.on('error', () => { client.destroy() })
    child.on('error', () => { client.destroy() })
    child.once('exit', () => { sessions.delete(child); client.destroy() })
    client.on('error', () => { child.kill('SIGTERM') })
    client.once('close', () => { clients.delete(client); child.kill('SIGTERM') })
    client.pipe(child.stdin)
    child.stdout.pipe(client)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    server.on('error', () => { closed = true })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('节点本地网络入口不可用。')
    return { mode: 'tailscale', url: `http://127.0.0.1:${address.port}`, get closed() { return closed },
      async close() {
        closed = true
        for (const client of clients) client.destroy()
        server.close()
        await Promise.all([...sessions].map(stopProcess))
        await stopProcess(ownedDaemon)
      } }
  } catch (error) {
    server.close()
    await stopProcess(ownedDaemon)
    throw error
  }
}
