import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readlink, lstat, rm, writeFile, readdir, symlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { execFile, spawnSync } from 'node:child_process'

let directory: string
let server: Server | undefined
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'gateway-installer-')) })
afterEach(async () => {
  server?.closeAllConnections()
  await new Promise<void>(resolve => { if (server === undefined) resolve(); else server.close(() => resolve()) })
  await rm(directory, { recursive: true, force: true })
})

const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
async function fixture(badPackageHash = false, options: {
  expired?: boolean; claimed?: unknown; mode?: 'tailcat' | 'tailscale'; tailscaleState?: 'Running' | 'NeedsLogin'
  tailscaleFault?: 'malformed' | 'error' | 'stall'
  packageFault?: 'headers-stall' | 'body-stall' | 'truncated' | 'oversize-header' | 'oversize-stream' | 'slow-stream' | 'compressed'
  faultOnce?: boolean
} = {}): Promise<{ origin: string; record: string; requests: string[] }> {
  const mode = options.mode ?? 'tailcat'
  const packageRoot = join(directory, 'fixture', 'package')
  await mkdir(join(packageRoot, 'lib'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'gateway-fixture', type: 'module' }))
  await writeFile(join(packageRoot, 'lib', 'cli.js'), `import {readFile,writeFile} from 'node:fs/promises';const a=process.argv.slice(2);const manifest=JSON.parse(await readFile(a[a.indexOf('--manifest')+1],'utf8'));await writeFile(process.env.GATEWAY_INSTALL_TEST_RECORD,JSON.stringify({args:a,manifest}));`)
  const packageArchive = join(directory, 'node.tgz')
  expect(spawnSync('tar', ['-czf', packageArchive, '-C', join(directory, 'fixture'), 'package']).status).toBe(0)
  const networkRoot = join(directory, 'network-fixture')
  await mkdir(networkRoot)
  const networkNames = mode === 'tailcat' ? ['tailcat'] : ['tailscale', 'tailscaled']
  for (const name of networkNames) await writeFile(join(networkRoot, name), '#!/bin/sh\nexit 0\n')
  const networkArchive = join(directory, 'network.tgz')
  expect(spawnSync('tar', ['-czf', networkArchive, '-C', networkRoot, ...networkNames]).status).toBe(0)
  // macOS installs use an already configured tool. Keep the test independent
  // of the runner's Homebrew packages and real Tailscale account/daemon.
  const existingTools = join(directory, 'existing-tools')
  await mkdir(existingTools)
  await writeFile(join(existingTools, 'tailcat'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await writeFile(join(existingTools, 'tailscale'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GATEWAY_INSTALL_TEST_TAILSCALE_LOG"\n${options.tailscaleFault === 'stall' ? 'exec sleep 10' : options.tailscaleFault === 'error' ? 'exit 1' : `printf '%s\\n' '${options.tailscaleFault === 'malformed' ? 'invalid json' : JSON.stringify({ BackendState: options.tailscaleState ?? 'Running' })}'`}\n`, { mode: 0o755 })
  const packageBytes = await readFile(packageArchive)
  const networkBytes = await readFile(networkArchive)
  let origin = ''
  const requests: string[] = []
  let packageRequests = 0
  server = createServer((request, response) => {
    requests.push(request.url ?? '')
    if (request.url === '/api/enrollment/testToken') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ protocol: 1, hubUrl: 'https://owner.example', downloadUrl: origin, mode,
        endpoint: mode === 'tailcat' ? 'tailcat://tcCASE_preserved_test_address12345678:8081' : 'http://100.64.0.10:8081',
        expiresAt: Date.now() + (options.expired ? -60_000 : 60_000),
        ...(options.claimed === undefined ? {} : { claimed: options.claimed }),
        package: { url: `${origin}/downloads/gateway-node.tgz`, sha256: badPackageHash ? '0'.repeat(64) : hash(packageBytes) },
        networkBinaries: Object.fromEntries(['amd64', 'arm64'].map(architecture => [`linux-${architecture}`,
          [{ tool: mode, file: 'network.tgz', url: `${origin}/downloads/network.tgz`, sha256: hash(networkBytes) }]])) }))
    } else if (request.url === '/downloads/gateway-node.tgz') {
      packageRequests++
      const fault = options.faultOnce && packageRequests > 1 ? undefined : options.packageFault
      if (fault === 'headers-stall') return
      if (fault === 'body-stall') { response.writeHead(200); response.write(packageBytes.subarray(0, 1)); return }
      if (fault === 'truncated') {
        response.writeHead(200, { 'content-length': packageBytes.length })
        response.write(packageBytes.subarray(0, Math.max(1, Math.floor(packageBytes.length / 2))))
        setTimeout(() => response.destroy(), 20)
        return
      }
      if (fault === 'oversize-header') {
        response.writeHead(200, { 'content-length': 300 * 1024 * 1024 + 1 })
        response.end('x')
        return
      }
      if (fault === 'oversize-stream') {
        response.writeHead(200)
        const chunk = Buffer.alloc(1024 * 1024)
        let sent = 0
        const send = (): void => {
          while (!response.destroyed && sent < 301) {
            sent++
            if (!response.write(chunk)) { response.once('drain', send); return }
          }
          if (sent === 301 && !response.destroyed) response.end()
        }
        send()
        return
      }
      if (fault === 'slow-stream') {
        response.writeHead(200, { 'content-length': packageBytes.length })
        let sent = 0
        const timer = setInterval(() => {
          const next = Math.min(packageBytes.length, sent + Math.ceil(packageBytes.length / 6))
          response.write(packageBytes.subarray(sent, next))
          sent = next
          if (sent === packageBytes.length) { clearInterval(timer); response.end() }
        }, 100)
        response.once('close', () => clearInterval(timer))
        return
      }
      if (fault === 'compressed') {
        const compressed = gzipSync(packageBytes)
        response.writeHead(200, { 'content-length': compressed.length, 'content-encoding': 'gzip' })
        response.end(compressed)
        return
      }
      response.end(packageBytes)
    }
    else if (request.url === '/downloads/network.tgz') response.end(networkBytes)
    else { response.statusCode = 404; response.end() }
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { origin, record: join(directory, 'installed.json'), requests }
}

async function install(origin: string, record: string, shortenDeadlines = false, env: NodeJS.ProcessEnv = {}, extra: string[] = []): Promise<{ code: number; output: string }> {
  const installer = process.env.GATEWAY_INSTALLER_TEST_PATH ?? new URL('../../../../deploy/gateway/install.sh', import.meta.url).pathname
  let nodeOptions = process.env.NODE_OPTIONS ?? ''
  if (shortenDeadlines) {
    const preload = join(directory, 'deadline-preload.mjs')
    await writeFile(preload, 'const original=globalThis.setTimeout;globalThis.setTimeout=(callback,ms,...args)=>original(callback,ms===30000?400:ms,...args);')
    nodeOptions += ` --import=${pathToFileURL(preload).href}`
  }
  return new Promise(resolve => {
    execFile('sh', [installer, '--hub', origin, '--invite', 'testToken', '--state-directory', env.GATEWAY_INSTALL_TEST_STATE_DIRECTORY ?? join(directory, 'node-state'), '--profile', 'existing-profile', ...extra],
      { env: { ...process.env, PATH: `${join(directory, 'existing-tools')}:${process.env.PATH ?? ''}`,
        NODE_OPTIONS: nodeOptions.trim(), DSH_GATEWAY_ALLOW_HTTP_TEST: '1', GATEWAY_INSTALL_TEST_RECORD: record,
        GATEWAY_INSTALL_TEST_TAILSCALE_LOG: join(directory, 'tailscale-commands.log'), ...env }, timeout: 20_000 },
      (error, stdout, stderr) => resolve({ code: error === null ? 0 : 1, output: stdout + stderr }))
  })
}

it.each(['tailcat', 'tailscale'] as const)('installs only the selected %s overlay using the platform installation path', async mode => {
  const { origin, record, requests } = await fixture(false, { mode })
  const result = await install(origin, record)
  expect(result.code).toBe(0)
  expect(result.output).toContain('Downloading invitation manifest:')
  expect(result.output).toContain('gateway-node.tgz: complete,')
  expect(result.output).toContain('checksum verified')
  expect(result.output).not.toContain('testToken')
  expect(result.output).not.toContain(origin)
  const installed = JSON.parse(await readFile(record, 'utf8'))
  expect(installed.manifest.inviteToken).toBe('testToken')
  expect(installed.manifest.mode).toBe(mode)
  expect(installed.args.slice(-2)).toEqual(['--profile', 'existing-profile'])
  expect(installed.manifest.packageDirectory).toContain('/packages/gateway-node-')
  const selected = join(directory, 'node-state', 'bin', mode)
  if (process.platform === 'darwin' || mode === 'tailscale') {
    expect((await lstat(selected)).isSymbolicLink()).toBe(true)
    expect(await readlink(selected)).toBe(await realpath(join(directory, 'existing-tools', mode)))
    expect(requests).not.toContain('/downloads/network.tgz')
    if (mode === 'tailscale') {
      expect(installed.args).toContain('--reuse-tailscale')
      expect(result.output).toContain('reusing the logged-in local client')
      expect(await readFile(join(directory, 'tailscale-commands.log'), 'utf8')).toBe('status --json\n')
    }
  } else {
    expect(process.platform).toBe('linux')
    expect((await lstat(selected)).isFile()).toBe(true)
    expect(await readFile(selected, 'utf8')).toBe('#!/bin/sh\nexit 0\n')
    expect(requests.filter(url => url === '/downloads/network.tgz')).toHaveLength(1)
  }
  await expect(readFile(join(directory, 'node-state', 'bin', mode === 'tailcat' ? 'tailscale' : 'tailcat'))).rejects.toThrow()
})

it('reuses host Tailscale on repeated installations, replaces stale links, and honors its custom socket', async () => {
  const { origin, record, requests } = await fixture(false, { mode: 'tailscale' })
  const bins = join(directory, 'node-state', 'bin')
  await mkdir(bins, { recursive: true })
  await symlink(join(directory, 'missing-client'), join(bins, 'tailscale'))
  const socket = join(directory, 'existing-daemon.sock')
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await install(origin, record, false, { DSH_GATEWAY_TAILSCALE_SOCKET: socket })
    expect(result.code).toBe(0)
    expect(result.output).toContain('no network package download or new login')
    expect(await readlink(join(bins, 'tailscale'))).toBe(await realpath(join(directory, 'existing-tools', 'tailscale')))
  }
  expect(await readFile(join(directory, 'tailscale-commands.log'), 'utf8')).toBe(`--socket=${socket} status --json\n`.repeat(2))
  expect(requests.filter(url => url.includes('network'))).toEqual([])
  await expect(lstat(join(bins, 'tailscaled'))).rejects.toThrow()
})

