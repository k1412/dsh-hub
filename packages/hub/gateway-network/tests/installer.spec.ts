import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readlink, lstat, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
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
  await writeFile(join(existingTools, 'tailscale'), `#!/bin/sh\nprintf '%s\\n' '{"BackendState":"${options.tailscaleState ?? 'Running'}"}'\n`, { mode: 0o755 })
  const packageBytes = await readFile(packageArchive)
  const networkBytes = await readFile(networkArchive)
  let origin = ''
  const requests: string[] = []
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
    } else if (request.url === '/downloads/gateway-node.tgz') response.end(packageBytes)
    else if (request.url === '/downloads/network.tgz') response.end(networkBytes)
    else { response.statusCode = 404; response.end() }
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { origin, record: join(directory, 'installed.json'), requests }
}

async function install(origin: string, record: string): Promise<{ code: number; output: string }> {
  const installer = new URL('../../../../deploy/gateway/install.sh', import.meta.url).pathname
  return new Promise(resolve => {
    execFile('sh', [installer, '--hub', origin, '--invite', 'testToken', '--state-directory', join(directory, 'node-state'), '--profile', 'existing-profile'],
      { env: { ...process.env, PATH: `${join(directory, 'existing-tools')}:${process.env.PATH ?? ''}`,
        DSH_GATEWAY_ALLOW_HTTP_TEST: '1', GATEWAY_INSTALL_TEST_RECORD: record }, timeout: 10_000 },
      (error, stdout, stderr) => resolve({ code: error === null ? 0 : 1, output: stdout + stderr }))
  })
}

it.each(['tailcat', 'tailscale'] as const)('installs only the selected %s overlay using the platform installation path', async mode => {
  const { origin, record, requests } = await fixture(false, { mode })
  const result = await install(origin, record)
  expect(result).toEqual({ code: 0, output: 'Downloading the Hub invitation and connection plugin…\n' })
  const installed = JSON.parse(await readFile(record, 'utf8'))
  expect(installed.manifest.inviteToken).toBe('testToken')
  expect(installed.manifest.mode).toBe(mode)
  expect(installed.args.slice(-2)).toEqual(['--profile', 'existing-profile'])
  expect(installed.manifest.packageDirectory).toContain('/packages/gateway-node-')
  const selected = join(directory, 'node-state', 'bin', mode)
  if (process.platform === 'darwin') {
    expect((await lstat(selected)).isSymbolicLink()).toBe(true)
    expect(await readlink(selected)).toBe(join(directory, 'existing-tools', mode))
    expect(requests).not.toContain('/downloads/network.tgz')
  } else {
    expect(process.platform).toBe('linux')
    expect((await lstat(selected)).isFile()).toBe(true)
    expect(await readFile(selected, 'utf8')).toBe('#!/bin/sh\nexit 0\n')
    expect(requests.filter(url => url === '/downloads/network.tgz')).toHaveLength(1)
    if (mode === 'tailscale') expect(await readFile(join(directory, 'node-state', 'bin', 'tailscaled'), 'utf8')).toBe('#!/bin/sh\nexit 0\n')
  }
  await expect(readFile(join(directory, 'node-state', 'bin', mode === 'tailcat' ? 'tailscale' : 'tailcat'))).rejects.toThrow()
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
