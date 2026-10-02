/** Real rc.2 RPC, full official browser and two simultaneous Runtime owners. No paid model/network. */
import { createServer, request as httpRequest } from 'node:http'
import { Readable } from 'node:stream'
import { fork, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chromium, webkit } from 'playwright'
import { createGateway } from '../../gateway-server/src/server.ts'
import { nativeList } from '../src/native-rpc.ts'
const installed = process.env.DSH_NATIVE_ROOT
if (!installed) throw new Error('DSH_NATIVE_ROOT required')
const work = await mkdtemp(join(tmpdir(), 'dsh-directory-native-'))
const log = createWriteStream(join(work, 'runtimes.log'))
const listen = (server: ReturnType<typeof createServer>, port = 0) => new Promise<number>(ok => server.listen(port, '127.0.0.1', () => ok((server.address() as { port: number }).port)))
const reserve = async () => { const s = createServer(), port = await listen(s); await new Promise<void>(ok => s.close(() => ok())); return port }
const networks = { status: async () => { throw new Error('unused') }, endpoint: () => '', loginTailscale: async () => {} }
async function gateway(experiment: boolean) {
  const port = await reserve(), publicUrl = `http://hub.localhost:${port}`
  const hub = createGateway({ publicUrl, statePath: ':memory:', downloadsDirectory: work, installerPath: join(work, 'install.sh'), networks,
    nodeOrigin: id => `http://${id}.hub.localhost:${port}`, authenticateOperator: async req => req.headers['x-experiment-operator'] === 'yes', sessionDirectory: experiment })
  await listen(hub.publicServer, port); const privatePort = await listen(hub.privateServer)
  return { hub, port, privatePort, publicUrl }
}
const experiment = await gateway(true), baseline = await gateway(false)
const children: ChildProcess[] = []
const browserName = process.env.DSH_NATIVE_BROWSER ?? 'chromium'
if (!['chromium', 'webkit'].includes(browserName)) throw new Error('DSH_NATIVE_BROWSER must be chromium or webkit')
const browser = await (browserName === 'webkit' ? webkit : chromium).launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true,
  extraHTTPHeaders: { 'x-experiment-operator': 'yes' } })