it('does not create a self-referencing link when a state directory alias contains the existing CLI', async () => {
  const { origin, record, requests } = await fixture(false, { mode: 'tailscale' })
  const bins = join(directory, 'node-state', 'bin')
  await mkdir(bins, { recursive: true })
  const binary = join(bins, 'tailscale')
  await writeFile(binary, await readFile(join(directory, 'existing-tools', 'tailscale')), { mode: 0o700 })
  const alias = join(directory, 'state-alias')
  await symlink(join(directory, 'node-state'), alias)
  const result = await install(origin, record, false, { PATH: `${join(alias, 'bin')}:${process.env.PATH ?? ''}`, GATEWAY_INSTALL_TEST_STATE_DIRECTORY: alias })
  expect(result.code).toBe(0)
  expect((await lstat(binary)).isFile()).toBe(true)
  expect(requests).not.toContain('/downloads/network.tgz')
})

it.runIf(process.platform === 'linux').each([
  { tailscaleState: 'NeedsLogin' as const },
  { tailscaleFault: 'malformed' as const },
  { tailscaleFault: 'error' as const },
  { tailscaleFault: 'stall' as const },
])('uses a verified private helper when host Tailscale is unusable: %j', async options => {
  const { origin, record, requests } = await fixture(false, { mode: 'tailscale', ...options })
  const started = Date.now()
  const result = await install(origin, record)
  expect(result.code).toBe(0)
  expect(Date.now() - started).toBeLessThan(8000)
  expect(requests.filter(url => url === '/downloads/network.tgz')).toHaveLength(1)
  expect(JSON.parse(await readFile(record, 'utf8')).args).not.toContain('--reuse-tailscale')
  expect(await readFile(join(directory, 'tailscale-commands.log'), 'utf8')).toBe('status --json\n')
  for (const name of ['tailscale', 'tailscaled']) {
    expect(await readFile(join(directory, 'node-state', 'bin', name), 'utf8')).toBe('#!/bin/sh\nexit 0\n')
  }
}, 10_000)

