/**
 * Full packaged CLI -> existing profile -> native Runtime plugin -> real
 * Tailcat -> GatewayTunnel check. All profile, pairing and network state is
 * isolated below a fresh temporary directory; no production Runtime changes.
 *
 * Build the release first, then run:
 * DSH_NATIVE_ROOT=/path/to/installed-dsh DSH_GATEWAY_NETWORK_BIN=/path/to/tools \
 *   tsx packages/hub/gateway-node/tests/native-profile-install-smoke.mts
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { WebSocketServer } from 'ws'
import { GatewayNetworkManager } from '@k1412/dsh-gateway-network'
import { GatewayTunnel } from '@k1412/dsh-gateway-transport'

const installed = process.env.DSH_NATIVE_ROOT
const bins = process.env.DSH_GATEWAY_NETWORK_BIN
if (!installed || !bins) throw new Error('Set DSH_NATIVE_ROOT and DSH_GATEWAY_NETWORK_BIN; this test uses real DSH and real Tailcat')
const packageFile = resolve(process.env.DSH_GATEWAY_PACKAGE ?? 'dist/gateway/downloads/gateway-node.tgz')
const cli = resolve(process.env.DSH_GATEWAY_CLI ?? 'dist/gateway/node-package/lib/cli.js')
const require = createRequire(join(installed, 'package.json'))
const nativeCli = join(require.resolve('@deepseek-ai/dsh/package.json'), '../lib/bin.js')
const execute = promisify(execFile)
const work = await mkdtemp(join(tmpdir(), 'dsh-gateway-profile-smoke-'))
const env = { ...process.env, DSH_HOME: join(work, 'home'), DSH_TELEMETRY_DISABLED: '1' }
const profile = join(env.DSH_HOME, 'profiles/web')
const state = join(work, 'node')
await mkdir(join(work, 'bin'))
const executable = join(work, 'bin/dsh')
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(nativeCli)} "$@"\n`, { mode: 0o700 })
await execute(executable, ['--profile', 'web', '--dump-config'], { env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
let runtime: ChildProcess | undefined
let output = ''
let tunnel: GatewayTunnel | undefined
let credential: string | undefined
let enrollmentCount = 0
let runtimeStarts = 0
const inviteToken = 'native-profile-smoke-private-invitation'
const sockets = new WebSocketServer({ noServer: true })
const server = createServer(async (request, response) => {
  if (request.url !== '/enroll' || request.method !== 'POST') { response.writeHead(404).end(); return }
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const body = JSON.parse(Buffer.concat(chunks).toString())
  if (body.inviteToken !== inviteToken || body.runtimeId !== 'default' || body.dshVersion !== '0.1.7-rc.2') {
    response.writeHead(403).end(); return
  }
  credential = body.credential
  enrollmentCount++
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ nodeId: 'native-profile-smoke' }))
})
server.on('upgrade', (request, socket, head) => {
  if (request.headers.authorization !== `Bearer ${credential}` || request.headers['x-dsh-version'] !== '0.1.7-rc.2') {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return
  }
  sockets.handleUpgrade(request, socket, head, (ws) => { tunnel = new GatewayTunnel(ws) })
})
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
const port = (server.address() as { port: number }).port
const network = new GatewayNetworkManager({ stateDirectory: join(work, 'hub'), privatePort: port, overlayPort: port, binDirectory: bins, tailscaleMode: 'host' })
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const waitUntil = async (condition: () => boolean, timeout: number) => {
  const deadline = Date.now() + timeout
  while (!condition() && Date.now() < deadline) await pause(200)
  return condition()
}
const startRuntime = () => {
  runtimeStarts++
  runtime = spawn(executable, ['--profile', 'web', '--no-open', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  runtime.stdout?.on('data', (chunk) => { output += chunk.toString() })
  runtime.stderr?.on('data', (chunk) => { output += chunk.toString() })
}
const stopRuntime = async () => {
  const active = runtime
  if (!active || active.exitCode !== null || active.signalCode !== null) return
  active.kill('SIGTERM')
  if (!await waitUntil(() => active.exitCode !== null || active.signalCode !== null, 10_000)) active.kill('SIGKILL')
  await waitUntil(() => active.exitCode !== null || active.signalCode !== null, 5000)
}
try {
  await network.start()
  const endpoint = await network.endpoint('tailcat')
  // This is a pre-existing profile and Runtime when the actual installer runs.
  startRuntime()
  await pause(2000)
  assert(runtime?.pid && runtime.exitCode === null, 'The existing native Runtime starts normally')
  const initialPid = runtime.pid
  const manifest = join(work, 'manifest.json')
  await writeFile(manifest, JSON.stringify({ protocol: 1, inviteToken, hubUrl: 'https://smoke.invalid',
    mode: 'tailcat', endpoint, expiresAt: Date.now() + 300_000, packageFile,
    package: { url: 'https://downloads.smoke.invalid/node.tgz', sha256: createHash('sha256').update(await readFile(packageFile)).digest('hex') } }), { mode: 0o600 })
  const installedPlugin = await execute(process.execPath, [cli, 'install', '--manifest', manifest,
    '--state-directory', state, '--bin-directory', bins, '--dsh-executable', executable], { env, timeout: 300_000, maxBuffer: 1024 * 1024 })
  const result = JSON.parse(installedPlugin.stdout.trim())
  assert.equal(result.needsReload, true)
  assert.equal(result.profileDirectory, profile)
  assert.equal(enrollmentCount, 1)
  const activatedByHmr = await waitUntil(() => Boolean(tunnel), 20_000)
  if (!activatedByHmr) {
    await stopRuntime()
    startRuntime() // Controlled reload of the same profile, never a second live Runtime.
  }
  assert(await waitUntil(() => Boolean(tunnel), 30_000), 'The installed scoped plugin connects from the native Runtime')
  assert(tunnel)
  const page = await tunnel.fetch(new Request('http://native/'))
  assert.equal(page.status, 200)
  const html = await page.text()
  assert(html.includes('__DSH_BOOT__'))
  assert(html.includes('crossorigin="use-credentials"'))
  const asset = html.match(/src="\.\/(assets\/[^" ]+\.js)"/)?.[1]
  assert(asset)
  const script = await tunnel.fetch(new Request(`http://native/${asset}`))
  assert.equal(script.status, 200)
  assert((await script.arrayBuffer()).byteLength > 10_000)
  assert(!output.includes('without inject'), 'Cordis optional services must be accessed in a valid plugin scope')
  const report = { ok: true, packagedInstaller: true, realNativeProfile: true, realTailcat: true,
    pluginScope: true, sameProfile: true, activatedByHmr, runtimeStarts, sameProcess: runtime?.pid === initialPid,
    nativePage: page.status, officialJavascript: script.status, artifacts: work }
  await writeFile(join(work, 'report.json'), JSON.stringify(report, null, 2))
  process.stdout.write(`${JSON.stringify(report)}\n`)
} finally {
  await writeFile(join(work, 'runtime.log'), output, { mode: 0o600 })
  await stopRuntime()
  tunnel?.close()
  for (const ws of sockets.clients) ws.terminate()
  sockets.close()
  await network.close()
  await new Promise<void>((done) => server.close(() => done()))
}
