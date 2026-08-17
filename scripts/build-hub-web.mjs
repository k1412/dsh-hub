#!/usr/bin/env node

/** Assemble the Hub UI from pinned official Web artifacts and Hub-owned code. */

import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build as esbuild } from 'esbuild'

const repositoryRoot = resolve(import.meta.dirname, '..')
const hubWebRoot = join(repositoryRoot, 'apps', 'hub-web')
const outputRoot = join(hubWebRoot, 'dist')
const snapshotRoot = join(repositoryRoot, 'third_party', 'official-web')

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function clientExport(manifest) {
  const value = manifest.exports?.['./client']
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    if (typeof value.default === 'string') return value.default
    if (typeof value.import === 'string') return value.import
  }
  return undefined
}

async function buildSetupPage() {
  await esbuild({
    entryPoints: [join(hubWebRoot, 'src', 'setup.ts')],
    bundle: true,
    format: 'esm',
    minify: true,
    outfile: join(outputRoot, 'setup.js'),
    sourcemap: false,
  })
  const template = await readFile(join(hubWebRoot, 'setup.html'), 'utf8')
  const html = template
    .replace('<script type="module" src="/src/setup.ts"></script>', '<script type="module" src="/setup.js"></script>')
    .replace('</head>', '<link rel="stylesheet" href="/setup.css" /></head>')
  await writeFile(join(outputRoot, 'setup.html'), html)
}

/** Build the immutable browser boot graph and copy every pinned bundle. */
export async function buildHubWeb() {
  const snapshot = JSON.parse(await readFile(join(snapshotRoot, 'snapshot.json'), 'utf8'))
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.entries) || snapshot.entries.length === 0) {
    throw new Error('third_party/official-web/snapshot.json has an unsupported shape')
  }
  await rm(outputRoot, { recursive: true, force: true })
  await cp(join(snapshotRoot, 'dist'), outputRoot, { recursive: true })

  const entries = []
  for (const item of snapshot.entries) {
    if (typeof item?.id !== 'string' || !item.id.startsWith('@deepseek-ai/')) {
      throw new Error('official snapshot entries must be @deepseek-ai package descriptors')
    }
    const name = item.id
    const source = join(snapshotRoot, 'dist', 'plugins', name, 'client.js')
    const bytes = await readFile(source)
    const rev = shortHash(bytes)
    entries.push({
      id: name,
      url: `/plugins/${name}/client.js?rev=${rev}`,
      rev,
      ...(Array.isArray(item.inject) ? { inject: item.inject } : {}),
      ...(item.immediately === true ? { immediately: true } : {}),
    })
  }

  const hubPackageRoot = join(repositoryRoot, 'packages', 'hub', 'hub-client-ui')
  const hubManifest = JSON.parse(await readFile(join(hubPackageRoot, 'package.json'), 'utf8'))
  const hubExport = clientExport(hubManifest)
  if (hubExport === undefined || hubManifest.dsh?.client?.platform !== 'web') {
    throw new Error('@k1412/dsh-hub-client-ui is missing its DSH Web client declaration')
  }
  const hubSource = resolve(hubPackageRoot, hubExport)
  const hubBytes = await readFile(hubSource)
  const hubRev = shortHash(hubBytes)
  const hubDestination = join(outputRoot, 'plugins', hubManifest.name, 'client.js')
  await mkdir(dirname(hubDestination), { recursive: true })
  await writeFile(hubDestination, hubBytes)
  await cp(`${hubSource}.map`, `${hubDestination}.map`).catch((error) => {
    if (error?.code !== 'ENOENT') throw error
  })
  entries.push({
    id: hubManifest.name,
    url: `/plugins/${hubManifest.name}/client.js?rev=${hubRev}`,
    rev: hubRev,
    inject: hubManifest.dsh.client.inject,
  })

  const graph = { rev: shortHash(JSON.stringify(entries)), entries }
  await writeFile(join(outputRoot, 'boot.js'), renderBootScript(graph))
  const indexPath = join(outputRoot, 'index.html')
  const officialHtml = await readFile(indexPath, 'utf8')
  if (!officialHtml.includes('</head>')) throw new Error('official Web artifact has no </head>')
  const additions = [
    '<meta name="dsh-settings-access" content="authenticated-control-plane" />',
    '<script src="/boot.js"></script>',
  ].join('')
  const html = officialHtml
    .replace('<title>DeepSeek Harness</title>', '<title>DSH Hub</title>')
    .replace('</head>', `${additions}</head>`)
  await writeFile(indexPath, html)
  await buildSetupPage()
  await cp(join(hubWebRoot, 'src', 'setup.css'), join(outputRoot, 'setup.css'))
  await cp(join(repositoryRoot, 'LICENSE'), join(outputRoot, 'LICENSE.txt'))
  await cp(join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), join(outputRoot, 'THIRD_PARTY_NOTICES.md'))
  process.stdout.write(`Hub Web: reviewed official snapshot + ${String(entries.length)} plugins (${graph.rev})\n`)
  return graph
}

export function renderBootScript(graph) {
  const json = JSON.stringify(graph).replaceAll('<', '\\u003c')
  return 'globalThis.__zod_globalConfig = { ...globalThis.__zod_globalConfig, jitless: true };\n'
    + `window.__DSH_BOOT__ = ${json};\n`
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await buildHubWeb()
}
