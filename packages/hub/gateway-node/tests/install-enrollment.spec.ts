import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installNode, type EnrollmentManifest } from '../src/install.ts'

const network = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('@k1412/dsh-gateway-network', () => ({ connectNodeNetwork: network.connect }))
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); network.connect.mockReset()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
async function fixture(mode: 'tailcat' | 'tailscale' = 'tailcat') {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-enrollment-')); directories.push(directory)
  const home = join(directory, 'home'); const profile = join(home, 'profiles/web')
  const state = join(directory, 'state')
  const runtimeKey = join(state, 'tailcat-config/tailcat/keys/gateway-node.private.json')
  await mkdir(profile, { recursive: true }); await mkdir(join(state, 'tailcat-config/tailcat/keys'), { recursive: true })
  await writeFile(runtimeKey, 'existing-runtime-identity')
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'existing-profile', dependencies: {}, dsh: { profile: { bundles: ['native-base'] } } }))
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  const dsh = join(directory, 'dsh')
  await writeFile(dsh, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "0.1.7-rc.2\\n"; else exit 0; fi\n', { mode: 0o700 })
  const packageFile = join(directory, 'node.tgz')
  const packed = join(directory, 'package'); await mkdir(join(packed, 'lib'), { recursive: true })
  const packageManifest = JSON.stringify({ name: '@k1412/dsh-gateway-node', version: '2.0.0-alpha.1' })
  await writeFile(join(packed, 'package.json'), packageManifest)
  await writeFile(join(packed, 'lib/index.js'), 'fixture-runtime')
  await writeFile(join(packed, 'lib/cli.js'), 'fixture-cli')
  await promisify(execFile)('tar', ['-czf', packageFile, '-C', directory, 'package'])
  const bytes = await readFile(packageFile)
  const aliasDirectory = join(profile, 'node_modules', '@k1412/dsh-gateway-node-control')
  await mkdir(join(aliasDirectory, 'lib'), { recursive: true })
  await writeFile(join(aliasDirectory, 'package.json'), `${JSON.stringify({ name: '@k1412/dsh-gateway-node-control', version: '2.0.0-alpha.1' }, null, 2)}\n`)
  await writeFile(join(aliasDirectory, 'lib/index.js'), 'fixture-runtime')
  await writeFile(join(aliasDirectory, 'lib/cli.js'), 'fixture-cli')
  const manifest: EnrollmentManifest = { protocol: 1, inviteToken: 'same-invitation', mode,
    hubUrl: 'https://hub.test', endpoint: mode === 'tailcat' ? 'tailcat://fixture' : 'http://100.70.0.1:8081',
    expiresAt: Date.now() + 60_000, packageFile, package: { url: 'https://download.test/node.tgz', sha256: createHash('sha256').update(bytes).digest('hex') } }
  vi.stubEnv('DSH_HOME', home)
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ nodeId: 'stable-node' }))
  const helpers: string[] = []
  const close = vi.fn(async () => {})
  network.connect.mockImplementation(async (options: { stateDirectory: string }) => {
    helpers.push(options.stateDirectory)
    await writeFile(join(options.stateDirectory, 'helper-state'), 'temporary-carrier-key')
    return { url: 'http://127.0.0.1:12345', close, mode, closed: false }
  })
  const run = (claimed = false, allowManagedTailscale?: boolean) => installNode({ manifest: { ...manifest, claimed }, stateDirectory: state, dshExecutable: dsh,
    ...(allowManagedTailscale === undefined ? {} : { allowManagedTailscale }) })
  const named = (stateDirectory: string, packageAlias = '@k1412/dsh-gateway-node-control') => installNode({ manifest: { ...manifest, hubUrl: 'https://experiment.test' }, stateDirectory, instance: 'gateway-node-control', packageAlias, control: true, dshExecutable: dsh })
  return { directory, state, profile, runtimeKey, helpers, close, fetch, run, named }
}

