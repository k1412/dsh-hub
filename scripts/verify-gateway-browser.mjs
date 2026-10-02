#!/usr/bin/env node
/** Local fixture gate, not a deployed upstream DSH end-to-end test. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { tsImport } from 'tsx/esm/api'

/**
 * Passive production-browser collector. Attach before root's authorized actions:
 * const metrics = collectBrowserRequests(context)
 * // root drives navigation / native smoke here
 * const summary = await metrics.stop()
 * No navigation, API calls or writes; no URL, headers, body, credentials or error
 * messages retained. Includes full request completion, HTTP errors and failures.
 */
export function collectBrowserRequests(context, { maxRequests = 1000, durationMs = 120_000 } = {}) {
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 100_000
    || !Number.isFinite(durationMs) || durationMs < 1 || durationMs > 600_000) throw new RangeError('Invalid browser metrics budget')
  const active = new Map(), samples = [], pending = new Set()
  let observed = 0, dropped = 0, pageErrors = 0, stopped = false, result
  const started = performance.now()
  const requested = request => {
    if (observed >= maxRequests) { dropped++; return }
    observed++; active.set(request, performance.now())
  }
  const completed = request => {
    const start = active.get(request)
    if (start === undefined) return
    active.delete(request)
    const elapsedMs = performance.now() - start
    const task = request.response().then(response => {
      const status = response?.status() ?? 0
      samples.push({ elapsedMs, status, outcome: status >= 200 && status < 400 ? 'success' : 'error' })
    }).catch(() => { samples.push({ elapsedMs, status: 0, outcome: 'error' }) })
    pending.add(task); void task.finally(() => pending.delete(task))
  }
  const failed = request => {
    const start = active.get(request)
    if (start === undefined) return
    active.delete(request); samples.push({ elapsedMs: performance.now() - start, status: 0, outcome: 'error' })
  }
  const webError = () => { pageErrors++ }
  const detach = () => {
    if (stopped) return
    stopped = true; clearTimeout(timer)
    context.off('request', requested); context.off('requestfinished', completed); context.off('requestfailed', failed); context.off('weberror', webError)
    for (const start of active.values()) samples.push({ elapsedMs: performance.now() - start, status: 0, outcome: 'incomplete' })
    active.clear()
  }
  const timer = setTimeout(detach, durationMs); timer.unref()
  context.on('request', requested); context.on('requestfinished', completed); context.on('requestfailed', failed); context.on('weberror', webError)
  return { stop() {
    detach()
    result ??= (async () => {
      await Promise.all([...pending])
      const finished = samples.filter(sample => sample.outcome !== 'incomplete')
      const times = finished.map(sample => sample.elapsedMs).sort((a, b) => a - b)
      const success = samples.filter(sample => sample.outcome === 'success').length
      const errors = samples.filter(sample => sample.outcome === 'error').length
      const incomplete = samples.length - finished.length
      const statuses = {}
      for (const sample of samples) statuses[sample.status] = (statuses[sample.status] ?? 0) + 1
      return { observed, completed: finished.length, success, errors, incomplete, dropped, pageErrors, statuses,
        successRate: observed ? success / observed : null, errorRate: observed ? errors / observed : null,
        p50Ms: times.length ? times[Math.floor(times.length * .5)] : null,
        p95Ms: times.length ? times[Math.floor(times.length * .95)] : null,
        elapsedMs: performance.now() - started }
    })()
    return result
  } }
}

