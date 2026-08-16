#!/usr/bin/env node

/** Verify that the assembled Hub UI boots under its production script policy. */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { extname, resolve, sep } from 'node:path'
import { HUB_CONTENT_SECURITY_POLICY } from '../packages/hub/hub-server/src/server.ts'

const repositoryRoot = resolve(import.meta.dirname, '..')
const staticRoot = resolve(repositoryRoot, 'apps', 'hub-web', 'dist')
const requireFromWeb = createRequire(resolve(repositoryRoot, 'apps', 'web', 'package.json'))
const { chromium } = requireFromWeb('playwright')
const mediaTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
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
  await page.goto(`http://127.0.0.1:${address.port}/?nodeId=fixture-node&runtimeId=fixture-runtime`, {
    waitUntil: 'domcontentloaded',
  })
  await hubPluginRequest
  await page.locator('#root').waitFor({ state: 'attached' })
  await page.waitForFunction(() => document.querySelector('#root')?.childElementCount !== 0)
  const policyErrors = await page.evaluate(() => globalThis.__hubCspViolations)
  if (pageErrors.length > 0 || policyErrors.length > 0) {
    throw new Error(`Hub Web failed under strict CSP:\n${[
      ...pageErrors,
      ...policyErrors.map(error => JSON.stringify(error)),
    ].join('\n')}`)
  }
  process.stdout.write('Hub Web: strict CSP boot verified\n')
} finally {
  await browser?.close()
  await new Promise(resolveClose => server.close(resolveClose))
}