describe('installation enrollment carrier lifetime', () => {
  it('installs an alias without replacing the base dependency, connection or active bundle', async () => {
    const f = await fixture('tailscale')
    const base = await f.run()
    const baseConfig = await readFile(base.connectionFile, 'utf8')
    const baseIdentity = await readFile(join(f.state, 'identity.json'), 'utf8')
    const baseManifest = JSON.parse(await readFile(join(f.profile, 'package.json'), 'utf8'))
    const result = await f.named(join(f.directory, 'aliased-state'), '@k1412/dsh-gateway-node-control')
    const manifest = JSON.parse(await readFile(join(f.profile, 'package.json'), 'utf8'))
    expect(manifest.dependencies['@k1412/dsh-gateway-node']).toBe(baseManifest.dependencies['@k1412/dsh-gateway-node'])
    expect(manifest.dependencies['@k1412/dsh-gateway-node-control']).toMatch(/^file:/)
    expect(manifest.dsh.profile.bundles).toEqual(baseManifest.dsh.profile.bundles)
    expect(await readFile(base.connectionFile, 'utf8')).toBe(baseConfig)
    expect(await readFile(join(f.state, 'identity.json'), 'utf8')).toBe(baseIdentity)
    expect(result.connectionFile).not.toBe(base.connectionFile)
    expect(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8')).toContain(JSON.stringify(join(f.profile, 'node_modules', '@k1412/dsh-gateway-node-control', 'lib/index.js')))
  })

  it('rejects a successful package manager that installed base code under the experimental alias', async () => {
    const f = await fixture('tailscale')
    await f.run()
    const manifest = await readFile(join(f.profile, 'package.json'), 'utf8')
    const patch = await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8')
    await writeFile(join(f.profile, 'node_modules', '@k1412/dsh-gateway-node-control', 'lib/index.js'), 'incorrect-base-runtime')
    await expect(f.named(join(f.directory, 'wrong-package-state'), '@k1412/dsh-gateway-node-control')).rejects.toThrow('profile files restored')
    expect(await readFile(join(f.profile, 'package.json'), 'utf8')).toBe(manifest)
    expect(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8')).toBe(patch)
  })

  it('rejects shared state before changing a different Gateway identity or connection', async () => {
    const f = await fixture('tailscale')
    const base = await f.run()
    const identity = await readFile(join(f.state, 'identity.json'), 'utf8')
    const connection = await readFile(base.connectionFile, 'utf8')
    const calls = network.connect.mock.calls.length
    await expect(f.named(f.state, '@k1412/dsh-gateway-node-control')).rejects.toThrow('own state directory')
    expect(network.connect).toHaveBeenCalledTimes(calls)
    expect(await readFile(join(f.state, 'identity.json'), 'utf8')).toBe(identity)
    expect(await readFile(base.connectionFile, 'utf8')).toBe(connection)
  })

  it('uses fresh private Tailcat state per retry while retaining Hub identity and the active Runtime key', async () => {
    const f = await fixture()
    const modes: number[] = []
    f.close.mockImplementation(async () => { modes.push((await stat(f.helpers.at(-1)!)).mode & 0o777) })
    const first = await f.run()
    const identity = await readFile(join(f.state, 'identity.json'), 'utf8')
    const config = await readFile(first.connectionFile, 'utf8')
    expect(await f.run(true)).toEqual(first)
    expect(await readFile(join(f.state, 'identity.json'), 'utf8')).toBe(identity)
    expect(await readFile(first.connectionFile, 'utf8')).toBe(config)
    expect(JSON.parse(config).stateDir).toBe(f.state)
    expect(f.helpers).toHaveLength(2)
    expect(f.helpers[0]).not.toBe(f.helpers[1])
    for (const helper of f.helpers) {
      expect(helper).toMatch(/\/\.enroll-tailcat-/)
      await expect(stat(helper)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(modes).toEqual([0o700, 0o700])
    expect(f.close).toHaveBeenCalledTimes(2)
    expect(f.fetch.mock.calls[0]?.[1]?.body).toBe(f.fetch.mock.calls[1]?.[1]?.body)
    expect(await readFile(f.runtimeKey, 'utf8')).toBe('existing-runtime-identity')
    expect((await readdir(f.state)).some(name => name.startsWith('.enroll-tailcat-'))).toBe(false)
  })

  it('removes temporary state when helper startup fails and preserves the retry identity', async () => {
    const f = await fixture()
    network.connect.mockImplementation(async (options: { stateDirectory: string }) => {
      f.helpers.push(options.stateDirectory)
      await writeFile(join(options.stateDirectory, 'partial-key'), 'partial-helper')
      throw new Error('Tailcat unavailable')
    })
    await expect(f.run()).rejects.toThrow('Tailcat unavailable')
    await expect(stat(f.helpers[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(join(f.state, 'identity.json'), 'utf8')).clientId).toBeTruthy()
    expect(f.fetch).not.toHaveBeenCalled()
    expect(await readFile(f.runtimeKey, 'utf8')).toBe('existing-runtime-identity')
  })

  it('closes only the enrollment helper and cleans its state after rejection or close failure', async () => {
    const f = await fixture()
    f.fetch.mockResolvedValueOnce(new Response('Rejected', { status: 403 }))
    await expect(f.run()).rejects.toThrow('HTTP 403')
    expect(f.close).toHaveBeenCalledTimes(1)
    await expect(stat(f.helpers[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
    f.close.mockRejectedValueOnce(new Error('Helper close failed'))
    await expect(f.run()).rejects.toThrow('Helper close failed')
    await expect(stat(f.helpers[1]!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(f.runtimeKey, 'utf8')).toBe('existing-runtime-identity')
  })

  it('keeps the persistent Tailscale state used for login and managed daemon recovery', async () => {
    const f = await fixture('tailscale')
    const result = await f.run()
    expect(f.helpers).toEqual([f.state])
    expect(await readFile(join(f.state, 'helper-state'), 'utf8')).toBe('temporary-carrier-key')
    expect(f.close).toHaveBeenCalledTimes(1)
    expect(await readFile(f.runtimeKey, 'utf8')).toBe('existing-runtime-identity')
    expect(network.connect.mock.calls[0]![0]).not.toHaveProperty('allowManagedTailscale')
    expect(JSON.parse(await readFile(result.connectionFile, 'utf8'))).not.toHaveProperty('allowManagedTailscale')
  })

  it('preserves host-only Tailscale reuse through enrollment, saved configuration and retries', async () => {
    const f = await fixture('tailscale')
    const result = await f.run(false, false)
    const identity = await readFile(join(f.state, 'identity.json'), 'utf8')
    const config = await readFile(result.connectionFile, 'utf8')
    expect(JSON.parse(config).allowManagedTailscale).toBe(false)
    expect(await f.run(true, false)).toEqual(result)
    expect(await readFile(join(f.state, 'identity.json'), 'utf8')).toBe(identity)
    expect(await readFile(result.connectionFile, 'utf8')).toBe(config)
    expect(network.connect).toHaveBeenCalledTimes(2)
    for (const [options] of network.connect.mock.calls) expect(options.allowManagedTailscale).toBe(false)
  })
})