export async function runFixtureGate() {
const { createFixture, until } = await tsImport('../packages/hub/gateway-server/tests/fixture.ts', import.meta.url)
const output = process.env.GATEWAY_QA_REPORT_DIR ?? '/tmp/dsh-gateway-browser'
await mkdir(output, { recursive: true })
const fixture = await createFixture({ nativeRoot: process.env.DSH_NATIVE_ROOT, requestTimeoutMs: 750 })
let browser
const report = { scope: 'Local NodeSurface shell and API fixtures; actual Gateway HTTP/ws. Optional published native Connection, not full upstream application or deployed network.', nativeConnection: Boolean(process.env.DSH_NATIVE_ROOT), checks: [], measurements: [], screenshots: [] }
function measured(name, samples, errors, start, concurrency) {
  const sorted = [...samples].sort((a, b) => a - b)
  const result = { scenario: name, requests: sorted.length, concurrency, p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.floor(sorted.length * .95)], errorRate: errors / sorted.length, elapsedMs: performance.now() - start }
  report.measurements.push(result)
  assert.equal(errors, 0, `${name}: requests failed`); assert.ok(result.p95Ms < 2500, `${name}: p95 exceeded 2.5 seconds`)
}
try {
  const nodes = await Promise.all([fixture.addNode('Fixture workstation A'), fixture.addNode('Fixture workstation B')])
  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP *.localhost 127.0.0.1'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  // Fixture callback is restricted by the server to the operator host.
  await context.setExtraHTTPHeaders({ 'x-fixture-operator': 'yes' })
  const hub = await context.newPage(); await hub.goto(fixture.publicUrl)
  assert.equal(await hub.locator('.card.node').count(), 2)
  const pages = []
  for (const node of nodes) {
    const popup = hub.waitForEvent('popup')
    await hub.locator(`a[href="/open/${node.id}"]`).click()
    const page = await popup; await page.waitForLoadState('load')
    assert.equal(new URL(page.url()).origin, fixture.nodeOrigin(node.id))
    assert.equal(await page.locator('#owner').textContent(), node.label)
    await page.locator('#request').click(); await page.waitForFunction(() => document.querySelector('#result').textContent.includes('runtime-'))
    pages.push(page)
  }
  report.checks.push('two real node-entry popups authenticate to distinct node origins and owning Runtime APIs')
  for (let i = 0; i < pages.length; i++) await pages[i].evaluate(value => { localStorage.setItem('same-session-key', value); sessionStorage.setItem('same-session-key', value) }, `node-${i}`)
  for (let i = 0; i < pages.length; i++) {
    await pages[i].reload()
    assert.deepEqual(await pages[i].evaluate(() => [localStorage.getItem('same-session-key'), sessionStorage.getItem('same-session-key')]), [`node-${i}`, `node-${i}`])
  }
  assert.deepEqual(await hub.evaluate(() => [localStorage.getItem('same-session-key'), sessionStorage.getItem('same-session-key')]), [null, null])
  await pages[0].goto(`${fixture.publicUrl}/open/${nodes[0].id}`)
  await pages[0].waitForURL(`${fixture.nodeOrigin(nodes[0].id)}/`)
  assert.deepEqual(await pages[0].evaluate(() => [localStorage.getItem('same-session-key'), sessionStorage.getItem('same-session-key')]), ['node-0', 'node-0'])
  report.checks.push('node and Hub localStorage/sessionStorage isolation; reload and same-tab reopen retain owning storage')

  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
    await hub.setViewportSize(viewport)
    for (const path of ['/', '/invites/new', '/network', `/nodes/${nodes[0].id}`]) {
      await hub.goto(`${fixture.publicUrl}${path}`)
      assert.ok(await hub.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label} overflow: ${path}`)
      assert.ok(await hub.locator('h1').isVisible())
    }
    await hub.goto(fixture.publicUrl)
    for (const link of await hub.locator('.node .button').all()) {
      const box = await link.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width && box.height >= 40)
    }
    const shot = `gateway-${label}.png`; await hub.screenshot({ path: join(output, shot), fullPage: true }); report.screenshots.push(shot)
    await pages[0].setViewportSize(viewport)
    assert.ok(await pages[0].evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  }
  report.checks.push('desktop 1440x1000 and phone 390x844: Hub list, invite, network, detail and fixture node shell fit viewport; node entry targets >=40px')

  const start = performance.now(); const samples = []; let errors = 0
  await Promise.all(pages.map(async (page, index) => {
    for (let round = 0; round < 10; round++) {
      const began = performance.now(); const navigation = await page.reload(); samples.push(performance.now() - began)
      if (navigation.status() !== 200 || await page.locator('#owner').textContent() !== nodes[index].label) errors++
      const rows = await page.evaluate(async () => Promise.all(Array.from({ length: 3 }, async () => {
        const start = performance.now()
        try { const r = await fetch('/api/identity'); const value = await r.json(); return { ms: performance.now() - start, status: r.status, value } }
        catch { return { ms: performance.now() - start, status: 0 } }
      })))
      for (const row of rows) { samples.push(row.ms); if (row.status !== 200 || row.value.node !== nodes[index].label) errors++ }
    }
  }))
  measured('initial separate native node pages: repeated navigation + API', samples, errors, start, 6)

  // Read-only fanout workload measures a separate aggregation experiment without
  // installing an aggregate UI, sharing storage, or writing business state.
  const aggregateStart = performance.now(); const aggregate = []; let aggregateErrors = 0
  for (let round = 0; round < 20; round++) {
    const rows = await Promise.all(pages.map(page => page.evaluate(async () => {
      const start = performance.now()
      try { const r = await fetch('/api/identity'); const value = await r.json(); return { ms: performance.now() - start, status: r.status, value } }
      catch { return { ms: performance.now() - start, status: 0 } }
    })))
    rows.forEach((row, index) => { aggregate.push(row.ms); if (row.status !== 200 || row.value.node !== nodes[index].label) aggregateErrors++ })
  }
  measured('separate aggregation experiment: read-only two-origin fanout (no aggregate product UI)', aggregate, aggregateErrors, aggregateStart, 2)

  const failure = await pages[0].evaluate(async () => {
    const start = performance.now()
    const results = await Promise.all(['/api/fail', '/api/hang'].map(async path => { const r = await fetch(path); await r.text(); return r.status }))
    const mux = await new Promise(resolve => {
      const socket = new WebSocket(`${location.origin.replace('http', 'ws')}/api/remote.mux`)
      const timer = setTimeout(() => { socket.close(); resolve('timeout') }, 2000)
      socket.onopen = () => socket.send(JSON.stringify({ type: 'open', streamId: 'browser-failure', endpoint: 'fixture/fail', payload: {} }))
      socket.onmessage = event => { clearTimeout(timer); socket.close(); resolve(JSON.parse(event.data).type) }
      socket.onerror = () => { clearTimeout(timer); resolve('socket-error') }
    })
    return { results, mux, elapsedMs: performance.now() - start }
  })
  // Published native Connection converts thrown handlers to its own 500 envelope.
  assert.ok([500, 502].includes(failure.results[0])); assert.equal(failure.results[1], 504); assert.equal(failure.mux, 'error'); assert.ok(failure.elapsedMs < 3000)
  report.checks.push('browser fetch handler error, request timeout and native mux failure settle within 3 seconds')
  const pending = pages[0].evaluate(async () => { try { const r = await fetch('/api/write-hang', { method: 'POST' }); await r.text(); return r.status } catch { return 0 } })
  await until(() => nodes[0].writes === 1); await fixture.disconnect(nodes[0]); assert.equal(await pending, 502)
  assert.equal(await pages[1].evaluate(async () => (await fetch('/api/identity')).status), 200)
  assert.equal(await pages[0].evaluate(async () => (await fetch('/api/identity')).status), 503)
  await fixture.connect(nodes[0]); await pages[0].reload(); assert.equal(nodes[0].writes, 1)
  report.status = 'restart-check-pending'
  await writeFile(join(output, 'browser-report.json'), JSON.stringify(report, null, 2))
  await fixture.restart(); await Promise.all(nodes.map(node => fixture.connect(node)))
  for (let i = 0; i < pages.length; i++) { await pages[i].reload(); assert.equal(await pages[i].locator('#owner').textContent(), nodes[i].label) }
  assert.equal(nodes[0].writes, 1); assert.equal(nodes[1].writes, 0)
  report.checks.push('browser disconnect settles pending write; other node remains usable; reconnect/restart retain pairing and cookies without replay')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.failure = error instanceof Error ? error.message : String(error); process.exitCode = 1
} finally {
  await browser?.close(); await fixture.close()
  await writeFile(join(output, 'browser-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

}

// Importing the production collector must never launch a fixture or browser.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runFixtureGate()
