#!/usr/bin/env node

/** Verify that the assembled Hub UI boots under its production script policy. */

import { createServer } from 'node:http'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, resolve, sep } from 'node:path'
import { chromium } from 'playwright'
import { HUB_CONTENT_SECURITY_POLICY } from '../packages/hub/hub-server/src/server.ts'

const repositoryRoot = resolve(import.meta.dirname, '..')
const staticRoot = resolve(repositoryRoot, 'apps', 'hub-web', 'dist')
const mediaTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
}
const interactionBudgetMs = Number(process.env.DSH_HUB_UI_INTERACTION_BUDGET_MS ?? 2_500)
if (!Number.isFinite(interactionBudgetMs) || interactionBudgetMs <= 0) {
  throw new Error('DSH_HUB_UI_INTERACTION_BUDGET_MS must be a positive number')
}
const timings = {}
const fixtureRuntimes = [
  { nodeId: 'fixture-node', runtimeId: 'fixture-runtime', dshVersion: 'fixture', connectorVersion: 'fixture', online: true, lastSeenAt: 1,
    capabilities: [{ name: 'dsh.web', version: '1.0.0', operations: [{ name: 'fetch' }] }] },
  { nodeId: 'fixture-second', runtimeId: 'desktop', dshVersion: 'fixture', connectorVersion: 'fixture', online: true, lastSeenAt: 1,
    capabilities: [{ name: 'dsh.web', version: '1.0.0', operations: [{ name: 'fetch' }] }] },
]
for (const runtime of fixtureRuntimes) runtime.capabilities.push({
  name: 'dsh.session-lifecycle', version: '1.0.0',
  operations: ['inventory', 'archive', 'unarchive', 'trash', 'restore', 'purge'].map(name => ({ name })),
})
const lifecycleRows = new Map(fixtureRuntimes.map((runtime, index) => [runtime.nodeId, [{
  sessionId: 'same-session', title: `Fixture conversation ${index === 0 ? 'A' : 'B'}`,
  workspacePath: `/projects/${index === 0 ? 'a' : 'b'}`, updatedAt: index + 1,
  running: false, eventSequence: 1, status: index === 0 ? 'active' : 'archived', purgeAvailable: true,
}]]))
const lifecycleCommands = new Map()
const lifecycleCalls = []

function lifecycleResult(input) {
  const rows = lifecycleRows.get(input.nodeId)
  if (!rows || !fixtureRuntimes.some(runtime => runtime.nodeId === input.nodeId && runtime.runtimeId === input.runtimeId)) {
    throw new Error('lifecycle fixture target mismatch')
  }
  lifecycleCalls.push(input)
  const payload = input.payload ?? {}
  if (input.operation === 'inventory') return { sessions: rows.filter(row => row.status === payload.status
    && `${row.title} ${row.workspacePath} ${row.sessionId}`.toLowerCase().includes((payload.query ?? '').toLowerCase())) }
  const row = rows.find(candidate => candidate.sessionId === payload.sessionId)
  if (!row) throw new Error('lifecycle fixture session missing')
  if (input.operation === 'archive') row.status = 'archived'
  else if (input.operation === 'unarchive') row.status = 'active'
  else if (input.operation === 'trash') { row.status = 'trash'; row.deletedAt = Date.now() }
  else if (input.operation === 'restore' || input.operation === 'purge') {
    if (payload.deletedAt !== row.deletedAt) throw new Error('lifecycle fixture trash generation mismatch')
    row.status = input.operation === 'purge' ? 'purged' : 'active'
  } else throw new Error('lifecycle fixture operation unknown')
  return { sessionId: row.sessionId, status: row.status, ...(row.deletedAt === undefined ? {} : { deletedAt: row.deletedAt }) }
}

function recordTiming(name, startedAt) {
  const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100
  timings[name] = elapsedMs
  if (elapsedMs > interactionBudgetMs) {
    throw new Error(`${name} exceeded the ${String(interactionBudgetMs)} ms UI regression budget: ${String(elapsedMs)} ms`)
  }
}

const hubDocument = await readFile(resolve(staticRoot, 'index.html'), 'utf8')
const bridgePosition = hubDocument.indexOf('<script src="/target-bridge.js"></script>')
const bootPosition = hubDocument.indexOf('<script src="/boot.js"></script>')
if (bridgePosition < 0 || bootPosition < 0 || bridgePosition >= bootPosition) {
  throw new Error('Hub target bridge must load before the official boot graph')
}
const targetBridge = await readFile(resolve(staticRoot, 'target-bridge.js'), 'utf8')
for (const marker of ['/api/', 'nodeId', 'runtimeId']) {
  if (!targetBridge.includes(marker)) throw new Error(`Hub target bridge is missing ${marker}`)
}
if (!hubDocument.includes('<meta name="dsh-settings-access" content="authenticated-control-plane" />')) {
  throw new Error('Hub Web is missing its authenticated Host-backed Settings marker')
}

