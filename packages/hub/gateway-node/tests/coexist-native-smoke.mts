/** Three shipped packages in one official rc.2 Runtime; only the overlay carrier is a loopback fixture. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { chromium, webkit } from 'playwright'
import { GatewayTunnel, ControlRPC } from '@k1412/dsh-gateway-transport'
import { gatewayProfilePatch } from '../src/install.ts'

const installed = process.env.DSH_NATIVE_ROOT
const baseline = process.env.DSH_GATEWAY_BASELINE_PACKAGE
const sessionPackage = process.env.DSH_GATEWAY_SESSION_PACKAGE
if (!installed || !baseline || !sessionPackage) throw new Error('Set DSH_NATIVE_ROOT, DSH_GATEWAY_BASELINE_PACKAGE and DSH_GATEWAY_SESSION_PACKAGE to isolated test code/artifacts')
const controlPackage = resolve(process.env.DSH_GATEWAY_CONTROL_PACKAGE ?? 'dist/gateway/downloads/gateway-node.tgz')
const work = await mkdtemp(join(tmpdir(), 'gateway-three-packages-'))
process.env.DSH_HOME = join(work, 'home'); process.env.DSH_TELEMETRY_DISABLED = '1'
const profile = join(work, 'profile'); await mkdir(profile)
const names = ['@k1412/dsh-gateway-node', '@k1412/dsh-gateway-node-session', '@k1412/dsh-gateway-node-control']
const archives = [resolve(baseline), resolve(sessionPackage), controlPackage]
const manifest = { name: 'three-gateway-fixture', private: true, type: 'module', dependencies: Object.fromEntries(names.map((name, index) => [name, `file:${archives[index]}`])), dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', names[0]] } } }
await writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
await promisify(execFile)('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps'], { cwd: profile, timeout: 120000 })
await symlink(join(installed, 'node_modules/@deepseek-ai'), join(profile, 'node_modules/@deepseek-ai'))
const require = createRequire(join(installed, 'package.json'))
const load = async (name: string) => import(pathToFileURL(require.resolve(name)).href)
const app = await load('@deepseek-ai/dsh-app-boot')
const hubs: Array<any> = []; let selectedSession = ''; let ctx: any; let browser: any
const connections: Array<any> = []
const bins = join(work, 'bin'); await mkdir(bins)
// The shipped connectNodeNetwork still owns distinct private helpers; this CLI
// forwards to a local fixture, without invoking any logged-in host network tool.
await writeFile(join(bins, 'tailcat'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
if(process.argv.includes('genkey')){const dir=path.join(process.env.XDG_CONFIG_HOME,'tailcat/keys');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'gateway-node.private.json'),'fixture-key');process.exit(0)}
const port=Number(process.argv.at(-1).split(':').at(-1));const server=net.createServer(client=>{const peer=net.connect(port,'127.0.0.1');client.pipe(peer);peer.pipe(client);client.on('error',()=>peer.destroy());peer.on('error',()=>client.destroy());client.on('close',()=>peer.destroy())});server.listen(0,'127.0.0.1',()=>process.stderr.write('Listening on 127.0.0.1:'+server.address().port+'\\n'));
`, { mode: 0o700 })
const until = async (test: () => boolean) => { const end = Date.now() + 20000; while (!test()) { if (Date.now() > end) throw new Error('Three-package fixture readiness timeout'); await new Promise(ok => setTimeout(ok, 25)) } }
try {
  for (let index = 0; index < 3; index++) {
    const credential = randomBytes(32).toString('base64url'), nodeId = `fixture-${index}`
    const agentSockets = new WebSocketServer({ noServer: true }), muxSockets = new WebSocketServer({ noServer: true })
    const hub: any = { index, agentSockets, muxSockets, tunnel: undefined, control: undefined, metadata: undefined }
    agentSockets.on('headers', (headers, req) => { if (req.headers['x-dsh-control'] === '2') headers.push('x-dsh-control: 2') })
    const server = createServer((req, res) => { void (async () => {
      if (index === 1 && req.url?.startsWith('/_hub/session-intent')) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ nodeId, runtimeId: 'shared-runtime', generation: 'fixture-generation', sessionId: selectedSession })); return }
      if (!hub.tunnel) { res.writeHead(503).end(); return }
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req)
      const controller = new AbortController(); req.on('aborted', () => controller.abort())
      const response = await hub.tunnel.fetch(new Request(`http://native${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, ...(body ? { body, duplex: 'half' } : {}), signal: controller.signal }))
      res.writeHead(response.status, Object.fromEntries(response.headers)); if (response.body) Readable.fromWeb(response.body as never).pipe(res); else res.end()
    })().catch(error => { res.writeHead(502).end(String(error)) }) })
    server.on('upgrade', (req, socket, head) => {
      if (req.url?.startsWith('/connect?')) {
        assert.equal(req.headers.authorization, `Bearer ${credential}`)
        hub.metadata = req.headers
        agentSockets.handleUpgrade(req, socket, head, ws => { hub.tunnel = new GatewayTunnel(ws, { control: req.headers['x-dsh-control'] === '2' }); if (req.headers['x-dsh-control'] === '2') hub.control = new ControlRPC(ws, async () => { throw new Error('No peer delegation in this fixture') }) })
      } else if (req.url === '/api/remote.mux') muxSockets.handleUpgrade(req, socket, head, ws => {
        const controller = new AbortController(), mux = hub.tunnel.openMux((text: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(text) }, controller.signal)
        ws.on('message', bytes => mux.send(bytes.toString())); ws.on('close', () => { controller.abort(); mux.close() })
      }); else socket.destroy()
    })
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok)); hub.server = server; hub.port = (server.address() as any).port; hubs.push(hub)
    const state = join(work, `state-${index}`); await mkdir(state)
    const connectionFile = join(state, 'connection.json')
    await writeFile(connectionFile, JSON.stringify({ protocol: 1, nodeId, credential, clientId: `local-${index}`, name: `Coexist ${index}`, mode: 'tailcat', endpoint: `tailcat://tcFixtureCarrier1234567890123456789:${hub.port}`, stateDir: state, hubUrl: `http://127.0.0.1:${hub.port}`, binDirectory: bins }), { mode: 0o600 })
    connections.push({ connectionFile, original: await readFile(connectionFile, 'utf8') })
  }
  let patch = gatewayProfilePatch('[]\n', connections[0].connectionFile)
  patch += `\n# BEGIN DSH GATEWAY INSTANCE gateway-node-session\n- insert:\n    - id: gateway-node-session\n      name: ${JSON.stringify(join(profile, 'node_modules', names[1], 'lib/index.js'))}\n      config:\n        connectionFile: ${JSON.stringify(connections[1].connectionFile)}\n        runtimeId: shared-runtime\n        sessionDirectory: true\n# END DSH GATEWAY INSTANCE gateway-node-session\n`
  patch = gatewayProfilePatch(patch, connections[2].connectionFile, 'gateway-node-control', join(profile, 'node_modules', names[2], 'lib/index.js'), true)
  await writeFile(join(profile, 'cordis.patch.yml'), patch); await writeFile(join(profile, 'cordis.yml'), '[]\n')
  const loaded = app.loadProfileDirectory('coexist', profile, require.resolve('@deepseek-ai/dsh/package.json'))
  assert.equal(loaded.skippedBundles.length, 0)
  const inventory = app.readProfilePlugins({ binName: 'coexist', profileDir: profile, installAnchor: require.resolve('@deepseek-ai/dsh/package.json') })
  assert(names.every(name => inventory.dependencies.some((dependency: any) => dependency.name === name)), 'Official inventory preserves alias keys')
  const resolution = await app.createRuntimeResolution({ installAnchor: require.resolve('@deepseek-ai/dsh/package.json'), profile: loaded, home: process.env.DSH_HOME })
  const patches = [
    ...loaded.layers.flatMap((layer: any) => layer.patches), ...loaded.patches,
    ...app.loadOverlayPatches('coexist', require.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml')),
    ...['webserver', 'web-runtime', 'web-startup', 'open-in-app', 'client-hmr', 'directory-picker', 'session-title-llm'].map(id => ({ id, disabled: true })),
    { id: 'connection', inject: [], config: { trustedHosts: [] } },
  ]
  ctx = await app.boot('coexist', join(profile, 'cordis.yml'), patches, async (scope: any) => { await scope.plugin(app.PluginPackages, { resolution }) }, pathToFileURL(join(profile, 'package.json')).href)
  assert.equal(ctx.webServer, undefined)
  await until(() => hubs.every(hub => hub.tunnel?.isOpen))
  assert.equal(hubs[0].metadata['x-dsh-control'], undefined); assert.equal(hubs[1].metadata['x-dsh-control'], undefined)
  assert.equal(hubs[1].metadata['x-dsh-session-directory'], '1'); assert.equal(hubs[0].metadata['x-dsh-session-directory'], undefined)
  assert.equal(hubs[2].metadata['x-dsh-control'], '2')
  const controlInventory = await hubs[2].control.call('management.inventory', {})
  assert(Array.isArray(controlInventory.bundles))
  const ids = ctx.clientModules.graph().entries.map((entry: any) => entry.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ids.filter((id: string) => id === names[0]).length, 1, 'Only the session package contributes one navigation client')
  const workspace = await ctx.workspaceController.create({ path: work })
  const session = await ctx.sessionController.create({ workspaceId: workspace.workspace.workspaceId, sessionId: 'coexist-selected-session' }); selectedSession = session.sessionId
  await ctx.sessionController.rename({ sessionId: selectedSession, title: 'Coexist selected session' })
  browser = await (process.env.DSH_NATIVE_BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true })
  const page = await browser.newPage(); page.setDefaultTimeout(15000)
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${hubs[0].port}/`, { waitUntil: 'networkidle' })
  await page.locator('textarea,[contenteditable="true"]').first().waitFor(); assert.equal(await page.locator('#gateway-session-intent').count(), 0)
  await page.goto(`http://127.0.0.1:${hubs[1].port}/?gatewayIntent=fixture-intent`, { waitUntil: 'networkidle' })
  await page.locator(`#gateway-session-intent[data-state="opened"][data-session-id="${selectedSession}"]`).waitFor()
  assert.equal(errors.length, 0, errors.join('\n'))
  const baseTunnel = hubs[0].tunnel, sessionTunnel = hubs[1].tunnel
  const remove = (id: string) => { const entry = [...ctx.loader.entries()].find((entry: any) => entry.options.id === id); assert(entry); entry.parent.tree.remove(entry.options.id) }
  remove('gateway-node-control'); await ctx.loader.await(); await until(() => !hubs[2].tunnel.isOpen)
  assert(baseTunnel.isOpen && sessionTunnel.isOpen)
  remove('gateway-node-session'); await ctx.loader.await(); await until(() => !hubs[1].tunnel.isOpen)
  assert(baseTunnel.isOpen)
  await until(() => !ctx.clientModules.graph().entries.some((entry: any) => entry.id === names[0]))
  for (const connection of connections) assert.equal(await readFile(connection.connectionFile, 'utf8'), connection.original)
  await promisify(execFile)('npm', ['uninstall', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', names[1], names[2]], { cwd: profile, timeout: 120000 })
  const after = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.equal(after.dependencies[names[0]], manifest.dependencies[names[0]])
  assert.equal(after.dependencies[names[1]], undefined); assert.equal(after.dependencies[names[2]], undefined)
  assert.equal((await baseTunnel.fetch(new Request('http://native/'))).status, 200)
  const report = { ok: true, runtimeCount: 1, officialDependencyAliases: true, threePackagedConnections: true, baseNativeUI: true, sessionNavigation: true, controlOnlyOnControlConnection: true, uniqueClientGraph: true, isolatedUninstall: true, baseConnectionPreserved: true, browser: process.env.DSH_NATIVE_BROWSER ?? 'chromium', overlay: 'loopback carrier fixture', artifacts: work }
  await writeFile(join(work, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
} finally {
  await browser?.close(); await ctx?.fiber.dispose()
  for (const hub of hubs) { hub.control?.close(); hub.tunnel?.close(); for (const ws of [...hub.agentSockets.clients, ...hub.muxSockets.clients]) ws.terminate(); hub.agentSockets.close(); hub.muxSockets.close(); await new Promise<void>(ok => hub.server.close(ok)) }
}
