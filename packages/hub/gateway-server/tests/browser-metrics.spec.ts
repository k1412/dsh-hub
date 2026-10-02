import { createServer } from 'node:http'
import { once } from 'node:events'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

// Browser binaries are installed only in the dedicated browser CI job.
it.skipIf(process.env.GATEWAY_BROWSER_TEST !== '1')('collects production browser outcomes passively without retaining URLs or credentials', async () => {
  // Dynamic URL import keeps this optional JS script outside production TS roots.
  const moduleUrl = new URL('../../../../scripts/verify-gateway-browser.mjs', import.meta.url).href
  const { collectBrowserRequests } = await import(moduleUrl)
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    if (req.url?.startsWith('/broken')) { req.socket.destroy(); return }
    if (req.url?.startsWith('/slow')) { setTimeout(() => { if (!res.destroyed) res.end('ok') }, 40); return }
    res.statusCode = req.url?.startsWith('/error') ? 503 : 200
    res.end(req.url === '/' ? '<!doctype html><title>metrics fixture</title>' : 'ok')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext(); const page = await context.newPage()
    await page.goto(origin)
    const metrics = collectBrowserRequests(context)
    const before = requests
    expect(requests).toBe(before) // attaching never issues a request
    await page.evaluate(async () => {
      for (const path of ['/slow?secret=do-not-record', '/error', '/broken']) {
        try { await (await fetch(path)).text() } catch { /* collector observes failure */ }
      }
    })
    const summary = await metrics.stop()
    expect(summary).toMatchObject({ observed: 3, completed: 3, success: 1, errors: 2, incomplete: 0, statuses: { 200: 1, 503: 1, 0: 1 } })
    expect(summary.p95Ms).toBeGreaterThanOrEqual(30)
    expect(summary.successRate).toBeCloseTo(1 / 3)
    expect(JSON.stringify(summary)).not.toContain('secret')
    expect(JSON.stringify(summary)).not.toContain(origin)
    expect(await metrics.stop()).toEqual(summary)
    const capped = collectBrowserRequests(context, { maxRequests: 1 })
    await page.evaluate(async () => { await (await fetch('/ok')).text(); await (await fetch('/ok')).text() })
    expect(await capped.stop()).toMatchObject({ observed: 1, dropped: 1, success: 1 })
    const timed = collectBrowserRequests(context, { durationMs: 1 })
    await new Promise(resolve => setTimeout(resolve, 10))
    await page.evaluate(async () => { await (await fetch('/ok')).text() })
    expect(await timed.stop()).toMatchObject({ observed: 0, p95Ms: null })
  } finally {
    await browser.close()
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  }
}, 15_000)
