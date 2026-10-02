/**
 * Run the published complete Runtime without its Web listener, then open its
 * unmodified browser via an outbound GatewayTunnel. All state is temporary.
 * DSH_NATIVE_ROOT=<installed package tree> tsx <this file>
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import WebSocket, { WebSocketServer } from 'ws'
import { chromium } from 'playwright'
import { GatewayTunnel, serveSurface } from '@k1412/dsh-gateway-transport'
import { createRuntimeSurface, type RuntimeContext } from '../src/runtime.ts'

const installed = process.env.DSH_NATIVE_ROOT
if (!installed) throw new Error('Set DSH_NATIVE_ROOT to an installed DSH 0.1.7-rc.2 package tree')
const work = await mkdtemp(join(tmpdir(), 'dsh-native-browser-'))
process.env.DSH_HOME = join(work, 'home')
process.env.DSH_TELEMETRY_DISABLED = '1'
const require = createRequire(join(installed, 'package.json'))
const load = async (name: string) => import(pathToFileURL(require.resolve(name)).href)
const app = await load('@deepseek-ai/dsh-app-boot')
await writeFile(join(work, 'cordis.yml'), '[]\n')
await symlink(join(installed, 'node_modules'), join(work, 'node_modules'))
const patches = [
  ...app.loadOverlayPatches('gateway-smoke', require.resolve('@deepseek-ai/dsh-base/cordis.patch.yml')),
  ...app.loadOverlayPatches('gateway-smoke', require.resolve('@deepseek-ai/dsh-web-app/cordis.patch.yml')),
  ...app.loadOverlayPatches('gateway-smoke', require.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml')),
  { id: 'webserver', disabled: true }, { id: 'web-runtime', disabled: true }, { id: 'web-startup', disabled: true },
  { id: 'open-in-app', disabled: true }, { id: 'client-hmr', disabled: true },
  { id: 'connection', inject: [], config: { trustedHosts: [] } },
  { id: 'directory-picker', disabled: true },
  { insert: [{ id: 'qa-directory-browse-host', name: '@deepseek-ai/dsh-host-directory-picker-browse' }, { id: 'qa-directory-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' }] },
]
const ctx = await app.boot('gateway-smoke', join(work, 'cordis.yml'), patches, undefined, pathToFileURL(join(installed, 'package.json')).href)
const { LlmAdapter } = await load('@deepseek-ai/dsh-llm')
class FixtureAdapter extends LlmAdapter {
  providerInfo(provider: string) { return { id: provider, name: 'Gateway smoke fixture' } }
  async listModels(provider: string) { return [{ provider, id: 'fixture-a', name: 'Fixture model A' }, { provider, id: 'fixture-b', name: 'Fixture model B' }] }
  async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Native gateway smoke reply' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Native gateway smoke reply' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
ctx.llm.registerAdapter(['gateway-smoke'], new FixtureAdapter())
assert.equal(ctx.webServer, undefined, 'The native Web listener must remain absent')
const entries = ctx.clientModules.graph().entries as Array<{ id: string }>
assert(entries.length > 50, 'Load the complete installed native plugin roster')
assert(!entries.some((entry) => entry.id.includes('dsh-hub-client-ui')), 'Do not load the old Hub business UI')
const { surface } = await createRuntimeSurface(ctx as RuntimeContext, pathToFileURL(join(installed, 'package.json')).href)
let tunnel: GatewayTunnel | undefined
const browserMuxes = new WebSocketServer({ noServer: true })
const nodes = new WebSocketServer({ noServer: true })
const hub = createServer((request, response) => {
  const controller = new AbortController()
  response.on('close', () => { if (!response.writableEnded) controller.abort() })
  void (async () => {
    assert(tunnel)
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : Readable.toWeb(request) as ReadableStream<Uint8Array>
    const upstream = await tunnel.fetch(new Request(`http://native${request.url}`, {
      method: request.method, headers: request.headers as Record<string, string>,
      ...(body ? { body, duplex: 'half' } : {}), signal: controller.signal,
    }))
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers))
    if (!upstream.body) response.end()
    else Readable.fromWeb(upstream.body as never).pipe(response)
  })().catch((error) => { response.writeHead(502); response.end(String(error)) })
})
hub.on('upgrade', (request, socket, head) => {
  if (request.url === '/_node') nodes.handleUpgrade(request, socket, head, (ws) => { tunnel = new GatewayTunnel(ws) })
  else if (request.url === '/api/remote.mux') browserMuxes.handleUpgrade(request, socket, head, (ws) => {
    assert(tunnel)
    const controller = new AbortController()
    const mux = tunnel.openMux((text) => { if (ws.readyState === WebSocket.OPEN) ws.send(text) }, controller.signal)
    ws.on('message', (bytes) => { mux.send(bytes.toString()) })
    ws.on('close', () => { controller.abort(); mux.close() })
  })
  else socket.destroy()
})
await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve))
const port = (hub.address() as { port: number }).port
const node = new WebSocket(`ws://127.0.0.1:${port}/_node`)
await new Promise<void>((resolve, reject) => { node.once('open', resolve); node.once('error', reject) })
const serving = serveSurface(node, surface)
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1 })
page.setDefaultTimeout(8000)
const errors: string[] = []
const limitations: string[] = []
page.on('pageerror', (error) => { errors.push(error.message) })
page.on('console', (message) => { if (message.type() === 'error') {
  if (message.location().url.endsWith('/open-in-app/apps')) limitations.push(message.text())
  else errors.push(message.text())
} })
page.on('requestfailed', (request) => { errors.push(`${request.url()} ${request.failure()?.errorText}`) })
page.on('response', (response) => { if (response.status() >= 400) {
  if (response.url().endsWith('/open-in-app/apps') && response.status() === 404) limitations.push('Open in App uses a listener-only upstream endpoint and is unavailable remotely')
  else errors.push(`HTTP ${response.status()}: ${response.url()}`)
} })
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).click()
  await page.waitForTimeout(500)
  await page.getByRole('menuitem', { name: 'Default workspace', exact: true }).click()
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: /Access mode, current:/ }).click()
  await page.getByRole('menuitem', { name: 'Full access', exact: true }).click()
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Enable Full access', exact: true }).click()
  await page.getByRole('button', { name: 'Access mode, current: Full access', exact: true }).waitFor()
  await page.getByText('DeepSeek-V41-Flash', { exact: true }).click()
  await page.getByText('Model', { exact: true }).click()
  await page.getByText('Fixture model A', { exact: true }).click()
  await page.locator('textarea,[contenteditable="true"]').first().fill('Native gateway prompt')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.getByText('Native gateway smoke reply', { exact: true }).first().waitFor({ timeout: 15000 })
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByText('Native gateway smoke reply', { exact: true }).first().waitFor({ timeout: 15000 })
  const body = await page.locator('body').innerText()
  await page.screenshot({ path: join(work, 'native-mobile.png'), fullPage: true })
  await writeFile(join(work, 'browser-report.json'), JSON.stringify({ entries: entries.length, errors, limitations, body }, null, 2))
  assert(!body.includes('Failed to load plugins'), 'Native plugin boot must succeed')
  assert.equal(errors.length, 0, `Unexpected native browser errors: ${errors.join('\n')}`)
  assert(await page.locator('textarea,[contenteditable="true"]').count() > 0, 'Native mobile composer must be present')
  process.stdout.write(`${JSON.stringify({ ok: true, nativeWebListener: false, officialClientPlugins: entries.length, mobileComposer: true, fullAccess: true, modelSelection: true, prompt: true, historyAfterReload: true, limitations, artifacts: work })}\n`)
} catch (error) {
  await writeFile(join(work, 'failed-browser.txt'), `${await page.locator('body').innerText()}\n${JSON.stringify(errors)}`)
  await page.screenshot({ path: join(work, 'failed-mobile.png'), fullPage: true })
  process.stderr.write(`Native smoke failure artifacts: ${work}\n`)
  throw error
} finally {
  await browser.close()
  serving.close(); node.terminate(); tunnel?.close()
  for (const ws of nodes.clients) ws.terminate()
  for (const ws of browserMuxes.clients) ws.terminate()
  await new Promise<void>((resolve) => hub.close(() => resolve()))
  nodes.close(); browserMuxes.close()
  await ctx.fiber.dispose()
}
