#!/usr/bin/env node

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { chromium } from 'playwright'

const repositoryRoot = resolve(import.meta.dirname, '..')
const distRoot = resolve(process.env.DSH_HUB_DIST ?? join(repositoryRoot, 'apps/hub-web/dist'))
const outputRoot = resolve(process.env.DSH_HUB_SCREENSHOT_DIR ?? join(repositoryRoot, 'docs/assets'))

function browserHost() {
  if (process.env.DSH_HUB_SCREENSHOT_HOST !== undefined) return process.env.DSH_HUB_SCREENSHOT_HOST
  for (const addresses of Object.values(networkInterfaces())) {
    const address = addresses?.find(candidate => candidate.family === 'IPv4' && !candidate.internal)
    if (address !== undefined) return address.address
  }
  throw new Error('no non-loopback IPv4 address; set DSH_HUB_SCREENSHOT_HOST')
}

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.woff2', 'font/woff2'],
])

const now = Date.now()
const outbox = { records: 0, bytes: 0, maxRecords: 10_000, maxBytes: 64 * 1024 * 1024 }
const nodes = [
  { nodeId: 'nas-home', displayName: 'Home NAS', status: 'active', online: true },
  { nodeId: 'workstation', displayName: 'Workstation', status: 'active', online: true },
  { nodeId: 'macbook', displayName: 'MacBook', status: 'active', online: false },
].map((node, index) => ({
  ...node,
  createdAt: now - (index + 1) * 86_400_000,
  lastSeenAt: now - (node.online ? 4_000 + index * 1_000 : 3_600_000),
  transport: {
    reportedAt: node.online ? now - 3_000 : now - 3_600_000,
    lastPongAt: node.online ? now - 2_000 : now - 3_600_000,
    pressure: node.online ? 'normal' : 'unknown',
    nodeOutbox: node.online ? outbox : undefined,
    hubOutbox: outbox,
    droppedStreamFramesTotal: 0,
    droppedStreams: [],
    controlRequests: { pending: 0, timeoutsLast24Hours: 0 },
  },
}))
const runtimes = nodes.map((node, index) => ({
  nodeId: node.nodeId,
  runtimeId: 'default',
  dshVersion: '0.1.0',
  connectorVersion: '0.2.0',
  online: node.online,
  lastSeenAt: node.lastSeenAt,
  capabilities: [{ name: 'dsh.web', version: '1', operations: [{ name: 'fetch' }] }],
  order: index,
}))

function indexDocument(body) {
  return body.replace('<meta name="dsh-settings-access" content="authenticated-control-plane" />', '')
}

async function staticResponse(request, response) {
  const url = new URL(request.url ?? '/', 'http://hub.demo.test')
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
  const candidate = resolve(distRoot, relative)
  const rootPrefix = distRoot.endsWith(sep) ? distRoot : `${distRoot}${sep}`
  let file = candidate.startsWith(rootPrefix) ? candidate : join(distRoot, 'index.html')
  try {
    if (!(await stat(file)).isFile()) file = join(distRoot, 'index.html')
  } catch {
    file = join(distRoot, 'index.html')
  }
  let body = await readFile(file)
  if (file.endsWith('index.html')) body = Buffer.from(indexDocument(body.toString('utf8')))
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': contentTypes.get(extname(file)) ?? 'application/octet-stream',
  })
  response.end(body)
}

async function run() {
  await stat(join(distRoot, 'index.html'))
  const server = createServer((request, response) => {
    void staticResponse(request, response).catch((error) => {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(error instanceof Error ? error.message : String(error))
    })
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '0.0.0', resolveListen)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('screenshot server has no TCP port')

  const origin = `http://${browserHost()}:${String(address.port)}`
  const browser = await chromium.launch({
    headless: true,
    args: [`--unsafely-treat-insecure-origin-as-secure=${origin}`],
  })
  const installRoutes = async (page) => {
    if (process.env.DSH_HUB_SCREENSHOT_DEBUG === '1') {
      page.on('pageerror', error => console.error(`browser page error: ${error.message}`))
      page.on('console', message => {
        if (message.type() === 'error') console.error(`browser console error: ${message.text()}`)
      })
    }
    await page.route('**/hub/v1/nodes', route => route.fulfill({
      contentType: 'application/json', body: JSON.stringify({ nodes, runtimes }),
    }))
    await page.route('**/hub/v1/enrollments', route => route.fulfill({
      contentType: 'application/json', body: JSON.stringify({ enrollments: [] }),
    }))
  }
  const installBrowserPolyfills = async (context) => {
    await context.addInitScript(() => {
      if (typeof globalThis.crypto.randomUUID !== 'function') {
        Object.defineProperty(globalThis.crypto, 'randomUUID', {
          value: () => '10000000-4000-4000-8000-100000000001',
        })
      }
    })
  }
  const dismissWelcome = async (page) => {
    const welcome = page.getByRole('dialog', { name: '内测声明' })
    if (await welcome.count() === 0) return
    await welcome.getByRole('button', { name: '继续', exact: true }).click()
    await welcome.waitFor({ state: 'hidden' })
  }

  try {
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
    await installBrowserPolyfills(desktop)
    const page = await desktop.newPage()
    await installRoutes(page)
    await page.goto(`${origin}/?fixture&nodeId=nas-home&runtimeId=default`, { waitUntil: 'networkidle' })
    await dismissWelcome(page)
    await page.getByRole('button', { name: '设置', exact: true }).waitFor({ timeout: 20_000 })
    await page.screenshot({ path: join(outputRoot, 'overview.png') })

    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.getByRole('button', { name: 'Hub 节点' }).click()
    await settings.getByRole('heading', { name: '已登记节点' }).waitFor()
    await page.screenshot({ path: join(outputRoot, 'nodes.png') })
    await desktop.close()

    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
      locale: 'zh-CN',
    })
    await installBrowserPolyfills(mobile)
    const mobilePage = await mobile.newPage()
    await installRoutes(mobilePage)
    await mobilePage.goto(`${origin}/?fixture&nodeId=nas-home&runtimeId=default`, { waitUntil: 'networkidle' })
    await dismissWelcome(mobilePage)
    await mobilePage.getByText('探索未至之境', { exact: true }).waitFor({ timeout: 20_000 })
    await mobilePage.screenshot({ path: join(outputRoot, 'mobile.png') })
    await mobile.close()
  } finally {
    await browser.close()
    await new Promise(resolveClose => server.close(resolveClose))
  }
}

await run()
