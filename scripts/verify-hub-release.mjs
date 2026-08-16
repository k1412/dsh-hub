#!/usr/bin/env node

/** Install packed Hub node assets into a clean prefix and verify their release shape. */

import { spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const releaseDirectory = resolve(process.argv[2] ?? join(repositoryRoot, 'dist', 'hub-release'))
const version = JSON.parse(await readFile(
  join(repositoryRoot, 'packages', 'hub', 'hub-connector', 'package.json'),
  'utf8',
)).version
const connectorAsset = join(releaseDirectory, `k1412-dsh-hub-connector-${version}.tgz`)
const agentAsset = join(releaseDirectory, `k1412-dsh-hub-node-agent-${version}.tgz`)
const prefix = await mkdtemp(join(tmpdir(), 'dsh-hub-packed-install-'))

try {
  const installed = spawnSync('npm', [
    'install', '--prefix', prefix, '--no-package-lock', '--legacy-peer-deps', agentAsset, connectorAsset,
  ], { cwd: repositoryRoot, stdio: 'inherit', shell: false })
  if (installed.error !== undefined) throw installed.error
  if (installed.status !== 0) process.exit(installed.status ?? 1)

  const connectorRoot = join(prefix, 'node_modules', '@k1412', 'dsh-hub-connector')
  const agentRoot = join(prefix, 'node_modules', '@k1412', 'dsh-hub-node-agent')
  const connector = JSON.parse(await readFile(join(connectorRoot, 'package.json'), 'utf8'))
  const agent = JSON.parse(await readFile(join(agentRoot, 'package.json'), 'utf8'))
  if (connector.name !== '@k1412/dsh-hub-connector' || connector.version !== version) {
    throw new Error('packed Connector identity is incorrect')
  }
  if (agent.name !== '@k1412/dsh-hub-node-agent' || agent.version !== version
    || agent.bin?.['dsh-hub-node'] !== 'lib/bin.js' || agent.dependencies?.['node-pty'] !== '1.1.0') {
    throw new Error('packed Node Agent identity or executable is incorrect')
  }
  if (connector.peerDependencies?.['@deepseek-ai/dsh-host-apiproxy'] !== '0.1.0-rc.5') {
    throw new Error('packed Connector must pin its supported DSH Host gateway version')
  }
  const connectorPatch = await readFile(join(connectorRoot, 'cordis.patch.yml'), 'utf8')
  if (!connectorPatch.includes("name: './node_modules/@k1412/dsh-hub-connector/lib/index.js'")) {
    throw new Error('packed Connector must resolve from the active DSH profile')
  }
  await Promise.all([
    access(join(connectorRoot, 'lib', 'index.js')),
    access(join(connectorRoot, 'cordis.patch.yml')),
    access(join(agentRoot, 'lib', 'bin.js')),
    access(join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh-hub-node.cmd' : 'dsh-hub-node')),
  ])
  const [unixInstaller, windowsInstaller, unixMetadata] = await Promise.all([
    readFile(join(releaseDirectory, 'install-node.sh'), 'utf8'),
    readFile(join(releaseDirectory, 'install-node.ps1'), 'utf8'),
    stat(join(releaseDirectory, 'install-node.sh')),
  ])
  if (unixInstaller.includes('@VERSION@') || windowsInstaller.includes('@VERSION@')
    || !unixInstaller.includes(`DSH_HUB_RELEASE_VERSION='${version}'`)
    || !windowsInstaller.includes(`$ReleaseVersion = '${version}'`)
    || (unixMetadata.mode & 0o111) === 0) {
    throw new Error('packed one-command installers are incomplete or unversioned')
  }
  const shellChecked = spawnSync('bash', ['-n', join(releaseDirectory, 'install-node.sh')], {
    stdio: 'inherit',
    shell: false,
  })
  if (shellChecked.error !== undefined) throw shellChecked.error
  if (shellChecked.status !== 0) process.exit(shellChecked.status ?? 1)
  const checked = spawnSync(process.execPath, ['--check', join(agentRoot, 'lib', 'bin.js')], {
    stdio: 'inherit',
    shell: false,
  })
  if (checked.error !== undefined) throw checked.error
  if (checked.status !== 0) process.exit(checked.status ?? 1)
  process.stdout.write(`hub release verification: ${version} assets install cleanly\n`)
} finally {
  await rm(prefix, { recursive: true, force: true })
}