function headers(response) {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Security-Policy', HUB_CONTENT_SECURITY_POLICY)
  response.setHeader('X-Content-Type-Options', 'nosniff')
}

async function staticPath(pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname
  const candidate = resolve(staticRoot, `.${requested}`)
  if (candidate !== staticRoot && !candidate.startsWith(`${staticRoot}${sep}`)) return undefined
  const metadata = await stat(candidate).catch(() => undefined)
  return metadata?.isFile() ? candidate : undefined
}

const server = createServer((request, response) => {
  void (async () => {
    headers(response)
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/manifest.webmanifest' && !request.headers.cookie?.includes('hub-fixture=authenticated')) {
      response.statusCode = 401
      response.end('manifest requires the browser login cookie')
      return
    }
    if (request.method === 'GET' && url.pathname === '/hub/v1/nodes') {
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.end(JSON.stringify({
        nodes: [
          { nodeId: 'fixture-node', displayName: 'Fixture NAS', status: 'active', online: true, createdAt: 1, lastSeenAt: 1 },
          { nodeId: 'fixture-second', displayName: 'Fixture Mac', status: 'active', online: true, createdAt: 1, lastSeenAt: 1 },
        ],
        runtimes: fixtureRuntimes,
      }))
      return
    }
    if (request.method === 'GET' && url.pathname === '/hub/v1/enrollments') {
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.end('{"enrollments":[]}')
      return
    }
    if (request.method === 'POST' && url.pathname === '/hub/v1/commands') {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (input.capability !== 'dsh.session-lifecycle') throw new Error('unsupported fixture capability')
      const result = lifecycleResult(input)
      const command = { commandId: `ui-lifecycle-${lifecycleCommands.size + 1}`, status: 'ok', result }
      lifecycleCommands.set(command.commandId, command)
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.end(JSON.stringify({ command }))
      return
    }
    const commandMatch = /^\/hub\/v1\/commands\/([^/]+)$/u.exec(url.pathname)
    if (commandMatch !== null && lifecycleCommands.has(commandMatch[1])) {
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.end(JSON.stringify(request.method === 'POST' ? { acknowledged: true } : { command: lifecycleCommands.get(commandMatch[1]) }))
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 503
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.end('{"error":"runtime fixture unavailable"}')
      return
    }
    const path = await staticPath(url.pathname)
    if (path === undefined) {
      response.statusCode = 404
      response.end('not found')
      return
    }
    const body = await readFile(path)
    response.statusCode = 200
    response.setHeader('Content-Type', mediaTypes[extname(path)] ?? 'application/octet-stream')
    response.setHeader('Content-Length', body.byteLength)
    response.end(request.method === 'HEAD' ? undefined : body)
  })().catch((error) => {
    response.statusCode = 500
    response.end(error instanceof Error ? error.message : String(error))
  })
})

await new Promise((resolveListen, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolveListen)
})
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('strict-CSP fixture did not bind TCP')

