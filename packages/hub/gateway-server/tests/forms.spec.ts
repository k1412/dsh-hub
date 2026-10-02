import { createServer, request, type Server } from 'node:http'
import { once } from 'node:events'
import { chromium, webkit, type Page } from 'playwright'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NETWORK_VERSIONS } from '../../gateway-network/src/versions.ts'
import { serveSurface } from '../../gateway-transport/src/index.ts'
import { createGateway } from '../src/server.ts'
import { listen } from './fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const closeServer = (server: Server) => new Promise<void>(ok => { server.close(() => ok()); server.closeAllConnections() })

async function setup(passwordMode = false) {
  const reservation = createServer(); const port = await listen(reservation); await closeServer(reservation)
  const origin = `http://127.0.0.1:${port}`
  const password = 'actual-browser-form-test-password'
  const loginTailscale = vi.fn(async () => ({}))
  const nodeOrigins = new Map<string, string>()
  const gateway = createGateway({ publicUrl: origin, statePath: ':memory:', downloadsDirectory: '.', installerPath: '.',
    nodeOrigin: id => nodeOrigins.get(id) ?? `http://${id}.localhost:${port}`,
    networks: {
      status: async () => ({ tailscale: { installed: true, state: 'ready', mode: 'managed' }, tailcat: { installed: true, state: 'ready' }, versions: NETWORK_VERSIONS }),
      endpoint: mode => `${mode}-fixture-endpoint`, loginTailscale,
    },
    ...(passwordMode ? { adminPassword: password } : { authenticateOperator: async req => req.headers['x-fixture-operator'] === 'yes' }),
  })
  cleanups.push(() => gateway.close())
  const posts: { path: string; origin: string | undefined; referer: string | undefined }[] = []
  gateway.publicServer.on('request', req => { if (req.method === 'POST') posts.push({ path: req.url ?? '', origin: req.headers.origin, referer: req.headers.referer }) })
  await listen(gateway.publicServer, port)
  return { gateway, origin, posts, password, loginTailscale, nodeOrigins }
}

async function submit(page: Page, button: string, path: string) {
  const response = page.waitForResponse(reply => reply.request().method() === 'POST' && new URL(reply.url()).pathname === path)
  await page.getByRole('button', { name: button, exact: true }).click()
  return response
}

