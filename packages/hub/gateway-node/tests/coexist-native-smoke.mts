/** Three shipped packages in one official rc.2 Runtime; only the overlay carrier is a loopback fixture. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, symlink, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { chromium, webkit } from 'playwright'
import { GatewayTunnel, ControlRPC } from '@k1412/dsh-gateway-transport'
import { gatewayProfilePatch, verifyInstalledGateway, createAliasedGatewayArchive } from '../src/install.ts'

const installed = process.env.DSH_NATIVE_ROOT
const baseline = process.env.DSH_GATEWAY_BASELINE_PACKAGE
const sessionPackage = process.env.DSH_GATEWAY_SESSION_PACKAGE
if (!installed || !baseline || !sessionPackage) throw new Error('Set DSH_NATIVE_ROOT, DSH_GATEWAY_BASELINE_PACKAGE and DSH_GATEWAY_SESSION_PACKAGE to isolated test code/artifacts')
const require = createRequire(join(installed, 'package.json'))
const controlPackage = resolve(process.env.DSH_GATEWAY_CONTROL_PACKAGE ?? 'dist/gateway/downloads/gateway-node.tgz')
const work = await mkdtemp(join(tmpdir(), 'gateway-three-packages-'))
process.env.DSH_HOME = join(work, 'home'); process.env.DSH_TELEMETRY_DISABLED = '1'
const profile = join(process.env.DSH_HOME, 'profiles/coexist'); await mkdir(profile, { recursive: true })
const names = ['@k1412/dsh-gateway-node', '@k1412/dsh-gateway-node-session', '@k1412/dsh-gateway-node-control']
const originalArchives = [resolve(baseline), resolve(sessionPackage), controlPackage]
const archives = [...originalArchives]
for (const index of [1, 2]) archives[index] = await createAliasedGatewayArchive(archives[index]!, names[index]!, work)
await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages: [.]\nnodeLinker: hoisted\nautoInstallPeers: false\n')
const manifest = { name: 'three-gateway-fixture', private: true, type: 'module', dependencies: Object.fromEntries(names.map((name, index) => [name, `file:${archives[index]}`])), dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', names[0]] } } }
// Reproduce the production hoisted failure, then repair its existing lockfile.
const path = join(profile, 'package.json')
let current = { ...manifest, dependencies: {} as Record<string, string> }
const install = async () => {
  await writeFile(path, JSON.stringify(current))
  await promisify(execFile)(process.execPath, [join(installed, 'lib/bin.js'), 'plugin', '--profile', 'coexist', 'install', '--config.auto-install-peers=false'], { cwd: work, timeout: 120000 })
}
for (const index of [0, 2, 1]) {
  current.dependencies[names[index]!] = `file:${originalArchives[index]}`
  await install()
}
const originalsByVersion = new Map<string, string>(); let collisions = 0
for (const name of names) {
  const manifest = JSON.parse(await readFile(join(profile, 'node_modules', name, 'package.json'), 'utf8'))
  const code = await readFile(join(profile, 'node_modules', name, 'lib/index.js'), 'utf8')
  assert.equal(manifest.name, names[0], 'Unrepaired dependency aliases retain the original package name')
  if (originalsByVersion.has(manifest.version)) {
    assert.equal(code, originalsByVersion.get(manifest.version), 'Equal-version original aliases reproduce the hoisted code collision')
    collisions++
  } else originalsByVersion.set(manifest.version, code)
}
assert(collisions > 0, 'Fixture includes equal-version original aliases')
const repaired = [names[0]!]
for (const index of [2, 1]) {
  current.dependencies[names[index]!] = manifest.dependencies[names[index]!]!
  await install(); repaired.push(names[index]!)
  for (const name of repaired) await verifyInstalledGateway(archives[names.indexOf(name)]!, profile, name)
}
await symlink(dirname(dirname(require.resolve('@deepseek-ai/dsh-client-modules/package.json'))), join(profile, 'node_modules/@deepseek-ai'))
const load = async (name: string) => import(pathToFileURL(require.resolve(name)).href)
const app = await load('@deepseek-ai/dsh-app-boot')
const hubs: Array<any> = []; let selectedSession = ''; let ctx: any; let browser: any
const browserRecovery: Array<any> = []
const connections: Array<any> = []
const bins = join(work, 'bin'); await mkdir(bins)
// The shipped connectNodeNetwork still owns distinct private helpers; this CLI
// forwards to a local fixture, without invoking any logged-in host network tool.
await writeFile(join(bins, 'tailcat'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
if(process.argv.includes('genkey')){const dir=path.join(process.env.XDG_CONFIG_HOME,'tailcat/keys');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'gateway-node.private.json'),'fixture-key');process.exit(0)}
const port=Number(process.argv.at(-1).split(':').at(-1));const server=net.createServer(client=>{const peer=net.connect(port,'127.0.0.1');client.pipe(peer);peer.pipe(client);client.on('error',()=>peer.destroy());peer.on('error',()=>client.destroy());client.on('close',()=>peer.destroy())});server.listen(0,'127.0.0.1',()=>process.stderr.write('Listening on 127.0.0.1:'+server.address().port+'\\n'));
`, { mode: 0o700 })
const snapshotForFailure = (page: any) => page.evaluate(() => ({ conversations: [...document.querySelectorAll('[data-conversation-session]')].map(element => element.getAttribute('data-conversation-session')), storage: Object.entries(localStorage).filter(([key]) => key.startsWith('dsh.conversation.')) }))
// The listener-only host HMR plugin stays disabled. Probe the actual Gateway
// /plugins/events adapter with an owned reader, separately from browser mux.
const openPluginEvents = async (port: number) => {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const close = async () => { controller.abort(); try { await reader?.cancel() } catch { /* The severed carrier already closed it. */ } }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/plugins/events`, { signal: controller.signal })
    assert.equal(response.status, 200); assert(response.headers.get('content-type')?.startsWith('text/event-stream'))
    reader = response.body!.getReader()
    const decoder = new TextDecoder(); let text = ''
    while (true) {
      const chunk = await reader.read(); assert(!chunk.done, 'Native SSE supplies its initial graph frame')
      text += decoder.decode(chunk.value, { stream: true })
      const data = text.split('\n\n').find(frame => frame.startsWith('data: '))
      if (!data) continue
      const frame = JSON.parse(data.slice(6)); assert.equal(frame.type, 'graph')
      return { graph: frame.graph, close,
        async waitForDisconnect() {
          let timeout: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              (async () => { try { while (!(await reader!.read()).done) { /* Drain already queued frames. */ } } catch { /* Carrier closure is an expected reader error. */ } })(),
              new Promise<never>((_ok, reject) => { timeout = setTimeout(() => reject(new Error('Owned native SSE reader did not close after disconnect')), 3000) }),
            ])
          } finally { clearTimeout(timeout) }
        },
      }
    }
  } catch (error) { await close(); throw error }
  finally { clearTimeout(timer) }
}
const readSessionList = (page: any) => page.evaluate(async () => {
  const response = await fetch('/api/session/list', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session/list', payload: { args: { _request: {} } } }), signal: AbortSignal.timeout(5000) })
  const body = await response.json()
  if (!response.ok || body.result?.ok !== true) throw new Error('Native session list unavailable')
  return body.result.value.items as Array<{ sessionId: string; blank: boolean }>
})
const until = async (test: () => boolean) => { const end = Date.now() + 20000; while (!test()) { if (Date.now() > end) throw new Error('Three-package fixture readiness timeout'); await new Promise(ok => setTimeout(ok, 25)) } }
try {
  for (let index = 0; index < 3; index++) {
    const credential = randomBytes(32).toString('base64url'), nodeId = `fixture-${index}`
    const agentSockets = new WebSocketServer({ noServer: true }), muxSockets = new WebSocketServer({ noServer: true })
    const hub: any = { index, agentSockets, muxSockets, tunnel: undefined, control: undefined, metadata: undefined, generations: 0, muxGenerations: 0, lastConnectedAt: 0, lastMuxAt: 0, httpResponses: new Set(), sseResponses: new Set(), promptRequests: 0 }
    agentSockets.on('headers', (headers, req) => { if (req.headers['x-dsh-control'] === '2') headers.push('x-dsh-control: 2') })
    const server = createServer((req, res) => {
      hub.httpResponses.add(res); res.once('close', () => { hub.httpResponses.delete(res); hub.sseResponses.delete(res) })
      void (async () => {
      if (req.url === '/api/session/prompt') { hub.promptRequests++; res.writeHead(409).end('Unsent draft fixture forbids inference'); return }
      if (index === 1 && req.url?.startsWith('/_hub/session-intent')) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ nodeId, runtimeId: 'shared-runtime', generation: 'fixture-generation', sessionId: selectedSession })); return }
      if (!hub.tunnel) { res.writeHead(503).end(); return }
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req)
      const controller = new AbortController(); req.on('aborted', () => controller.abort()); res.once('close', () => controller.abort())
      const response = await hub.tunnel.fetch(new Request(`http://native${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, ...(body ? { body, duplex: 'half' } : {}), signal: controller.signal }))
      if (response.headers.get('content-type')?.startsWith('text/event-stream')) hub.sseResponses.add(res)
      res.writeHead(response.status, Object.fromEntries(response.headers)); if (response.body) Readable.fromWeb(response.body as never).on('error', () => res.destroy()).pipe(res); else res.end()
    })().catch(error => { if (!res.destroyed) { if (!res.headersSent) res.writeHead(502); res.end(String(error)) } }) })
    server.on('upgrade', (req, socket, head) => {
      if (req.url?.startsWith('/connect?')) {
        assert.equal(req.headers.authorization, `Bearer ${credential}`)
        hub.metadata = req.headers
        agentSockets.handleUpgrade(req, socket, head, ws => { hub.generations++; hub.lastConnectedAt = Date.now(); hub.tunnel = new GatewayTunnel(ws, { control: req.headers['x-dsh-control'] === '2' }); if (req.headers['x-dsh-control'] === '2') hub.control = new ControlRPC(ws, async () => { throw new Error('No peer delegation in this fixture') }) })
      } else if (req.url === '/api/remote.mux') {
        if (!hub.tunnel?.isOpen) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return }
        muxSockets.handleUpgrade(req, socket, head, ws => {
          const controller = new AbortController()
          let mux: ReturnType<GatewayTunnel['openMux']>
          try { mux = hub.tunnel.openMux((text: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(text) }, controller.signal) }
          catch { ws.close(1013, 'Fixture connector recovering'); return }
          hub.muxGenerations++; hub.lastMuxAt = Date.now()
          ws.on('message', bytes => mux.send(bytes.toString())); ws.on('close', () => { controller.abort(); mux.close() })
        })
      } else socket.destroy()
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
  patch = patch.replace('        control: true', `        control: true\n        delegationWorkspace: ${JSON.stringify(work)}\n        trustedPackages: []\n        installation: npm`)
  await writeFile(join(profile, 'cordis.patch.yml'), patch); await writeFile(join(profile, 'cordis.yml'), '[]\n')
  const loaded = app.loadProfileDirectory('coexist', profile, require.resolve('@deepseek-ai/dsh/package.json'))
  assert.equal(loaded.skippedBundles.length, 0)
  const inventory = app.readProfilePlugins({ binName: 'coexist', profileDir: profile, installAnchor: require.resolve('@deepseek-ai/dsh/package.json') })
  assert(names.every(name => inventory.dependencies.some((dependency: any) => dependency.name === name)), 'Official inventory preserves alias keys')
  const fixturePlugin = join(work, 'cli-fixture.mjs')
  await writeFile(fixturePlugin, `
export const inject = ['sessionController', 'workspaceController', 'clientModules'];
export function apply(ctx) {
  const graph = () => ctx.clientModules.graph().entries.map(entry => entry.id);
  const receive = async message => { if (!message.remove) return; const entry = [...ctx.loader.entries()].find(entry => entry.options.id === message.remove); if (!entry) throw new Error('Fixture entry missing'); entry.parent.tree.remove(entry.options.id); await ctx.loader.await(); process.send({ id: message.id, graph: graph() }); };
  process.on('message', receive); ctx.effect(() => () => { process.removeListener('message', receive); process.disconnect(); });
  ctx.appReady.onReady(() => { void (async () => {
    const workspace = await ctx.workspaceController.create({ path: ${JSON.stringify(work)} });
    const session = await ctx.sessionController.create({ workspaceId: workspace.workspace.workspaceId, sessionId: 'coexist-selected-session' });
    await ctx.sessionController.rename({ sessionId: session.sessionId, title: 'Coexist selected session' });
    process.send({ ready: true, sessionId: session.sessionId, graph: graph(), hasWebListener: Boolean(ctx.get('webServer')) });
  })(); });
}
`)
  const overlays = [
    ...app.loadOverlayPatches('coexist', require.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml')),
    ...['webserver', 'web-runtime', 'web-startup', 'open-in-app', 'client-hmr', 'directory-picker', 'session-title-llm'].map(id => ({ id, disabled: true })),
    { id: 'connection', inject: [], config: { trustedHosts: [] } },
    { insert: [{ id: 'cli-test-fixture', name: fixturePlugin }] },
  ]
  const overlayFile = join(work, 'cli-overlay.yml'); await writeFile(overlayFile, JSON.stringify(overlays))
  const child = spawn(process.execPath, [join(installed, 'lib/bin.js'), '--profile', 'coexist', '--patch', overlayFile], { cwd: work, env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let bootReport: any; let graph: string[] = []; let childOutput = ''; const pending = new Map<number, (value: any) => void>(); let request = 0
  child.stdout.on('data', bytes => { childOutput += bytes }); child.stderr.on('data', bytes => { childOutput += bytes })
  child.on('message', (message: any) => { if (message.ready) { bootReport = message; selectedSession = message.sessionId; graph = message.graph } else { graph = message.graph; pending.get(message.id)?.(message); pending.delete(message.id) } })
  ctx = { clientModules: { graph: () => ({ entries: graph.map(id => ({ id })) }) }, loader: { await: async () => {} }, fiber: { dispose: async () => { child.kill('SIGINT'); await new Promise<void>(ok => { if (child.exitCode !== null) { ok(); return } const timer = setTimeout(() => child.kill('SIGKILL'), 8000); child.once('exit', () => { clearTimeout(timer); ok() }) }); await writeFile(join(work, 'cli.log'), childOutput) } } }
  await until(() => Boolean(bootReport)); assert.equal(bootReport.hasWebListener, false)
  const remove = (id: string) => new Promise<void>(ok => { const sequence = ++request; pending.set(sequence, () => ok()); child.send({ id: sequence, remove: id }) })
  await until(() => hubs.every(hub => hub.tunnel?.isOpen))
  assert.equal(hubs[0].metadata['x-dsh-control'], undefined); assert.equal(hubs[1].metadata['x-dsh-control'], undefined)
  assert.equal(hubs[1].metadata['x-dsh-session-directory'], '1'); assert.equal(hubs[0].metadata['x-dsh-session-directory'], undefined)
  assert.equal(hubs[2].metadata['x-dsh-control'], '2')
  assert.equal(hubs[2].metadata['x-dsh-control-capabilities'], 'management,admission,delegation')
  const controlInventory = await hubs[2].control.call('management.inventory', {})
  assert(Array.isArray(controlInventory.bundles))
  assert.equal(controlInventory.supported, true, 'The real native plugin manager is ready before Gateway activation')
  const ids = ctx.clientModules.graph().entries.map((entry: any) => entry.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ids.filter((id: string) => id === names[1]).length, 1, 'Only the session package contributes one navigation client')
  browser = await (process.env.DSH_NATIVE_BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true })
  // Each origin receives a real first visit, including native onboarding. Never
  // seed browser stores or dispatch editor events: pointer/keyboard input must
  // reach the actual editor and its native persisted conversation store.
  for (const hub of hubs) {
    const context = await browser.newContext()
    const page = await context.newPage(); page.setDefaultTimeout(15000)
    let events: Awaited<ReturnType<typeof openPluginEvents>> | undefined
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    const draft = `Unsent coexist draft for fixture ${hub.index}`
    const url = `http://127.0.0.1:${hub.port}/${hub.index === 1 ? '?gatewayIntent=fixture-intent' : ''}`
    try {
      await page.goto(url, { waitUntil: 'networkidle' })
      const welcome = page.getByRole('button', { name: 'Continue', exact: true })
      if (hub.index === 0) {
        await welcome.waitFor({ state: 'visible' }); await welcome.click(); await welcome.waitFor({ state: 'hidden' })
      }
      // Upstream WelcomeNoticeStore persists loopback acknowledgement in the
      // shared Runtime's ui-settings-general.welcomeNoticeVersion. Later Hub
      // origins must reach the next real onboarding step without re-acknowledge.
      if (require('@deepseek-ai/dsh-web-frontend/package.json').version === '0.2.1-rc.2') {
        const onboarding = page.getByText('Get started', { exact: true })
        await onboarding.waitFor({ state: 'visible' }); assert.equal(await welcome.isVisible(), false)
        await page.keyboard.press('Escape'); await onboarding.waitFor({ state: 'hidden' })
      } else {
        const configureLater = page.getByRole('button', { name: 'Configure later', exact: true })
        await configureLater.waitFor({ state: 'visible' }); assert.equal(await welcome.isVisible(), false)
        await configureLater.click()
      }
      const editor = page.locator('[contenteditable="true"]').first()
      await editor.waitFor({ state: 'visible' })
      if (hub.index === 1) await page.locator(`#gateway-session-intent[data-state="opened"][data-session-id="${selectedSession}"]`).waitFor()
      else {
        assert.equal(await page.locator('#gateway-session-intent').count(), 0)
        const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/create')
        await page.getByRole('button', { name: /^New session$/i }).first().click()
        const envelope = await (await created).json(); assert.equal(envelope.result?.ok, true)
        await page.locator(`[data-conversation-session="${envelope.result.value.sessionId}"]`).waitFor()

      }
      // Wait for the native new-session/onboarding requests to settle before input.
      await page.waitForLoadState('networkidle')
      const snapshot = () => page.evaluate((text: string) => ({
        conversations: [...document.querySelectorAll('[data-conversation-session]')].map(element => element.getAttribute('data-conversation-session')),
        mirrors: Object.entries(localStorage).filter(([key, raw]) => {
          if (!key.startsWith('dsh.conversation.')) return false
          try { return (typeof JSON.parse(raw).draft === 'string' ? JSON.parse(raw).draft : JSON.parse(raw).draft?.text) === text } catch { return false }
        }).map(([key, raw]) => ({ key, draft: JSON.parse(raw).draft })),
      }), draft)
      const box = await editor.boundingBox(); assert(box, 'Native editor has a pointer target')
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await page.waitForFunction(() => document.activeElement?.matches('[contenteditable="true"]'))
      assert(await editor.evaluate(element => element === document.activeElement || element.contains(document.activeElement)), 'Pointer focuses the native editor')
      await page.keyboard.type(draft, { delay: 15 })
      assert.equal((await editor.innerText()).trim(), draft)
      await page.waitForFunction((text: string) => Object.entries(localStorage).some(([key, raw]) => {
        if (!key.startsWith('dsh.conversation.')) return false
        try { return (typeof JSON.parse(raw).draft === 'string' ? JSON.parse(raw).draft : JSON.parse(raw).draft?.text) === text } catch { return false }
      }), draft)
      const before = await snapshot()
      assert.equal(before.conversations.length, 1, 'Exactly one native conversation is visible')
      assert.equal(before.mirrors.length, 1, 'Exactly one native conversation mirror contains this unsent draft')
      assert.equal(before.mirrors[0]!.key, `dsh.conversation.${before.conversations[0]}`, 'The native mirror belongs to the visible conversation')
      if (hub.index === 1) assert.deepEqual(before.conversations, [selectedSession], 'Session navigation opens the exact fixture conversation')
      const beforeSummary = (await readSessionList(page)).find((item: { sessionId: string }) => item.sessionId === before.conversations[0])
      assert(beforeSummary?.blank, 'The fixture conversation has no submitted turn')
      events = await openPluginEvents(hub.port)
      const eventGraph = events.graph
      const generation = hub.generations, muxGeneration = hub.muxGenerations, oldTunnel = hub.tunnel
      const browserUrlBeforeDisconnect = page.url(), browserDocument = await page.evaluate(() => performance.timeOrigin)
      const otherTunnels = hubs.filter(other => other !== hub).map(other => ({ hub: other, tunnel: other.tunnel }))
      await until(() => hub.muxSockets.clients.size > 0 && hub.sseResponses.size > 0)
      const disconnectedAt = Date.now(), severedSseStreams = hub.sseResponses.size, severedMuxes = hub.muxSockets.clients.size
      // This fixture owns all these sockets. Leave the HTTP server, Runtime,
      // other Hub connections and the browser page alive so normal reconnect
      // creates a fresh connector generation and recovers native streams.
      oldTunnel.close()
      for (const ws of [...hub.agentSockets.clients, ...hub.muxSockets.clients]) ws.terminate()
      for (const response of hub.sseResponses) response.destroy()
      assert.equal(oldTunnel.isOpen, false)
      await events.waitForDisconnect()
      await until(() => hub.generations > generation && hub.tunnel.isOpen)
      const connectorRecoveryMs = hub.lastConnectedAt - disconnectedAt
      await page.waitForFunction(async (expected: string) => {
        try {
          const response = await fetch('/api/session/list', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session/list', payload: { args: { _request: {} } } }), signal: AbortSignal.timeout(2000) })
          const body = await response.json()
          return response.ok && body.result?.ok === true && body.result.value.items.some((item: { sessionId: string }) => item.sessionId === expected)
        } catch { return false }
      }, selectedSession, { timeout: 20000 })
      await until(() => hub.muxGenerations > muxGeneration && hub.muxSockets.clients.size > 0)
      const browserMuxRecoveryMs = hub.lastMuxAt - disconnectedAt
      await events.close(); events = await openPluginEvents(hub.port)
      assert.deepEqual(events.graph, eventGraph, 'The fresh native SSE channel returns the same Runtime graph')
      const nativeStreamsRecoveryMs = Date.now() - disconnectedAt
      for (const other of otherTunnels) assert(other.hub.tunnel === other.tunnel && other.tunnel.isOpen, 'Disconnect is isolated to its owned Hub connection')
      await editor.waitFor({ state: 'visible' })
      await page.waitForFunction((text: string) => [...document.querySelectorAll<HTMLElement>('[contenteditable="true"]')].some(element => element.innerText.trim() === text), draft)
      assert.deepEqual(await snapshot(), before, 'The same browser conversation and exact native draft mirror survive carrier recovery')
      assert.equal((await editor.innerText()).trim(), draft, 'The unsent editor text survives without navigation/reload')
      const afterSummary = (await readSessionList(page)).find((item: { sessionId: string }) => item.sessionId === before.conversations[0])
      assert.equal(afterSummary?.blank, beforeSummary.blank, 'No turn was submitted over HTTP or native mux')
      assert.equal(hub.promptRequests, 0, 'No prompt is submitted by the draft/reconnect check')
      assert.equal(page.url(), browserUrlBeforeDisconnect, 'Reconnect keeps the existing browser URL after native intent consumption')
      assert.equal(await page.evaluate(() => performance.timeOrigin), browserDocument, 'Reconnect keeps the existing browser document without reload')
      assert.equal(errors.length, 0, errors.join('\n'))
      browserRecovery.push({ connection: ['base', 'session', 'control'][hub.index], firstVisitContinue: hub.index === 0, welcomeState: hub.index === 0 ? 'normally-acknowledged' : 'shared-runtime-already-acknowledged', pointerKeyboardDraft: true,
        nativeDraftMirrorBeforeDisconnect: true, exactConversationRetained: true, unsentDraftRetained: true, connectorGenerationAdvanced: true,
        nativeReadsRecovered: true, nativeMuxRecovered: true, nativePluginEventsRecovered: true, oldPluginEventStreamEnded: true, activeSessionRemainedBlank: true, otherConnectionsPreserved: true, navigation: hub.index === 1 ? 'selected-session' : 'native-new-session', severedSseStreams, severedMuxes, connectorRecoveryMs, browserMuxRecoveryMs, nativeStreamsRecoveryMs, assertionCompletionMs: Date.now() - disconnectedAt })
      await writeFile(join(work, 'browser-recovery.json'), JSON.stringify(browserRecovery, null, 2))
    } catch (error) {
      await writeFile(join(work, `browser-${hub.index}-failure.json`), JSON.stringify({ error: String(error), body: await page.locator('body').innerText(), snapshot: await snapshotForFailure(page), errors }, null, 2))
      await page.screenshot({ path: join(work, `browser-${hub.index}-failure.png`), fullPage: true })
      throw error
    } finally { await events?.close(); await context.close() }
  }
  const baseTunnel = hubs[0].tunnel, sessionTunnel = hubs[1].tunnel
  await remove('gateway-node-control'); await ctx.loader.await(); await until(() => !hubs[2].tunnel.isOpen)
  assert(baseTunnel.isOpen && sessionTunnel.isOpen)
  await remove('gateway-node-session'); await ctx.loader.await(); await until(() => !hubs[1].tunnel.isOpen)
  assert(baseTunnel.isOpen)
  await until(() => !ctx.clientModules.graph().entries.some((entry: any) => entry.id === names[1]))
  for (const connection of connections) assert.equal(await readFile(connection.connectionFile, 'utf8'), connection.original)
  // npm traverses a symlinked namespace while pruning. Detach this fixture-only
  // SDK projection before mutation so uninstall can never touch the SDK source.
  const nativeIndex = require.resolve('@deepseek-ai/dsh-web-frontend/package.json')
  const nativeManifestBefore = await readFile(nativeIndex, 'utf8')
  await unlink(join(profile, 'node_modules/@deepseek-ai'))
  await promisify(execFile)('npm', ['uninstall', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', names[1], names[2]], { cwd: profile, timeout: 120000 })
  await symlink(dirname(dirname(require.resolve('@deepseek-ai/dsh-client-modules/package.json'))), join(profile, 'node_modules/@deepseek-ai'))
  assert.equal(await readFile(nativeIndex, 'utf8'), nativeManifestBefore, 'Uninstall leaves the isolated upstream SDK unchanged')
  const after = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.equal(after.dependencies[names[0]], manifest.dependencies[names[0]])
  assert.equal(after.dependencies[names[1]], undefined); assert.equal(after.dependencies[names[2]], undefined)
  assert.equal((await baseTunnel.fetch(new Request('http://native/'))).status, 200)
  const report = { ok: true, runtimeCount: 1, officialDependencyAliases: true, sequentialOfficialPluginInstall: true, installedArchiveContentVerified: true, officialCliBoot: true, hoistedNodeLinker: true, repairedExistingHoistedInstall: true, threePackagedConnections: true, baseNativeUI: true, sessionNavigation: true, controlOnlyOnControlConnection: true, configuredDelegationCapability: true, uniqueClientGraph: true, isolatedUninstall: true, baseConnectionPreserved: true, browserRecovery, unsentDraftOnly: true, browser: process.env.DSH_NATIVE_BROWSER ?? 'chromium', overlay: 'loopback carrier fixture', artifacts: work }
  await writeFile(join(work, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
} finally {
  await browser?.close(); await ctx?.fiber.dispose()
  for (const hub of hubs) { hub.control?.close(); hub.tunnel?.close(); for (const ws of [...hub.agentSockets.clients, ...hub.muxSockets.clients]) ws.terminate(); hub.agentSockets.close(); hub.muxSockets.close(); await new Promise<void>(ok => hub.server.close(ok)) }
}
