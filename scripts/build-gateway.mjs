#!/usr/bin/env node
/** Independent native gateway release; contains no vendored official Web snapshot. */
import { build } from 'esbuild'
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const root = resolve(import.meta.dirname, '..')
const out = join(root, 'dist/gateway')
await rm(out, { recursive: true, force: true })
await mkdir(join(out, 'downloads'), { recursive: true })
const sources = { name: 'gateway-sources', setup(builder) {
  builder.onResolve({ filter: /^@k1412\/dsh-(?:gateway|hub)-/ }, args => ({ path: join(root, 'packages/hub', args.path.slice('@k1412/dsh-'.length), 'src/index.ts') }))
} }
const shared = { absWorkingDir: root, bundle: true, platform: 'node', target: 'node22', format: 'esm', sourcemap: true,
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }, plugins: [sources] }
await build({ ...shared, entryPoints: ['packages/hub/gateway-server/src/bin.ts'], outfile: join(out, 'server.mjs'), external: ['node:*'] })
const pkg = join(out, 'node-package')
await mkdir(join(pkg, 'lib'), { recursive: true })
await build({ ...shared, entryPoints: ['packages/hub/gateway-node/src/index.ts'], outfile: join(pkg, 'lib/index.js'), external: ['node:*', '@deepseek-ai/*'] })
await build({ ...shared, entryPoints: ['packages/hub/gateway-node/src/cli.ts'], outfile: join(pkg, 'lib/cli.js'), external: ['node:*', '@deepseek-ai/*'] })
await build({ absWorkingDir: root, entryPoints: ['packages/hub/gateway-node/src/client.ts'], bundle: true, platform: 'browser', target: 'es2022', format: 'cjs',
  outfile: join(pkg, 'lib/client.js'),
  banner: { js: 'window.__ModuleLoader__.load({id:"@k1412/dsh-gateway-node",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' } })
const source = JSON.parse(await readFile(join(root, 'packages/hub/gateway-node/package.json'), 'utf8'))
await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: source.name, version: source.version, type: 'module', license: 'MIT',
  main: 'lib/index.js', exports: { '.': './lib/index.js', './client': './lib/client.js', './cordis.patch.yml': './cordis.patch.yml', './package.json': './package.json' },
  files: ['lib', 'cordis.patch.yml'], bin: { 'dsh-gateway-node': 'lib/cli.js' }, dsh: source.dsh,
  peerDependencies: source.peerDependencies }, null, 2) + '\n')
await cp(join(root, 'packages/hub/gateway-node/cordis.patch.yml'), join(pkg, 'cordis.patch.yml'))
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', join(out, 'downloads')], { cwd: pkg, encoding: 'utf8' }))[0]
await cp(join(out, 'downloads', packed.filename), join(out, 'downloads/gateway-node.tgz'))
await rm(join(out, 'downloads', packed.filename))
await cp(join(root, 'deploy/gateway/install.sh'), join(out, 'install.sh'))
await cp(join(root, 'deploy/gateway/network-pins.json'), join(out, 'downloads/network-pins.json'))
const digest = createHash('sha256').update(await readFile(join(out, 'downloads/gateway-node.tgz'))).digest('hex')
await writeFile(join(out, 'downloads/SHA256SUMS'), `${digest}  gateway-node.tgz\n`)
console.info(`Native Gateway ${source.version}: server + self-contained node plugin built`)