it.runIf(process.platform === 'darwin')('requires existing Tailscale login on macOS without downloading another client', async () => {
  const { origin, record, requests } = await fixture(false, { mode: 'tailscale', tailscaleState: 'NeedsLogin' })
  const result = await install(origin, record)
  expect(result.code).toBe(1)
  expect(result.output).toContain('sign in to an accessible existing Tailscale application')
  expect(requests).not.toContain('/downloads/network.tgz')
  await expect(readFile(record)).rejects.toThrow()
})

it.runIf(process.platform === 'linux').each(['tailcat', 'tailscale'] as const)('rehashes the %s archive cache and repairs private binaries without downloading again', async mode => {
  const { origin, record, requests } = await fixture(false, { mode, tailscaleState: 'NeedsLogin' })
  expect((await install(origin, record)).code).toBe(0)
  const binary = join(directory, 'node-state', 'bin', mode)
  await writeFile(binary, 'corrupted installed binary')
  const result = await install(origin, record)
  expect(result.code).toBe(0)
  expect(result.output).toContain('reusing the cached network archive, checksum verified')
  expect(requests.filter(url => url === '/downloads/network.tgz')).toHaveLength(1)
  expect(await readFile(binary, 'utf8')).toBe('#!/bin/sh\nexit 0\n')
})

