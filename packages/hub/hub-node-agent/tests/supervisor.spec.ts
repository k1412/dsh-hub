import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HubEnvelopeBody } from '@k1412/dsh-hub-protocol'
import { HubNodeSupervisor } from '../src/supervisor.ts'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Node Agent management supervisor', () => {
  it('creates idempotent snapshots that exclude known secret-file classes and restore only allowlisted files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hub-supervisor-'))
    roots.push(root)
    const profile = join(root, 'profile')
    const data = join(root, 'sessions')
    await mkdir(profile)
    await mkdir(data)
    await writeFile(join(profile, 'package.json'), '{"dependencies":{}}\n')
    await writeFile(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    await writeFile(join(profile, 'cordis.yml'), '- name: original\n')
    await writeFile(join(profile, '.env'), 'TOKEN=must-not-enter-snapshot\n')
    await writeFile(join(data, 'session.jsonl'), '{"event":"safe"}\n')
    await writeFile(join(data, 'access-token.txt'), 'excluded\n')

    const supervisor = new HubNodeSupervisor(join(root, 'state'), {
      runtimeId: 'web-runtime',
      profileDirectory: profile,
      profileName: 'web',
      dshExecutable: 'dsh',
      snapshotPaths: [data],
    })
    const inventory = await supervisor.invoke('dsh.plugins', 'inventory', {}) as {
      plugins: unknown[]
      lockHash: string
    }
    expect(inventory.plugins).toEqual([])
    expect(inventory.lockHash).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const created = await supervisor.invoke('dsh.snapshots', 'create', {
      clientMutationId: 'snapshot-mutation-0001', type: 'configuration', includeSecretValues: false,
    }) as { snapshotId: string; artifactHash: string; manifest: { fileCount: number } }
    const duplicate = await supervisor.invoke('dsh.snapshots', 'create', {
      clientMutationId: 'snapshot-mutation-0001', type: 'configuration', includeSecretValues: false,
    }) as { snapshotId: string; artifactHash: string }
    expect(duplicate).toMatchObject({ snapshotId: created.snapshotId, artifactHash: created.artifactHash })
    expect(created.manifest.fileCount).toBe(1)

    await writeFile(join(profile, 'cordis.yml'), '- name: changed\n')
    await writeFile(join(profile, '.env'), 'TOKEN=changed-but-still-local\n')
    await supervisor.invoke('dsh.snapshots', 'restore', {
      clientMutationId: 'snapshot-restore-0001', snapshotId: created.snapshotId,
    })
    expect(await readFile(join(profile, 'cordis.yml'), 'utf8')).toBe('- name: original\n')
    expect(await readFile(join(profile, '.env'), 'utf8')).toBe('TOKEN=changed-but-still-local\n')

    const dataSnapshot = await supervisor.invoke('dsh.snapshots', 'create', {
      clientMutationId: 'snapshot-mutation-0002', type: 'data', includeSecretValues: false,
    }) as { manifest: { fileCount: number } }
    expect(dataSnapshot.manifest.fileCount).toBe(1)
  })

  it('provides optimistic file operations and transient PTY output under the Agent account', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hub-supervisor-io-'))
    roots.push(root)
    const profile = join(root, 'profile')
    await mkdir(profile)
    await writeFile(join(profile, 'package.json'), '{"dependencies":{}}\n')
    const frames: HubEnvelopeBody[] = []
    const supervisor = new HubNodeSupervisor(join(root, 'state'), {
      runtimeId: 'web-runtime',
      profileDirectory: profile,
      profileName: 'web',
      dshExecutable: 'dsh',
      snapshotPaths: [],
    }, frame => frames.push(frame))

    const target = join(root, 'workspace', 'note.txt')
    const written = await supervisor.invoke('dsh.files', 'write', {
      path: target, expectedHash: null, encoding: 'utf8', data: 'shared file\n',
    }) as { contentHash: string; size: number }
    expect(written.size).toBe(12)
    const read = await supervisor.invoke('dsh.files', 'read', {
      path: target, offset: 0, maxBytes: 1024,
    }) as { data: string; contentHash: string; eof: boolean }
    expect(read).toMatchObject({ data: 'shared file\n', contentHash: written.contentHash, eof: true })
    const listed = await supervisor.invoke('dsh.files', 'list', {
      path: dirname(target), limit: 100,
    }) as { entries: Array<{ path: string; kind: string }> }
    expect(listed.entries).toContainEqual(expect.objectContaining({ path: target, kind: 'file' }))

    const opened = await supervisor.invoke('dsh.terminals', 'open', {
      clientMutationId: 'terminal-mutation-0001', cwd: root, shell: '/bin/sh', columns: 80, rows: 24,
    }, 'web-runtime') as { terminalId: string }
    await supervisor.invoke('dsh.terminals', 'write', {
      terminalId: opened.terminalId, encoding: 'utf8', data: 'printf hub-pty-ok; exit\n',
    }, 'web-runtime')
    await vi.waitFor(() => {
      expect(frames.some(frame =>
        frame.type === 'stream.frame'
        && frame.runtimeId === 'web-runtime'
        && typeof frame.payload === 'object'
        && frame.payload !== null
        && !Array.isArray(frame.payload)
        && typeof frame.payload.data === 'string'
        && frame.payload.data.includes('hub-pty-ok'))).toBe(true)
    })
    supervisor.close()
  })

  it('tracks the installed package version for exact tarball apply and rollback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hub-supervisor-plugin-'))
    roots.push(root)
    const profile = join(root, 'profile')
    const state = join(root, 'state')
    const executable = join(root, 'fake-dsh.mjs')
    await mkdir(profile)
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      dependencies: {}, dsh: { profile: { bundles: [] } },
    }))
    await writeFile(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    await writeFile(executable, `#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const args = process.argv.slice(2)
const profile = join(process.cwd(), 'profile')
const manifestPath = join(profile, 'package.json')
const installed = join(profile, 'node_modules', '@example', 'hub-plugin')
if (args[0] === 'plugin' && args.includes('add')) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.dependencies['@example/hub-plugin'] = 'file:../state/management/artifacts/plugin.tgz'
  manifest.dsh.profile.bundles.push('@example/hub-plugin')
  await writeFile(manifestPath, JSON.stringify(manifest))
  await writeFile(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\\nplugin: 1.2.3\\n')
  await mkdir(installed, { recursive: true })
  await writeFile(join(installed, 'package.json'), JSON.stringify({
    name: '@example/hub-plugin', version: '1.2.3', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
} else if (args[0] === 'plugin' && args.includes('install')) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.dependencies['@example/hub-plugin'] === undefined) await rm(installed, { recursive: true, force: true })
}
`)
    await chmod(executable, 0o700)

    const artifact = Buffer.from('verified plugin tarball')
    const artifactHash = createHash('sha256').update(artifact).digest('base64url')
    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.pathname.endsWith('/1.2.3')) {
        return Response.json({
          name: '@example/hub-plugin',
          version: '1.2.3',
          dist: { tarball: 'https://registry.npmjs.org/example-hub-plugin/-/example-hub-plugin-1.2.3.tgz' },
        })
      }
      if (url.pathname.endsWith('/example-hub-plugin-1.2.3.tgz')) return new Response(artifact)
      return new Response('not found', { status: 404 })
    }))
    const supervisor = new HubNodeSupervisor(state, {
      runtimeId: 'web-runtime',
      profileDirectory: profile,
      profileName: 'web',
      dshExecutable: executable,
      snapshotPaths: [],
    })
    const before = await supervisor.invoke('dsh.plugins', 'inventory', {}) as {
      plugins: unknown[]
      lockHash: string
    }
    const applied = await supervisor.invoke('dsh.plugins', 'apply', {
      clientMutationId: 'plugin-apply-0001',
      packageName: '@example/hub-plugin',
      version: '1.2.3',
      expectedLockHash: before.lockHash,
    }) as {
      plugin: { version: string; artifactHash: string; healthy: boolean }
      change: { changeId: string; status: string }
      lockHash: string
    }
    expect(applied.plugin).toMatchObject({ version: '1.2.3', artifactHash, healthy: true })
    expect(applied.change).toMatchObject({ status: 'applied' })
    const installedManifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>
    }
    expect(installedManifest.dependencies?.['@example/hub-plugin']).toMatch(/^file:/)

    const restored = await supervisor.invoke('dsh.plugins', 'rollback', {
      clientMutationId: 'plugin-rollback-0001',
      changeId: applied.change.changeId,
      expectedLockHash: applied.lockHash,
    }) as { plugins: unknown[]; lockHash: string; change: { status: string } }
    expect(restored).toMatchObject({ plugins: [], lockHash: before.lockHash, change: { status: 'rolled-back' } })
  })

  it.skipIf(process.platform === 'win32')('refuses snapshot restore through a symlinked parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hub-supervisor-symlink-'))
    roots.push(root)
    const profile = join(root, 'profile')
    const data = join(root, 'data')
    const nested = join(data, 'nested')
    const outside = join(root, 'outside')
    await mkdir(profile)
    await mkdir(nested, { recursive: true })
    await mkdir(outside)
    await writeFile(join(profile, 'package.json'), '{"dependencies":{}}\n')
    await writeFile(join(nested, 'state.txt'), 'inside\n')
    const supervisor = new HubNodeSupervisor(join(root, 'state'), {
      runtimeId: 'web-runtime',
      profileDirectory: profile,
      profileName: 'web',
      dshExecutable: 'dsh',
      snapshotPaths: [data],
    })
    const created = await supervisor.invoke('dsh.snapshots', 'create', {
      clientMutationId: 'snapshot-symlink-0001', type: 'data', includeSecretValues: false,
    }) as { snapshotId: string }
    await rm(nested, { recursive: true })
    await symlink(outside, nested, 'dir')
    await expect(supervisor.invoke('dsh.snapshots', 'restore', {
      clientMutationId: 'snapshot-symlink-restore-0001', snapshotId: created.snapshotId,
    })).rejects.toThrow(/symlinked parent/)
  })

  it.skipIf(process.platform === 'win32')('preflights every snapshot target before changing any file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hub-supervisor-preflight-'))
    roots.push(root)
    const profile = join(root, 'profile')
    const data = join(root, 'data')
    const nested = join(data, 'nested')
    const outside = join(root, 'outside')
    await mkdir(profile)
    await mkdir(nested, { recursive: true })
    await mkdir(outside)
    await writeFile(join(profile, 'package.json'), '{"dependencies":{}}\n')
    await writeFile(join(data, 'first.txt'), 'snapshot-first\n')
    await writeFile(join(nested, 'second.txt'), 'snapshot-second\n')
    const supervisor = new HubNodeSupervisor(join(root, 'state'), {
      runtimeId: 'web-runtime',
      profileDirectory: profile,
      profileName: 'web',
      dshExecutable: 'dsh',
      snapshotPaths: [data],
    })
    const created = await supervisor.invoke('dsh.snapshots', 'create', {
      clientMutationId: 'snapshot-preflight-0001', type: 'data', includeSecretValues: false,
    }) as { snapshotId: string }
    await writeFile(join(data, 'first.txt'), 'current-first\n')
    await rm(nested, { recursive: true })
    await symlink(outside, nested, 'dir')

    await expect(supervisor.invoke('dsh.snapshots', 'restore', {
      clientMutationId: 'snapshot-preflight-restore-0001', snapshotId: created.snapshotId,
    })).rejects.toThrow(/symlinked parent/)
    expect(await readFile(join(data, 'first.txt'), 'utf8')).toBe('current-first\n')
  })
})