let browser
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const loginCookie = { name: 'hub-fixture', value: 'authenticated', url: `http://127.0.0.1:${address.port}` }
  await page.context().addCookies([loginCookie])
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.addInitScript(() => {
    globalThis.__hubCspViolations = []
    document.addEventListener('securitypolicyviolation', event => {
      globalThis.__hubCspViolations.push({
        blockedUri: event.blockedURI,
        directive: event.effectiveDirective,
        line: event.lineNumber,
        sample: event.sample,
        source: event.sourceFile,
      })
    })
  })
  const hubPluginRequest = page.waitForRequest(request => request.url().includes('/plugins/@k1412/dsh-hub-client-ui/client.js'))
  const directoryFlowRequest = page.waitForRequest(request => request.url().includes(
    '/plugins/@deepseek-ai/dsh-client-ui-directory-picker-browse/client.js',
  ))
  let startedAt = performance.now()
  await page.goto(`http://127.0.0.1:${address.port}/?nodeId=fixture-node&runtimeId=fixture-runtime`, {
    waitUntil: 'domcontentloaded',
  })
  await Promise.all([hubPluginRequest, directoryFlowRequest])
  await page.locator('#root').waitFor({ state: 'attached' })
  await page.waitForFunction(() => document.querySelector('#root')?.childElementCount !== 0)
  recordTiming('desktopBootMs', startedAt)
  // Ask Chromium to fetch the actual manifest, exercising its distinct cookie rules.
  const cdp = await page.context().newCDPSession(page)
  try {
    const manifest = await cdp.send('Page.getAppManifest')
    if (!manifest.data || !manifest.url.endsWith('/manifest.webmanifest')) {
      throw new Error('authenticated browser could not fetch its same-origin manifest')
    }
    JSON.parse(manifest.data)
  } finally {
    await cdp.detach()
  }
  const policyErrors = await page.evaluate(() => globalThis.__hubCspViolations)
  if (pageErrors.length > 0 || policyErrors.length > 0) {
    throw new Error(`Hub Web failed under strict CSP:\n${[
      ...pageErrors,
      ...policyErrors.map(error => JSON.stringify(error)),
    ].join('\n')}`)
  }
  process.stdout.write('Hub Web: strict CSP boot and directory flow verified\n')

  // Exercise the production bundle, real Settings outlet, and destructive
  // confirmation at two simultaneous owners sharing the same local Session id.
  await page.locator('button[aria-haspopup="dialog"]').click()
  await page.getByRole('button', { name: /^会话管理$|^Session management$/u }).click()
  const manager = page.getByRole('region', { name: /^会话管理$|^Session management$/u })
  await manager.getByText('Fixture conversation A', { exact: true }).waitFor()
  await manager.getByRole('button', { name: /^已归档$|^Archived$/u }).click()
  await manager.getByText('Fixture conversation B', { exact: true }).waitFor()
  await manager.getByRole('button', { name: /^取消归档$|^Unarchive$/u }).click()
  await manager.getByRole('button', { name: /^正常$|^Active$/u }).click()
  const secondRow = manager.locator('li').filter({ hasText: 'Fixture conversation B' })
  await secondRow.waitFor()
  async function trashSecondRow() {
    await secondRow.getByRole('button', { name: /^删除$|^Delete$/u }).click()
    await page.getByRole('dialog', { name: /^删除会话$|^Delete session$/u })
      .getByRole('button', { name: /^删除$|^Delete$/u }).click()
    await manager.getByRole('button', { name: /^回收站$|^Trash$/u }).click()
    await secondRow.waitFor()
  }
  await trashSecondRow()
  await secondRow.getByRole('button', { name: /^恢复$|^Restore$/u }).click()
  await manager.getByRole('button', { name: /^正常$|^Active$/u }).click()
  await secondRow.waitFor()
  await trashSecondRow()
  await secondRow.getByRole('button', { name: /^永久删除$|^Delete permanently$/u }).click()
  const permanent = page.getByRole('dialog', { name: /^永久删除会话$|^Delete session permanently$/u })
  const purgeButton = permanent.getByRole('button', { name: /^永久删除$|^Delete permanently$/u })
  if (!await purgeButton.isDisabled()) throw new Error('permanent erase did not require a separate confirmation')
  await permanent.getByRole('checkbox').check()
  await purgeButton.click()
  await secondRow.waitFor({ state: 'detached' })
  if (lifecycleRows.get('fixture-node')[0].status !== 'active'
    || lifecycleRows.get('fixture-second')[0].status !== 'purged'
    || lifecycleCalls.some(call => call.operation !== 'inventory' && call.nodeId !== 'fixture-second')) {
    throw new Error('session management crossed Runtime ownership')
  }
  process.stdout.write('Hub Web: archive, restore, trash, permanent confirmation, and two-owner routing verified\n')

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
  await mobile.context().addCookies([loginCookie])
  const mobileErrors = []
  mobile.on('pageerror', error => mobileErrors.push(error.message))
  startedAt = performance.now()
  await mobile.goto(`http://127.0.0.1:${address.port}/?nodeId=fixture-node&runtimeId=fixture-runtime`, {
    waitUntil: 'domcontentloaded',
  })
  await mobile.locator('#root').waitFor({ state: 'attached' })
  await mobile.waitForFunction(() => document.querySelector('#root')?.childElementCount !== 0)
  recordTiming('mobileBootMs', startedAt)

  const frame = mobile.locator('#root > [data-slot="root"] > div').first()
  await frame.waitFor()
  if (await frame.getAttribute('data-sidebar-collapsed') !== 'true') {
    throw new Error('Hub Web mobile sidebar did not start in its compact state')
  }
  const tracksBefore = await frame.evaluate(element => getComputedStyle(element).gridTemplateColumns)
  startedAt = performance.now()
  await frame.locator('button').first().click()
  await mobile.waitForFunction(() => document.querySelector('[data-mobile-sidebar-open]') !== null)
  recordTiming('mobileSidebarOpenMs', startedAt)
  const tracksAfter = await frame.evaluate(element => getComputedStyle(element).gridTemplateColumns)
  if (tracksAfter !== tracksBefore) {
    throw new Error('Hub Web mobile sidebar reduced the conversation instead of opening as an overlay')
  }
  await frame.locator('[class*="mobileSidebarMask"]').click({ position: { x: 360, y: 200 } })
  await mobile.waitForFunction(() => document.querySelector('[data-mobile-sidebar-open]') === null)

  const composer = mobile.locator('[data-composer-card]').first()
  const runtimePicker = mobile.getByRole('button', { name: '节点与 Runtime' })
  await Promise.all([composer.waitFor(), runtimePicker.waitFor()])
  const [composerBox, runtimePickerBox] = await Promise.all([
    composer.boundingBox(),
    runtimePicker.boundingBox(),
  ])
  if (
    composerBox === null
    || runtimePickerBox === null
    || composerBox.x < 0
    || composerBox.x + composerBox.width > 390
    || composerBox.width < 300
    || runtimePickerBox.width > 210
  ) {
    throw new Error(`Hub Web mobile composer geometry regressed: ${JSON.stringify({ composerBox, runtimePickerBox })}`)
  }

  startedAt = performance.now()
  await mobile.locator('button[aria-haspopup="dialog"]').click()
  const settings = mobile.locator('[role="dialog"]')
  await settings.waitFor()
  recordTiming('mobileSettingsOpenMs', startedAt)
  const mobileGeometry = await settings.evaluate((dialog) => {
    const rectangle = dialog.getBoundingClientRect()
    const navigation = dialog.querySelector('nav')
    const content = navigation?.nextElementSibling
    return {
      width: rectangle.width,
      height: rectangle.height,
      navigationWidth: navigation?.getBoundingClientRect().width ?? 0,
      contentWidth: content?.getBoundingClientRect().width ?? 0,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: globalThis.innerWidth,
    }
  })
  if (
    mobileGeometry.width < 389
    || mobileGeometry.height < 843
    || mobileGeometry.navigationWidth < 360
    || mobileGeometry.contentWidth < 360
    || mobileGeometry.documentWidth > mobileGeometry.viewportWidth
  ) {
    throw new Error(`Hub Web mobile Settings geometry regressed: ${JSON.stringify(mobileGeometry)}`)
  }
  const settingsTarget = mobile.getByRole('button', { name: /当前 Runtime|Current Runtime/u })
  await settingsTarget.waitFor()
  await mobile.evaluate(() => { document.documentElement.dataset.hubCspDocument = 'settings-target-switch' })
  startedAt = performance.now()
  await settingsTarget.click()
  await mobile.getByRole('menuitem', { name: 'Fixture Mac · desktop' }).click()
  await mobile.waitForFunction(() => new URL(globalThis.location.href).searchParams.get('nodeId') === 'fixture-second')
  recordTiming('mobileSettingsTargetSwitchMs', startedAt)
  if (await mobile.locator('html').getAttribute('data-hub-csp-document') !== 'settings-target-switch') {
    throw new Error('Hub Web reloaded the document while changing its Settings Runtime target')
  }
  if (!await settings.isVisible()) {
    throw new Error('Hub Web closed Settings while changing its Runtime target')
  }
  await mobile.getByRole('button', { name: /^会话管理$|^Session management$/u }).click()
  const mobileManager = mobile.getByRole('region', { name: /^会话管理$|^Session management$/u })
  await mobileManager.getByText('Fixture conversation A', { exact: true }).waitFor()
  if (await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
    throw new Error('session management overflowed the mobile viewport')
  }
  if (pageErrors.length > 0 || mobileErrors.length > 0) throw new Error(`Session management raised errors: ${[...pageErrors, ...mobileErrors].join('\n')}`)
  if (mobileErrors.length > 0) {
    throw new Error(`Hub Web mobile UI raised page errors:\n${mobileErrors.join('\n')}`)
  }
  await mobile.close()
  process.stdout.write('Hub Web: 390px sidebar and full-screen Settings verified\n')
  const report = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    viewport: { width: 390, height: 844 },
    interactionBudgetMs,
    timings,
  }
  const reportPath = process.env.DSH_HUB_UI_BENCHMARK_JSON
  if (reportPath !== undefined && reportPath !== '') {
    const output = resolve(repositoryRoot, reportPath)
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  }
  process.stdout.write(`Hub Web UI timings: ${JSON.stringify(timings)}\n`)
} finally {
  await browser?.close()
  await new Promise(resolveClose => server.close(resolveClose))
}
