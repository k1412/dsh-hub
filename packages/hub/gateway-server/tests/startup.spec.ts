import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const accessKeys = ['DSH_GATEWAY_CF_TEAM_DOMAIN', 'DSH_GATEWAY_CF_AUDIENCE', 'DSH_GATEWAY_OPERATOR_EMAILS'] as const
const completeAccess = ['test.cloudflareaccess.com', 'test-audience', 'owner@example.invalid'] as const
const password = 'startup-test-owner-password'
const children: { child: ChildProcess; exited: Promise<unknown> }[] = []
let directory: string
let entry: string

// Run the real entry point, including env/auth-file parsing and HTTP auth setup.
// Missing binaries in an isolated directory prevent starting any host overlay.
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-gateway-startup-'))
  entry = join(directory, 'server.mjs')
  await mkdir(join(directory, 'no-network-binaries'))
  await build({ entryPoints: [resolve(import.meta.dirname, '../src/bin.ts')], outfile: entry,
    bundle: true, platform: 'node', target: 'node22', format: 'esm', external: ['node:*'],
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  })
})

afterEach(async () => {
  await Promise.all(children.splice(0).map(async ({ child, exited }) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    try { await exited } finally { clearTimeout(timer) }
  }))
})
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

async function reservePort() {
  const server = createServer()
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test listener address')
  return { port: address.port, release: () => new Promise<void>((ok, fail) => server.close(error => error ? fail(error) : ok())) }
}

async function startOnce(access: readonly (string | undefined)[], auth?: Record<string, unknown>, ownerPassword = password) {
  const state = await mkdtemp(join(directory, 'state-'))
  const publicPort = await reservePort()
  const privatePort = await reservePort()
  const origin = `http://127.0.0.1:${publicPort.port}`
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_GATEWAY_')))
  Object.assign(env, { PORT: String(publicPort.port), DSH_GATEWAY_PRIVATE_PORT: String(privatePort.port),
    DSH_GATEWAY_PUBLIC_URL: origin, DSH_GATEWAY_HOST: '127.0.0.1', DSH_GATEWAY_STATE_DIRECTORY: state,
    DSH_GATEWAY_NETWORK_BIN: join(directory, 'no-network-binaries'), DSH_GATEWAY_OWNER_PASSWORD: ownerPassword,
  })
  accessKeys.forEach((key, index) => { if (access[index] !== undefined) env[key] = access[index] })
  if (auth) {
    env.DSH_GATEWAY_AUTH_FILE = join(state, 'auth.json')
    await writeFile(env.DSH_GATEWAY_AUTH_FILE, JSON.stringify(auth), { mode: 0o600 })
  }
  await Promise.all([publicPort.release(), privatePort.release()])
  const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const ready = new Promise<boolean>((ok, fail) => {
    child.once('error', fail)
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.includes('listening on port')) ok(true) })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
  })
  const exited = new Promise<number | null>(ok => child.once('close', code => ok(code)))
  children.push({ child, exited })
  return { origin, started: await Promise.race([ready, exited.then(() => false)]), exited, output: () => output }
}

async function start(access: readonly (string | undefined)[], auth?: Record<string, unknown>, ownerPassword = password) {
  // The real CLI requires numbered ports, so reservation and child bind cannot
  // be atomic. Other parallel fixtures may claim a released ephemeral port.
  // Reallocate only for that exact pre-start listen error, at most three times;
  // auth failures and any failure after readiness remain ordinary test failures.
  for (let attempt = 0; ; attempt++) {
    const service = await startOnce(access, auth, ownerPassword)
    if (service.started || !service.output().includes('listen EADDRINUSE') || attempt === 2) return service
    console.warn('Startup fixture port claimed before child bind; allocating a new isolated pair')
  }
}

async function assertPasswordLogin(service: Awaited<ReturnType<typeof start>>) {
  expect(service.started, service.output()).toBe(true)
  const loginPage = await fetch(`${service.origin}/login`)
  expect(loginPage.status).toBe(200)
  await loginPage.text()
  const login = await fetch(`${service.origin}/login`, { method: 'POST', redirect: 'manual',
    headers: { origin: service.origin }, body: new URLSearchParams({ password }),
  })
  expect(login.status).toBe(303)
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  expect(cookie).toBeTruthy()
  const nodes = await fetch(`${service.origin}/api/nodes`, { headers: { cookie: cookie ?? '' } })
  expect(nodes.status).toBe(200)
  await nodes.json()
}

describe('Gateway actual process authentication startup', () => {
  it.each([
    { name: 'absent', access: [] },
    { name: 'Compose empty strings', access: ['', '', ''] },
    { name: 'whitespace', access: ['  ', '\t', ' \n '] },
  ])('accepts password mode when Access settings are $name', async ({ access }) => {
    await assertPasswordLogin(await start(access))
  })

  it.each([1, 2, 3, 4, 5, 6])('rejects partial nonempty Access settings (mask %i) even with a valid password', async mask => {
    const service = await start(completeAccess.map((value, index) => mask & (1 << index) ? value : ' '))
    expect(service.started, service.output()).toBe(false)
    expect(await service.exited).not.toBe(0)
    expect(service.output()).toContain('Cloudflare authentication requires team domain, audience and operator emails together')
  })

  it.each([',', 'owner@example.invalid, '])('rejects malformed email lists %j instead of falling back to password', async emails => {
    const service = await start(['test.cloudflareaccess.com', 'test-audience', emails])
    expect(service.started, service.output()).toBe(false)
    expect(await service.exited).not.toBe(0)
    expect(service.output()).toContain('Cloudflare authentication requires')
  })

  it('requires an owner password when all Access values are blank', async () => {
    const service = await start(['', '', ''], undefined, '')
    expect(service.started, service.output()).toBe(false)
    expect(service.output()).toContain('Configure operator authentication before starting Hub')
  })

  it('uses complete Access configuration without allowing password login', async () => {
    const service = await start(completeAccess)
    expect(service.started, service.output()).toBe(true)
    for (const path of ['/', '/login', '/api/nodes']) {
      const response = await fetch(`${service.origin}${path}`, { redirect: 'manual' })
      expect(response.status).toBe(401)
      await response.text()
    }
    const response = await fetch(`${service.origin}/login`, { method: 'POST', redirect: 'manual',
      headers: { origin: service.origin }, body: new URLSearchParams({ password }),
    })
    expect(response.status).toBe(401)
    expect(response.headers.has('set-cookie')).toBe(false)
    await response.text()
  })

  it('treats blank auth-file Access values as absent without changing file precedence', async () => {
    await assertPasswordLogin(await start(completeAccess, { teamDomain: ' ', audience: '', operatorEmails: [] }))
    const service = await start(['', '', ''], { teamDomain: 'test.cloudflareaccess.com' })
    expect(service.started, service.output()).toBe(false)
    expect(service.output()).toContain('Cloudflare authentication requires')
  })
})