it.runIf(process.platform === 'linux').each(['corrupt', 'symlink'] as const)('downloads again rather than trusting a %s archive cache', async fault => {
  const { origin, record, requests } = await fixture(false, { mode: 'tailscale', tailscaleState: 'NeedsLogin' })
  expect((await install(origin, record)).code).toBe(0)
  const cacheDirectory = join(directory, 'node-state', 'network-cache')
  const [name] = await readdir(cacheDirectory)
  const archive = join(cacheDirectory, name!)
  if (fault === 'corrupt') await writeFile(archive, 'truncated archive')
  else {
    await rm(archive)
    await symlink(join(directory, 'network.tgz'), archive)
  }
  const result = await install(origin, record)
  expect(result.code).toBe(0)
  expect(requests.filter(url => url === '/downloads/network.tgz')).toHaveLength(2)
  expect((await lstat(archive)).isFile()).toBe(true)
})

it.runIf(process.platform === 'linux')('never overwrites or chmods the host executable when falling back after host reuse', async () => {
  const { origin, record, requests } = await fixture(false, { mode: 'tailscale' })
  expect((await install(origin, record)).code).toBe(0)
  const hostBinary = join(directory, 'existing-tools', 'tailscale')
  const loggedOut = '#!/bin/sh\nprintf \'%s\\n\' \'{"BackendState":"NeedsLogin"}\'\n'
  await writeFile(hostBinary, loggedOut)
  const before = await lstat(hostBinary)
  const result = await install(origin, record)
  expect(result.code).toBe(0)
  expect(await readFile(hostBinary, 'utf8')).toBe(loggedOut)
  expect((await lstat(hostBinary)).mode).toBe(before.mode)
  expect((await lstat(join(directory, 'node-state', 'bin', 'tailscale'))).isSymbolicLink()).toBe(false)
  expect(requests.filter(url => url === '/downloads/network.tgz')).toHaveLength(1)
})

it('stops before invoking or installing a plugin when the package checksum is wrong', async () => {
  const { origin, record } = await fixture(true)
  const result = await install(origin, record)
  expect(result.code).toBe(1)
  expect(result.output).toContain('checksum did not match')
  await expect(readFile(record)).rejects.toThrow()
})

it.each([undefined, false, 'true', 1])('rejects an expired invitation unless claimed is exactly boolean true (%s)', async claimed => {
  const { origin, record } = await fixture(false, { expired: true, claimed })
  const result = await install(origin, record)
  expect(result.code).toBe(1)
  expect(result.output).toContain('Invitation has expired')
  await expect(readFile(record)).rejects.toThrow()
})

