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

function recordTiming(name, startedAt) {
  const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100
  timings[name] = elapsedMs
  if (elapsedMs > interactionBudgetMs) {
    throw new Error(`${name} exceeded the ${String(interactionBudgetMs)} ms UI regression budget: ${String(elapsedMs)} ms`)
  }
}

const hubDocument = await readFile(resolve(staticRoot, 'index.html'), 'utf8')
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
  const policyErrors = await page.evaluate(() => globalThis.__hubCspViolations)
  if (pageErrors.length > 0 || policyErrors.length > 0) {
    throw new Error(`Hub Web failed under strict CSP:\n${[
      ...pageErrors,
      ...policyErrors.map(error => JSON.stringify(error)),
    ].join('\n')}`)
  }
  process.stdout.write('Hub Web: strict CSP boot and directory flow verified\n')

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
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
