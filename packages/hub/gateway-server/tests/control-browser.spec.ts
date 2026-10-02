import { once } from 'node:events'
import { chromium, webkit, type Browser, type Page } from 'playwright'
import { WebSocket } from 'ws'
import { describe, expect, it } from 'vitest'
import { ControlRPC, serveSurface } from '../../gateway-transport/src/index.ts'
import { createFixture, until } from './fixture.ts'

// Real navigation/form submission: never synthesize or override Origin/Referer.
async function submit(page: Page, button: string, path: string) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST')
  await page.getByRole('button', { name: button, exact: true }).click()
  return response
}

describe.skipIf(process.env.GATEWAY_BROWSER_TEST !== '1')('native browser SSR control forms', () => {
  for (const engine of ['chromium', 'webkit'] as const) {
    it(`${engine}: creates and revokes an exact directional grant and routes a plugin button only to its node`, async () => {
      const f = await createFixture()
      let browser: Browser | undefined
      let sourceSocket: WebSocket | undefined
      let sourceRPC: ControlRPC | undefined
      let socket: WebSocket | undefined
      let rpc: ControlRPC | undefined
      try {
        browser = await (engine === 'chromium' ? chromium : webkit).launch({ headless: true, ...(engine === 'chromium' ? { args: ['--no-proxy-server', '--host-resolver-rules=MAP *.localhost 127.0.0.1'] } : {}) })
        const a = await f.addNode('A'), b = await f.addNode('B')
        await f.disconnect(a)
        await f.disconnect(b)
        sourceSocket = new WebSocket(`ws://127.0.0.1:${f.privatePort}/connect?nodeId=${a.id}`, { headers: {
          authorization: `Bearer ${a.credential}`, 'x-dsh-runtime': 'runtime-A',
          'x-dsh-control': '2', 'x-dsh-control-capabilities': 'management',
        } })
        await once(sourceSocket, 'open')
        serveSurface(sourceSocket, a.surface, { control: true })
        const sourceCalls: unknown[] = []
        sourceRPC = new ControlRPC(sourceSocket, async (method, input) => {
          sourceCalls.push({ method, input })
          return { version: 'fixture-A', plugins: [], bundles: [], jobs: [] }
        })
        socket = new WebSocket(`ws://127.0.0.1:${f.privatePort}/connect?nodeId=${b.id}`, { headers: {
          authorization: `Bearer ${b.credential}`, 'x-dsh-runtime': 'runtime-B',
          'x-dsh-control': '2', 'x-dsh-control-capabilities': 'management',
        } })
        await once(socket, 'open')
        serveSurface(socket, b.surface, { control: true })
        let enabled = true
        const writes: unknown[] = []
        rpc = new ControlRPC(socket, async (method, input) => {
          if (method === 'management.inventory') return { version: 'fixture', plugins: [{ entryId: 'fixture-entry-B', moduleName: 'fixture-plugin-B', enabled, phase: 'active' }], bundles: [], jobs: [] }
          expect(method).toBe('management.submit')
          expect(input).toMatchObject({ action: 'plugin.disable', target: 'fixture-entry-B' })
          writes.push(input); enabled = false
          return { status: 'completed', action: 'plugin.disable', target: 'fixture-entry-B' }
        })
        await until(() => !!f.gateway.peers.get(a.id)?.control && !!f.gateway.peers.get(b.id)?.control)
        const context = await browser.newContext({ extraHTTPHeaders: { 'x-fixture-operator': 'yes' } })
        context.setDefaultTimeout(5000)
        const page = await context.newPage()
        await page.goto(`${f.publicUrl}/control/grants`)
        await page.getByLabel('来源节点').selectOption(a.id)
        await page.getByLabel('目标节点').selectOption(b.id)
        await page.getByLabel('目标授权工作区').fill('/delegated/project')
        await page.getByLabel('允许的操作').selectOption('discover,task.start,task.read,task.cancel')
        await page.getByLabel('有效期').selectOption('3600')
        const before = Date.now()
        const created = await submit(page, '添加授权', '/control/grants')
        expect({ status: created.status(), origin: await created.request().headerValue('origin') }).toEqual({ status: 303, origin: f.publicUrl })
        const grants = f.gateway.store.grants()
        expect(grants).toHaveLength(1)
        expect(grants[0]).toMatchObject({ source: a.id, target: b.id, sourceRuntime: 'runtime-A', targetRuntime: 'runtime-B', workspace: '/delegated/project', capabilities: ['discover', 'task.start', 'task.read', 'task.cancel'] })
        expect(grants[0]!.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000)
        expect(grants[0]!.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000)
        await page.getByRole('button', { name: '立即撤销' }).waitFor()
        expect(await page.locator('tbody').innerText()).toContain('A → B')
        expect(await page.locator('tbody').innerText()).toContain('/delegated/project')
        const revoked = await submit(page, '立即撤销', '/control/grants')
        expect({ status: revoked.status(), origin: await revoked.request().headerValue('origin') }).toEqual({ status: 303, origin: f.publicUrl })
        expect(f.gateway.store.grants()).toEqual([])
        expect(f.gateway.store.auditRows()).toMatchObject([
          { action: 'grant.revoke', requestId: grants[0]!.id },
          { node: b.id, action: 'grant.create', requestId: grants[0]!.id },
        ])
        await page.getByText('尚未授权节点间访问。', { exact: true }).waitFor()

        await page.goto(`${f.publicUrl}/control/${b.id}`)
        const plugin = page.getByRole('row').filter({ hasText: 'fixture-plugin-B' })
        expect(await plugin.innerText()).toContain('已启用 · 已启动')
        const changed = await submit(page, '停用', `/control/${b.id}`)
        expect(changed.status()).toBe(200)
        expect(await changed.request().headerValue('origin')).toBe(f.publicUrl)
        expect(writes).toHaveLength(1)
        expect(writes[0]).toMatchObject({ requestId: expect.any(String), target: 'fixture-entry-B', action: 'plugin.disable' })
        expect(enabled).toBe(false)
        expect(sourceCalls).toEqual([])
        await page.getByRole('heading', { name: '操作已返回', exact: true }).waitFor()
        expect(await page.locator('main').innerText()).toContain('已完成')
        await page.goto(`${f.publicUrl}/control/${b.id}`)
        await page.getByRole('button', { name: '启用', exact: true }).waitFor()
        expect(await plugin.innerText()).toContain('已停用 · 已启动')
      } finally {
        try { await browser?.close() } finally {
          sourceRPC?.close(); rpc?.close(); sourceSocket?.terminate(); socket?.terminate(); await f.close()
        }
      }
    }, 30_000)
  }
})