it('passes an expired already-claimed invitation to the CLI without changing the saved local identity', async () => {
  const { origin, record } = await fixture(false, { expired: true, claimed: true })
  const stateDirectory = join(directory, 'node-state')
  await mkdir(stateDirectory)
  const identity = { clientId: 'existing-client', credential: 'existing-credential', invitationHash: hash(Buffer.from('testToken')) }
  await writeFile(join(stateDirectory, 'identity.json'), JSON.stringify(identity))
  const result = await install(origin, record)
  expect(result.code).toBe(0)
  const installed = JSON.parse(await readFile(record, 'utf8'))
  expect(installed.manifest.claimed).toBe(true)
  expect(installed.manifest.expiresAt).toBeLessThan(Date.now())
  expect(installed.manifest.inviteToken).toBe('testToken')
  expect(JSON.parse(await readFile(join(stateDirectory, 'identity.json'), 'utf8'))).toEqual(identity)
})

it.each([
  ['headers-stall', 'no HTTP response headers within 30 seconds'],
  ['body-stall', 'no download progress for 30 seconds'],
  ['truncated', 'connection or file write interrupted'],
  ['oversize-header', 'declared size exceeds the 300.00 MiB limit'],
] as const)('reports a bounded and token-free package download failure for %s', async (packageFault, message) => {
  const { origin, record, requests } = await fixture(false, { packageFault })
  const result = await install(origin, record, true)
  expect(result.code).toBe(1)
  expect(result.output).toContain(`gateway-node.tgz: ${message}`)
  expect(result.output).toContain('No partial file was installed')
  expect(result.output).not.toContain('testToken')
  expect(result.output).not.toContain(origin)
  expect(requests.filter(url => url === '/downloads/gateway-node.tgz')).toHaveLength(1)
  await expect(readFile(record)).rejects.toThrow()
})

it('stops a chunked response at the streaming size limit without installing its partial package', async () => {
  const { origin, record } = await fixture(false, { packageFault: 'oversize-stream' })
  const result = await install(origin, record)
  expect(result.code).toBe(1)
  expect(result.output).toContain('received size exceeds the 300.00 MiB limit')
  expect(result.output).toContain('No partial file was installed')
  await expect(readFile(record)).rejects.toThrow()
}, 30_000)

it('can recover on a fresh bounded installation attempt after a stalled transfer', async () => {
  const { origin, record, requests } = await fixture(false, { packageFault: 'body-stall', faultOnce: true })
  const failed = await install(origin, record, true)
  expect(failed.code).toBe(1)
  expect(failed.output).toContain('no download progress')
  const retry = await install(origin, record)
  expect(retry.code).toBe(0)
  expect(retry.output).toContain('checksum verified')
  expect(requests.filter(url => url === '/downloads/gateway-node.tgz')).toHaveLength(2)
  expect(JSON.parse(await readFile(record, 'utf8')).manifest.inviteToken).toBe('testToken')
})

it('allows an archive to keep progressing beyond the small-request deadline', async () => {
  const { origin, record } = await fixture(false, { packageFault: 'slow-stream' })
  const result = await install(origin, record, true)
  expect(result.code).toBe(0)
  expect(result.output).toContain('gateway-node.tgz: complete,')
  expect(result.output).toContain('checksum verified')
})

it('verifies decoded bytes when HTTP compression changes the Content-Length', async () => {
  const { origin, record } = await fixture(false, { packageFault: 'compressed' })
  const result = await install(origin, record)
  expect(result.code).toBe(0)
  expect(result.output).toContain('gateway-node.tgz: complete,')
  expect(result.output).toContain('checksum verified')
})

it('passes explicit instance and alias flags to the packaged node CLI', async () => {
  const { origin, record } = await fixture(false, { mode: 'tailscale' })
  const result = await install(origin, record, false, {}, ['--instance', 'gateway-extra', '--package-alias', '@k1412/dsh-gateway-node-control', '--control'])
  expect(result.code).toBe(0)
  const installed = JSON.parse(await readFile(record, 'utf8'))
  expect(installed.args).toEqual(expect.arrayContaining(['--instance', 'gateway-extra', '--package-alias', '@k1412/dsh-gateway-node-control', '--control']))
})
