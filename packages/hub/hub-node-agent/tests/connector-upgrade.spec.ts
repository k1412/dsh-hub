import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { upgradeConnectorPackage } from '../src/connector-upgrade.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Connector in-place upgrade', () => {
  it('replaces an expired temporary tarball reference before reconciling DSH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hub-upgrade-'))
    roots.push(root)
    const profile = join(root, 'profile')
    const artifact = join(root, 'packages', 'connector-1.0.4.tgz')
    await mkdir(join(root, 'packages'), { recursive: true })
    await mkdir(profile)
    await writeFile(artifact, 'verified release artifact')
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      private: true,
      dependencies: { '@k1412/dsh-hub-connector': 'file:/tmp/deleted-installer/connector-old.tgz' },
    }))
    const run = vi.fn(async () => undefined)

    await upgradeConnectorPackage({
      profileDirectory: profile,
      profileName: 'web',
      dshExecutable: '/usr/local/bin/dsh',
      connectorPackage: artifact,
      run,
    })

    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(manifest.dependencies['@k1412/dsh-hub-connector']).toBe(`file:${artifact}`)
    expect(run).toHaveBeenCalledWith('/usr/local/bin/dsh', ['plugin', '--profile', 'web', 'install'])
  })
})