async function addFormNode(fixture: Awaited<ReturnType<typeof setup>>, privatePort: number, name: string) {
  const invitation = fixture.gateway.store.invite('tailcat', 'fixture-endpoint', name)
  const credential = `native-form-credential-${name}-32-characters`
  const node = fixture.gateway.store.enroll({ inviteToken: invitation.token, clientId: name, credential,
    name, dshVersion: 'fixture', runtimeId: 'default' })
  // Distinct loopback ports are real origins in both engines. Forward raw HTTP
  // headers to the Gateway, including the browser-generated Host and Origin.
  const proxy = createServer((req, res) => {
    const upstream = request({ hostname: '127.0.0.1', port: new URL(fixture.origin).port,
      method: req.method, path: req.url, headers: req.headers }, reply => {
      res.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(res)
    })
    upstream.on('error', () => res.destroy()); req.pipe(upstream)
  })
  const origin = `http://127.0.0.1:${await listen(proxy)}`
  cleanups.push(() => closeServer(proxy)); fixture.nodeOrigins.set(node.id, origin)
  const state = { origin, cookie: fixture.gateway.store.session(node.id), writes: 0, otherOrigin: '', bodies: [] as string[] }
  const socket = new WebSocket(`ws://127.0.0.1:${privatePort}/connect?nodeId=${node.id}`, {
    headers: { authorization: `Bearer ${credential}`, 'x-dsh-runtime': 'default' },
  })
  socket.on('error', () => {}); await once(socket, 'open')
  const carrier = serveSurface(socket, {
    async handle(req) {
      const path = new URL(req.url).pathname
      if (path === '/api/write') { state.writes++; state.bodies.push(await req.text()); return Response.json({ node: name, writes: state.writes }) }
      if (path === '/api/attachment') return new Response('<html>download</html>', { headers: { 'content-type': 'text/html', 'content-disposition': 'attachment; filename=test.html' } })
      if (path === '/api/redirect') return new Response('<html>redirect</html>', { status: 302, headers: { 'content-type': 'text/html', location: '/' } })
      if (path === '/api/json') return Response.json({ node: name })
      const policy = path === '/cross' ? 'origin' : path === '/null' ? 'no-referrer' : ''
      const action = path === '/cross' ? `${state.otherOrigin}/api/write` : '/api/write'
      return new Response(`<!doctype html>${policy ? `<meta name="referrer" content="${policy}">` : ''}<form method="post" action="${action}"><input name="input" value="from-native"><button>Submit native</button></form>`, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    },
    openMux: () => ({ receive() {}, close() {} }),
  })
  cleanups.push(async () => { carrier.close(); socket.terminate() })
  return state
}

// Run in the native CI job, which installs both engines. These are HTML form
// submissions; no Origin header is supplied or rewritten by the test runner.
describe.skipIf(process.env.GATEWAY_BROWSER_TEST !== '1').each([
  ['Chromium', chromium], ['WebKit', webkit],
] as const)('%s real Hub forms', (_name, engine) => {
  it('generates invitations from the Hub page for exactly Tailscale and Tailcat', async () => {
    const fixture = await setup()
    const browser = await engine.launch({ headless: true }); cleanups.push(() => browser.close())
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-fixture-operator': 'yes' } })
    const page = await context.newPage()
    for (const mode of ['tailscale', 'tailcat']) {
      await page.goto(fixture.origin)
      await page.getByRole('link', { name: '添加节点', exact: true }).click()
      expect(await page.locator('select[name="mode"] option').evaluateAll(options => options.map(option => option.getAttribute('value')))).toEqual(['tailscale', 'tailcat'])
      await page.getByLabel('节点名称').fill(`browser-${mode}`)
      await page.getByLabel('连接方式').selectOption(mode)
      const response = await submit(page, '生成安装命令', '/invites')
      expect(fixture.posts.at(-1)?.origin).toBe(fixture.origin)
      expect(response.status()).toBe(200)
      expect(await page.getByRole('heading', { name: `连接 browser-${mode}`, exact: true }).isVisible()).toBe(true)
      const command = await page.locator('pre').textContent()
      const token = /--invite '([A-Za-z0-9_-]{43})'/.exec(command ?? '')?.[1]
      expect(token).toBeTruthy()
      expect(fixture.gateway.store.invitation(token ?? '')).toMatchObject({ mode, name: `browser-${mode}`, nodeId: null })
    }
  })

  it('logs in with the real password form and then creates an invitation', async () => {
    const fixture = await setup(true)
    const browser = await engine.launch({ headless: true }); cleanups.push(() => browser.close())
    const page = await browser.newPage()
    await page.goto(fixture.origin)
    await page.getByLabel('管理员密码').fill(fixture.password)
    const response = await submit(page, '登录', '/login')
    expect(fixture.posts.at(-1)?.origin).toBe(fixture.origin)
    expect(response.status()).toBe(303)
    await page.getByRole('link', { name: '添加节点', exact: true }).click()
    await page.getByLabel('节点名称').fill('password-owner-node')
    await page.getByLabel('连接方式').selectOption('tailcat')
    expect((await submit(page, '生成安装命令', '/invites')).status()).toBe(200)
    expect(fixture.posts.at(-1)?.origin).toBe(fixture.origin)
  })

  it('rejects authenticated cross-origin and null-Origin browser forms without creating an invitation', async () => {
    const fixture = await setup()
    const invite = vi.spyOn(fixture.gateway.store, 'invite')
    const attack = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'referrer-policy': req.url === '/null' ? 'no-referrer' : 'strict-origin-when-cross-origin' })
      res.end(`<!doctype html><form method="post" action="${fixture.origin}/invites"><input name="name" value="cross-origin-node"><input name="mode" value="tailcat"><button>Submit</button></form>`)
    })
    const attackOrigin = `http://127.0.0.1:${await listen(attack)}`
    cleanups.push(() => closeServer(attack))
    const browser = await engine.launch({ headless: true }); cleanups.push(() => browser.close())
    // Authentication is deliberately valid at the destination so CSRF must
    // reject the browser's real Origin, independently of cookie restrictions.
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-fixture-operator': 'yes' } })
    const page = await context.newPage()
    for (const [path, expectedOrigin] of [['/cross', attackOrigin], ['/null', 'null']]) {
      await page.goto(`${attackOrigin}${path}`)
      const response = await submit(page, 'Submit', '/invites')
      expect(fixture.posts.at(-1)?.origin).toBe(expectedOrigin)
      expect(response.status()).toBe(403)
      expect(await response.json()).toEqual({ error: 'Origin mismatch' })
      expect(invite).not.toHaveBeenCalled()
    }
  })

  it('submits rename, revoke and Tailscale setup forms from their real Hub pages', async () => {
    const fixture = await setup()
    const invitation = fixture.gateway.store.invite('tailcat', 'fixture-endpoint', 'Existing node')
    const node = fixture.gateway.store.enroll({ inviteToken: invitation.token, clientId: 'fixture-node', credential: 'fixture-credential-with-32-characters',
      name: 'Existing node', dshVersion: 'fixture', runtimeId: 'default' })
    const browser = await engine.launch({ headless: true }); cleanups.push(() => browser.close())
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-fixture-operator': 'yes' } })
    const page = await context.newPage()
    page.setDefaultTimeout(2000)
    await page.goto(fixture.origin)
    await page.getByRole('link', { name: 'Existing node', exact: true }).click()
    await page.getByLabel('节点名称').fill('Renamed node')
    expect((await submit(page, '保存名称', `/nodes/${node.id}/rename`)).status()).toBe(303)
    expect(fixture.posts.at(-1)?.origin).toBe(fixture.origin)
    expect(fixture.gateway.store.node(node.id)?.name).toBe('Renamed node')
    await page.getByText('撤销此节点', { exact: true }).click()
    expect((await submit(page, '确认撤销连接', `/nodes/${node.id}/revoke`)).status()).toBe(303)
    expect(fixture.posts.at(-1)?.origin).toBe(fixture.origin)
    expect(fixture.gateway.store.node(node.id)?.revokedAt).not.toBeNull()
    await page.getByRole('link', { name: '连接设置', exact: true }).click()
    expect((await submit(page, '配置并登录 Tailscale', '/network/tailscale/login')).status()).toBe(303)
    expect(fixture.posts.at(-1)?.origin).toBe(fixture.origin)
    expect(fixture.loginTailscale).toHaveBeenCalledTimes(1)
  })

  it('supports native node forms while rejecting cross-node and null origins', async () => {
    const fixture = await setup()
    const privatePort = await listen(fixture.gateway.privateServer)
    const a = await addFormNode(fixture, privatePort, 'A')
    const b = await addFormNode(fixture, privatePort, 'B')
    a.otherOrigin = b.origin
    const browser = await engine.launch({ headless: true }); cleanups.push(() => browser.close())
    const context = await browser.newContext()
    const page = await context.newPage()
    const useCookie = (node: typeof a) => context.addCookies([{ name: 'dsh_gateway_session', value: node.cookie, url: node.origin }])
    for (const node of [a, b]) {
      await useCookie(node)
      const document = await page.goto(node.origin)
      expect(document?.headers()['referrer-policy']).toBe('same-origin')
      expect((await submit(page, 'Submit native', '/api/write')).status()).toBe(200)
      expect(fixture.posts.at(-1)?.origin).toBe(node.origin)
      expect(node.bodies).toEqual(['input=from-native'])
      for (const path of ['/api/json', '/api/attachment', '/api/redirect']) {
        const reply = await context.request.get(`${node.origin}${path}`, { maxRedirects: 0 })
        expect(reply.headers()['referrer-policy']).toBe('no-referrer')
      }
    }
    await useCookie(a)
    await page.goto(`${a.origin}/cross`)
    // Loopback ports share the cookie host. Give the destination its valid
    // cookie so the cross-node rejection proves Origin enforcement, not auth.
    await useCookie(b)
    let response = await submit(page, 'Submit native', '/api/write')
    expect(fixture.posts.at(-1)?.origin).toBe(a.origin)
    expect(response.status()).toBe(403)
    expect(await response.json()).toEqual({ error: 'Origin mismatch' })
    await page.goto(`${b.origin}/null`)
    response = await submit(page, 'Submit native', '/api/write')
    expect(fixture.posts.at(-1)?.origin).toBe('null')
    expect(response.status()).toBe(403)
    expect(await response.json()).toEqual({ error: 'Origin mismatch' })
    expect([a.writes, b.writes]).toEqual([1, 1])
  })
})