const page = await context.newPage(); page.setDefaultTimeout(20_000)
const errors: string[] = []
await page.addInitScript(() => {
  document.addEventListener('securitypolicyviolation', event => {
    console.error(`CSP ${event.violatedDirective}: ${event.blockedURI}; ${event.sourceFile}:${event.lineNumber}`)
  })
})
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error' && !message.location().url.endsWith('/open-in-app/apps')) errors.push(message.text()) })
const timings: Record<string, number[]> = {}
async function timed<T>(name: string, op: () => Promise<T>): Promise<T> { const start = performance.now(); const result = await op(); (timings[name] ??= []).push(performance.now() - start); return result }
const pluginCounts: number[] = []
const nodes: Array<{ id: string; baselineId: string; child: ChildProcess }> = []
const message = (child: ChildProcess, key: string): Promise<Record<string, unknown>> => new Promise((ok, fail) => {
  const timer = setTimeout(() => { cleanup(); fail(new Error(`Runtime ${key} timeout; see ${work}`)) }, 60_000)
  const got = (value: Record<string, unknown>) => { if (value[key]) { cleanup(); ok(value) } }
  const died = () => { cleanup(); fail(new Error(`Runtime exited; see ${work}`)) }
  const cleanup = () => { clearTimeout(timer); child.off('message', got); child.off('exit', died) }
  child.on('message', got); child.once('exit', died)
})
const request = (g: typeof experiment, path: string, authorized = true): Promise<Response> => new Promise((ok, fail) => {
  const req = httpRequest({ hostname: '127.0.0.1', port: g.port, path, headers: { host: new URL(g.publicUrl).host,
    ...(authorized ? { 'x-experiment-operator': 'yes' } : {}) } }, res => ok(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status: res.statusCode })))
  req.on('error', fail); req.end()
})
let passed = false
try {
  for (const label of ['alpha', 'beta']) {
    const nodeWork = join(work, label); await mkdir(nodeWork)
    await writeFile(join(nodeWork, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2024', module: 'ESNext', moduleResolution: 'Bundler', paths: {} } }))
    const connections = [experiment, baseline].map(g => {
      const invitation = g.hub.store.invite('tailcat', 'local-fixture', label), credential = randomBytes(32).toString('base64url')
      const n = g.hub.store.enroll({ inviteToken: invitation.token, clientId: randomBytes(16).toString('hex'), credential, name: label, dshVersion: '0.1.7-rc.2', runtimeId: `runtime-${label}` })
      return { id: n.id, credential, url: `ws://127.0.0.1:${g.privatePort}/connect?nodeId=${n.id}` }
    })
    const child = fork(resolve('packages/hub/gateway-session-directory/tests/native-runtime-worker.mts'), [], {
      execArgv: ['--import', 'tsx'], env: { ...process.env, DSH_NATIVE_ROOT: installed, DSH_TEST_WORK: nodeWork, DSH_TEST_LABEL: label,
        TSX_TSCONFIG_PATH: join(nodeWork, 'tsconfig.json'), DSH_TEST_CONNECTIONS: JSON.stringify(connections) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    child.stdout?.pipe(log, { end: false }); child.stderr?.pipe(log, { end: false }); children.push(child)
    const ready = await message(child, 'ready'); assert(Number(ready.entries) >= 64); pluginCounts.push(Number(ready.entries)); assert(ready.plugin, 'Shipped experiment client must be registered')
    nodes.push({ id: connections[0]!.id, baselineId: connections[1]!.id, child })
  }
  assert.equal((await request(experiment, '/sessions', false)).status, 401)
  assert.equal((await request(baseline, '/sessions')).status, 404)
  assert(!(await (await request(baseline, '/')).text()).includes('href="/sessions"'))
  for (let i = 0; i < 15; i++) {
    await timed('baseline-index', async () => { const response = await request(baseline, '/'); assert.equal(response.status, 200); await response.text() })
    await timed('directory-page', async () => {
      const r = await request(experiment, '/sessions'); assert.equal(r.status, 200)
      const html = await r.text(); assert(html.includes('Directory target alpha') && html.includes('Directory target beta'))
    })
    await timed('native-list-two-concurrent', async () => {
      const values = await Promise.all(nodes.map(n => nativeList(experiment.hub.peers.get(n.id)!.tunnel, `http://${n.id}.hub.localhost:${experiment.port}`, AbortSignal.timeout(5000))))
      for (const value of values) assert((value as { items: { sessionId: string }[] }).items.some(r => r.sessionId === 'directory-shared-session'))
    })
  }
  for (const [i, node] of nodes.entries()) {
    const label = i === 0 ? 'alpha' : 'beta'
    await timed('baseline-native-browser', async () => {
      await page.goto(`${baseline.publicUrl}/open/${node.baselineId}`, { waitUntil: 'domcontentloaded' })
      await page.locator('textarea,[contenteditable="true"]').first().waitFor()
      const welcome = page.getByRole('button', { name: 'Continue', exact: true }); if (await welcome.isVisible()) await welcome.click()
    })
    await page.goto(`${experiment.publicUrl}/sessions`, { waitUntil: 'domcontentloaded' })
    await timed('directory-click-native-ready', async () => {
      await page.getByRole('link', { name: `Directory target ${label}`, exact: true }).click()
      await page.locator('#gateway-session-intent[data-state="opened"]').waitFor()
      assert.equal(await page.locator('#gateway-session-intent').getAttribute('data-session-id'), 'directory-shared-session')
      assert(new URL(page.url()).hostname.startsWith(node.id))
    })
    const welcome = page.getByRole('button', { name: 'Continue', exact: true }); if (await welcome.isVisible()) await welcome.click()
    await page.getByRole('button', { name: /Access mode, current:/ }).click()
    await page.getByRole('menuitem', { name: 'Full access', exact: true }).click()
    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: 'Enable Full access', exact: true }).click()
    await page.getByText('DeepSeek-V41-Flash', { exact: true }).click()
    await page.getByText('Model', { exact: true }).click()
    await page.getByText('Fixture model A', { exact: true }).click()
    await page.locator('textarea,[contenteditable="true"]').first().fill(`Directory historical prompt ${label}`)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByText(`Native historical reply ${label}`, { exact: true }).first().waitFor()
    for (let repeat = 0; repeat < 3; repeat++) {
      await timed('baseline-history-open', async () => {
        await page.goto(`${baseline.publicUrl}/open/${node.baselineId}`, { waitUntil: 'domcontentloaded' })
        await page.getByText(`Native historical reply ${label}`, { exact: true }).first().waitFor()
      })
      await page.goto(`${experiment.publicUrl}/sessions`, { waitUntil: 'domcontentloaded' })
      await timed('exact-history-click', async () => {
        await page.getByRole('link', { name: `Directory target ${label}`, exact: true }).click()
        await page.locator('#gateway-session-intent[data-state="opened"]').waitFor()
        await page.getByText(`Native historical reply ${label}`, { exact: true }).first().waitFor()
        assert(!(await page.locator('body').innerText()).includes(`Native historical reply ${label === 'alpha' ? 'beta' : 'alpha'}`))
      })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.getByText(`Native historical reply ${label}`, { exact: true }).first().waitFor()
    }
    await page.screenshot({ path: join(work, `native-mobile-${label}.png`), fullPage: true })
  }
  for (let cycle = 0; cycle < 5; cycle++) {
    await page.goto(`${experiment.publicUrl}/sessions`, { waitUntil: 'domcontentloaded' })
    const node = nodes[0]!
    const staleGeneration = experiment.hub.peers.get(node.id)!.generation
    const offline = message(node.child, 'disconnected'); node.child.send({ command: 'disconnect' }); await offline
    await new Promise(ok => setTimeout(ok, 50))
    await timed('partial-offline-page', async () => {
      const html = await (await request(experiment, '/sessions')).text()
      assert(html.includes('offline') && html.includes('Directory target beta') && !html.includes('Directory target alpha'))
    })
    const online = message(node.child, 'reconnected'); node.child.send({ command: 'reconnect' }); await online
    assert.equal((await request(experiment, `/open/${node.id}?session=directory-shared-session&runtime=runtime-alpha&generation=${staleGeneration}`)).status, 409)
    await timed('reconnect-directory', async () => {
      const html = await (await request(experiment, '/sessions')).text()
      assert(html.includes('Directory target alpha') && html.includes('Directory target beta'))
    })
    await page.goto(`${experiment.publicUrl}/sessions`, { waitUntil: 'domcontentloaded' })
    await timed('reconnect-history-click', async () => {
      await page.getByRole('link', { name: 'Directory target alpha', exact: true }).click()
      await page.locator('#gateway-session-intent[data-state="opened"]').waitFor()
      await page.getByText('Native historical reply alpha', { exact: true }).first().waitFor()
    })
  }
  const first = nodes[0]!, peer = experiment.hub.peers.get(first.id)!
  await assert.rejects(nativeList(peer.tunnel, `http://${first.id}.hub.localhost:${experiment.port}`, AbortSignal.timeout(5000), 64), /limit/)
  const controller = new AbortController()
  const cancelled = nativeList(peer.tunnel, `http://${first.id}.hub.localhost:${experiment.port}`, controller.signal)
  controller.abort(); await assert.rejects(cancelled)
  await page.goto(`${experiment.publicUrl}/open/${first.id}?session=missing-session&runtime=runtime-alpha&generation=${peer.generation}`, {waitUntil:'domcontentloaded'})
  await page.locator('#gateway-session-intent[data-state="error"]').waitFor()
  await page.goto(`${experiment.publicUrl}/sessions`, { waitUntil: 'domcontentloaded' })
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile directory must not overflow horizontally')
  // Playwright WebKit screenshot preparation injects an inline `body {}`
  // stylesheet, violating this page's strict CSP. Keep CSP/error assertions
  // unchanged; capture HTML instead of that optional image on WebKit.
  if (browserName === 'chromium') await page.screenshot({ path: join(work, 'directory-mobile.png'), fullPage: true })
  else await writeFile(join(work, 'directory-mobile.html'), await page.content())
  assert.equal(errors.length, 0, errors.join('\n'))
  for (const [name, values] of Object.entries(timings)) { const budget = name.includes('browser') || name.includes('history') || name.includes('ready') ? 5000 : 3000; assert(Math.max(...values) < budget, `${name} exceeded ${budget} ms local budget`) }
  passed = true
} catch (error) {
  await writeFile(join(work, 'failure.txt'), `${String(error)}\n${await page.locator('body').innerText()}\n${JSON.stringify(errors)}`)
  await page.screenshot({ path: join(work, 'failure.png'), fullPage: true })
  throw error
} finally {
  const metrics = Object.fromEntries(Object.entries(timings).map(([name, times]) => { times.sort((a,b)=>a-b); return [name, { samples: times.length, p50Ms: times[Math.ceil(times.length*.5)-1], p95Ms: times[Math.ceil(times.length*.95)-1], maxMs: times.at(-1) }] }))
  const report = { passed, browser: browserName, actualNativeRuntime: true, realBrowser: true, actualOverlay: false,
    baseline: 'feature disabled on the same candidate gateway/node package; not the deployed initial release',
    localBudgetsMs: { rpcAndDirectory: 3000, nativeBrowserAndHistory: 5000 },
    model: 'fixture-no-cost', officialClientPluginsPerRuntime: pluginCounts.map(n => n - 1), experimentalClientPluginsPerRuntime: 1, runtimeCount: 2, namedGatewayInstancesPerRuntime: 2, simultaneousHubConnectionsPerRuntime: 2, metrics, errors }
  await writeFile(join(work, 'browser-report.json'), JSON.stringify(report, null, 2))
  if (process.env.DSH_DIRECTORY_REPORT) { await mkdir(resolve(process.env.DSH_DIRECTORY_REPORT, '..'), {recursive:true}); await writeFile(process.env.DSH_DIRECTORY_REPORT, JSON.stringify(report, null, 2)) }
  process.stdout.write(JSON.stringify({ passed, artifacts: work })+'\n')
  await browser.close()
  for (const child of children) { if (child.connected) child.send({ command: 'stop' }); setTimeout(() => child.kill('SIGKILL'), 3000).unref() }
  await experiment.hub.close(); await baseline.hub.close(); log.end()
}
