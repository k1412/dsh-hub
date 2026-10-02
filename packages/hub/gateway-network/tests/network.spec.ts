import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { GatewayNetworkManager, connectNodeNetwork, isTailnetIP, networkAssets,
  parseTailscaleEndpoint, parseTailcatEndpoint, TailscaleLoginRequiredError } from '../src/index.ts'
import type { CommandRunner, ProcessSpawner } from '../src/process.ts'
import type { LocalOverlayTunnel } from '../src/index.ts'

let directory: string
const cleanup: Array<() => Promise<void>> = []
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'dsh-gateway-network-')) })
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(close => close()))
  await rm(directory, { recursive: true, force: true })
})

const ok = (stdout = '') => ({ stdout, stderr: '', code: 0 })

describe('overlay boundaries', () => {
  it('rejects raw LAN, localhost, public IP, credentials and non-root endpoints before spawning', async () => {
    const run = vi.fn<CommandRunner>()
    const start = vi.fn<ProcessSpawner>()
    for (const endpoint of ['http://192.168.1.2:8081', 'http://127.0.0.1:8081', 'http://203.0.113.2:8081',
      'http://hub.example:8081', 'http://user:pass@100.64.0.2:8081', 'http://100.64.0.2:8081/path']) {
      await expect(connectNodeNetwork({ mode: 'tailscale', endpoint, stateDirectory: directory, run, spawn: start })).rejects.toThrow()
    }
    expect(run).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(isTailnetIP('100.63.255.255')).toBe(false)
    expect(isTailnetIP('100.128.0.1')).toBe(false)
    expect(parseTailscaleEndpoint('http://100.127.0.1:8081')).toEqual({ host: '100.127.0.1', port: 8081 })
    expect(parseTailscaleEndpoint('http://[fd7a:115c:a1e0::1]:8081')).toEqual({ host: 'fd7a:115c:a1e0::1', port: 8081 })
  })

  it('preserves case-sensitive Tailcat addresses and rejects port mappings to other hosts', () => {
    const address = 'tcUpperCASE_and_lowercase0123456789'
    expect(parseTailcatEndpoint(`tailcat://${address}:8081`)).toEqual({ host: address, port: 8081 })
    expect(() => parseTailcatEndpoint(`tailcat://${address}:192.168.1.1:8081`)).toThrow()
    expect(() => parseTailcatEndpoint(`tailcat://${address}:65536`)).toThrow()
  })

  it('keeps container downloads and application release metadata identical', async () => {
    const pins = JSON.parse(await readFile(new URL('../../../../deploy/gateway/network-pins.json', import.meta.url), 'utf8'))
    for (const architecture of ['amd64', 'arm64'] as const) {
      expect(networkAssets(architecture).map(({ platform: _platform, ...asset }) => asset))
        .toEqual(pins.assets.filter((asset: { architecture: string }) => asset.architecture === architecture))
    }
  })
})

