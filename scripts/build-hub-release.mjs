#!/usr/bin/env node

/** Build self-contained Hub Node Agent and DSH Connector release tarballs. */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { build } from 'esbuild'

const repositoryRoot = resolve(import.meta.dirname, '..')
const output = resolve(process.argv[2] ?? join(repositoryRoot, 'dist', 'hub-release'))
const temporary = await mkdtemp(join(tmpdir(), 'dsh-hub-release-'))
const banner = "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
const hubSourcePlugin = {
  name: 'hub-workspace-source',
  setup(build) {
    build.onResolve({ filter: /^@k1412\/dsh-hub-/ }, args => ({
      path: join(repositoryRoot, 'packages', 'hub', args.path.slice('@k1412/dsh-'.length), 'src', 'index.ts'),
    }))
  },
}

async function manifest(path) {
  return JSON.parse(await readFile(join(repositoryRoot, path, 'package.json'), 'utf8'))
}

async function pack(directory) {
  await new Promise((resolvePack, reject) => {
    const child = spawn('npm', ['pack', '--pack-destination', output], {
      cwd: directory,
      shell: false,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolvePack() : reject(new Error(`npm pack failed with ${String(code)}`)))
  })
}

async function installScript(source, destination, version, executable = false) {
  const template = await readFile(join(repositoryRoot, source), 'utf8')
  if (!template.includes('@VERSION@')) throw new Error(`${source} is missing its release version marker`)
  await writeFile(join(output, destination), template.replaceAll('@VERSION@', version))
  if (executable) await chmod(join(output, destination), 0o755)
}

async function writeChecksums() {
  const assets = (await readdir(output)).filter(file => file.endsWith('.tgz')).sort()
  if (assets.length !== 2) throw new Error(`expected two packed Hub assets, received ${String(assets.length)}`)
  const lines = await Promise.all(assets.map(async (asset) => {
    const digest = createHash('sha256').update(await readFile(join(output, asset))).digest('hex')
    return `${digest}  ${asset}`
  }))
  await writeFile(join(output, 'SHA256SUMS'), `${lines.join('\n')}\n`)
}

try {
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })

  const connectorSource = 'packages/hub/hub-connector'
  const connectorManifest = await manifest(connectorSource)
  const connectorRoot = join(temporary, 'connector')
  await mkdir(join(connectorRoot, 'lib'), { recursive: true })
  await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [`${connectorSource}/src/index.ts`],
    outfile: join(connectorRoot, 'lib', 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    banner: { js: banner },
    plugins: [hubSourcePlugin],
    external: [
      'node:*',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-host-apiproxy',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-session/*',
      '@deepseek-ai/schemastery',
    ],
  })
  await cp(join(repositoryRoot, connectorSource, 'cordis.patch.yml'), join(connectorRoot, 'cordis.patch.yml'))
  await cp(join(repositoryRoot, connectorSource, 'README.md'), join(connectorRoot, 'README.md'))
  await cp(join(repositoryRoot, connectorSource, 'README.zh.md'), join(connectorRoot, 'README.zh.md'))
  await writeFile(join(connectorRoot, 'package.json'), `${JSON.stringify({
    name: connectorManifest.name,
    version: connectorManifest.version,
    description: connectorManifest.description,
    type: 'module',
    main: 'lib/index.js',
    exports: { '.': './lib/index.js', './cordis.patch.yml': './cordis.patch.yml' },
    files: ['lib', 'cordis.patch.yml', 'README.md', 'README.zh.md'],
    license: 'MIT',
    repository: connectorManifest.repository,
    dsh: connectorManifest.dsh,
    peerDependencies: {
      '@deepseek-ai/cordis': '4.0.1',
      '@deepseek-ai/dsh-host-apiproxy': '0.1.0-rc.5',
      '@deepseek-ai/dsh-session': '0.1.0-rc.5',
      '@deepseek-ai/schemastery': '3.18.1',
    },
  }, null, 2)}\n`)
  await pack(connectorRoot)

  const agentSource = 'packages/hub/hub-node-agent'
  const agentManifest = await manifest(agentSource)
  const agentRoot = join(temporary, 'node-agent')
  await mkdir(join(agentRoot, 'lib'), { recursive: true })
  await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [`${agentSource}/src/bin.ts`],
    outfile: join(agentRoot, 'lib', 'bin.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    banner: { js: banner },
    plugins: [hubSourcePlugin],
    external: ['node:*', 'node-pty'],
  })
  await cp(join(repositoryRoot, agentSource, 'README.md'), join(agentRoot, 'README.md'))
  await cp(join(repositoryRoot, agentSource, 'README.zh.md'), join(agentRoot, 'README.zh.md'))
  await writeFile(join(agentRoot, 'package.json'), `${JSON.stringify({
    name: agentManifest.name,
    version: agentManifest.version,
    description: agentManifest.description,
    type: 'module',
    main: 'lib/bin.js',
    bin: { 'dsh-hub-node': 'lib/bin.js' },
    files: ['lib', 'README.md', 'README.zh.md'],
    license: 'MIT',
    repository: agentManifest.repository,
    engines: { node: '^22.19.0 || >=24.0.0' },
    dependencies: { 'node-pty': '1.1.0' },
  }, null, 2)}\n`)
  await pack(agentRoot)

  await Promise.all([
    installScript('deploy/node/install-node.sh', 'install-node.sh', agentManifest.version, true),
    installScript('deploy/node/install-node.ps1', 'install-node.ps1', agentManifest.version),
  ])
  await writeChecksums()

  const files = await readdir(output)
  process.stdout.write(`Hub release assets: ${files.map(file => basename(file)).join(', ')}\n`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