describe('Hub network identity', () => {
  it('host mode only reads status and never logs in or changes host Serve configuration', async () => {
    const calls: string[][] = []
    const run: CommandRunner = async (binary, args) => {
      calls.push([binary, ...args])
      if (binary === 'tailcat') return { ...ok(), code: 1 }
      if (args.includes('status')) return ok(JSON.stringify({ BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/test' }))
      return ok('1.102.4')
    }
    const start = vi.fn<ProcessSpawner>()
    const manager = new GatewayNetworkManager({ stateDirectory: directory, tailscaleMode: 'host', run, spawn: start })
    cleanup.push(() => manager.close())
    await manager.start()
    expect((await manager.status()).tailscale.state).toBe('needs-login')
    await expect(manager.loginTailscale()).rejects.toThrow('只读取')
    await expect(manager.endpoint('tailscale')).rejects.toThrow('登录')
    expect(start).not.toHaveBeenCalled()
    expect(calls.every(call => !call.includes('up') && !call.includes('serve') && !call.includes('login'))).toBe(true)
  })

  it('managed mode logs into only its own socket and reuses the Tailcat key after restart', async () => {
    const calls: string[][] = []
    let loggedIn = false
    const run: CommandRunner = async (binary, args, options) => {
      calls.push([binary, ...args])
      if (args.includes('genkey')) {
        const keys = join(options!.env!.XDG_CONFIG_HOME!, 'tailcat', 'keys')
        await mkdir(keys, { recursive: true })
        await writeFile(join(keys, 'gateway-hub.private.json'), '{}')
      }
      if (args.includes('up')) loggedIn = true
      if (args.includes('status')) return ok(JSON.stringify(loggedIn
        ? { BackendState: 'Running', Self: { TailscaleIPs: ['100.64.0.10'], Online: true } }
        : { BackendState: 'NeedsLogin' }))
      return ok()
    }
    const start: ProcessSpawner = (binary, args, env) => {
      if (binary.endsWith('tailcat')) expect(args).toContain('--full-address')
      return spawn(process.execPath, ['-e', binary.endsWith('tailcat')
        ? 'process.stderr.write("Listening tcUpperCASE_lowercase0123456789\\n");setInterval(()=>{},1000)'
        : 'setInterval(()=>{},1000)'], { stdio: ['pipe', 'pipe', 'pipe'], env })
    }
    const options = { stateDirectory: directory, run, spawn: start }
    const manager = new GatewayNetworkManager(options)
    cleanup.push(() => manager.close())
    await manager.start()
    await manager.loginTailscale()
    expect(await manager.endpoint('tailscale')).toBe('http://100.64.0.10:8081')
    await vi.waitFor(async () => { expect((await manager.status()).tailcat.state).toBe('ready') })
    expect(await manager.endpoint('tailcat')).toBe('tailcat://tcUpperCASE_lowercase0123456789:8081')
    expect(calls.filter(call => call.includes('up')).every(call => call.includes(`--socket=${join(directory, 'tailscale.sock')}`))).toBe(true)
    await manager.close()
    const restarted = new GatewayNetworkManager(options)
    cleanup.push(() => restarted.close())
    await restarted.start()
    expect(calls.filter(call => call.includes('genkey'))).toHaveLength(1)
  })
})

describe('node overlay adapters', () => {
  it('moves concurrent HTTP streams through tailscale nc without mutating a logged-in host', async () => {
    const upstream = createServer((request, response) => { response.end(`result:${request.url}`) })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => upstream.close(() => resolve())))
    const upstreamPort = (upstream.address() as { port: number }).port
    const calls: string[][] = []
    const run: CommandRunner = async (_binary, args) => {
      calls.push(args)
      return ok(JSON.stringify({ BackendState: 'Running' }))
    }
    const start: ProcessSpawner = (_binary, args) => {
      expect(args.slice(-3)).toEqual(['nc', '100.64.0.10', '8081'])
      return spawn(process.execPath, ['-e', `const c=require('node:net').connect(${upstreamPort},'127.0.0.1');process.stdin.pipe(c);c.pipe(process.stdout);c.on('error',()=>process.exit(1))`],
        { stdio: ['pipe', 'pipe', 'pipe'] })
    }
    const tunnel = await connectNodeNetwork({ mode: 'tailscale', endpoint: 'http://100.64.0.10:8081',
      stateDirectory: directory, run, spawn: start })
    cleanup.push(() => tunnel.close())
    const output = await Promise.all(['/a', '/b', '/c'].map(async path => (await fetch(`${tunnel.url}${path}`)).text()))
    expect(output).toEqual(['result:/a', 'result:/b', 'result:/c'])
    expect(calls.every(args => args.includes('status'))).toBe(true)
    await tunnel.close()
    expect(tunnel.closed).toBe(true)
  })

  it('multiplexes Tailcat sockets through one helper with a persistent node identity', async () => {
    let generated = 0
    let helpers = 0
    const run: CommandRunner = async (_binary, args, options) => {
      if (args.includes('genkey')) {
        generated++
        const keys = join(options!.env!.XDG_CONFIG_HOME!, 'tailcat', 'keys')
        await mkdir(keys, { recursive: true })
        await writeFile(join(keys, 'gateway-node.private.json'), '{}')
      }
      return ok()
    }
    const start: ProcessSpawner = (binary, args) => {
      helpers++
      expect(binary).toBe('tailcat')
      expect(args).toEqual(['--key=gateway-node', 'forward', '--bind=127.0.0.1', 'tcUpperCASE_lowercase0123456789', '0:8081'])
      return spawn(process.execPath, ['-e', "const s=require('node:http').createServer((q,r)=>r.end('tailcat:'+q.url));s.listen(0,'127.0.0.1',()=>process.stderr.write('Listening on 127.0.0.1:'+s.address().port+'\\n'))"],
        { stdio: ['pipe', 'pipe', 'pipe'] })
    }
    const open = (): Promise<LocalOverlayTunnel> => connectNodeNetwork({ mode: 'tailcat',
      endpoint: 'tailcat://tcUpperCASE_lowercase0123456789:8081', stateDirectory: directory, run, spawn: start })
    const tunnel = await open()
    cleanup.push(() => tunnel.close())
    expect(await Promise.all(['/a', '/b'].map(async path => (await fetch(`${tunnel.url}${path}`)).text())))
      .toEqual(['tailcat:/a', 'tailcat:/b'])
    expect(helpers).toBe(1)
    await tunnel.close()
    const reopened = await open()
    cleanup.push(() => reopened.close())
    expect(generated).toBe(1)
  })

  it('reports Tailcat setup failure without trying another network', async () => {
    const calls: string[] = []
    const run: CommandRunner = async binary => { calls.push(binary); return { ...ok(), code: 1 } }
    const start = vi.fn<ProcessSpawner>()
    await expect(connectNodeNetwork({ mode: 'tailcat', endpoint: 'tailcat://tcUpperCASE_lowercase0123456789:8081',
      stateDirectory: directory, run, spawn: start })).rejects.toThrow('身份初始化失败')
    expect(calls).toEqual(['tailcat'])
    expect(start).not.toHaveBeenCalled()
  })

  it('does not silently return an unusable URL when managed Tailscale needs login', async () => {
    const login = vi.fn()
    const run: CommandRunner = async (_binary, args) => {
      if (args.includes('status')) return args.some(arg => arg.includes('node-tailscale.sock'))
        ? ok(JSON.stringify({ BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/test' }))
        : { ...ok(), code: 1 }
      return ok()
    }
    const start = vi.fn<ProcessSpawner>()
    await expect(connectNodeNetwork({ mode: 'tailscale', endpoint: 'http://100.64.0.10:8081',
      stateDirectory: directory, run, spawn: start, onLogin: login })).rejects.toBeInstanceOf(TailscaleLoginRequiredError)
    expect(login).toHaveBeenCalledWith('https://login.tailscale.com/a/test')
    expect(start).not.toHaveBeenCalled()
  })

  it('keeps a read-only host test from starting or logging into a managed daemon', async () => {
    const calls: string[][] = []
    const run: CommandRunner = async (_binary, args) => {
      calls.push(args)
      return ok(JSON.stringify({ BackendState: 'NeedsLogin' }))
    }
    const start = vi.fn<ProcessSpawner>()
    await expect(connectNodeNetwork({ mode: 'tailscale', endpoint: 'http://100.64.0.10:8081',
      stateDirectory: directory, run, spawn: start, allowManagedTailscale: false })).rejects.toBeInstanceOf(TailscaleLoginRequiredError)
    expect(calls.every(args => args.includes('status'))).toBe(true)
    expect(start).not.toHaveBeenCalled()
  })
})
