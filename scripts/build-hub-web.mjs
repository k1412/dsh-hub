#!/usr/bin/env node

/** Compose the official DSH browser roster into a static Hub distribution. */

import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'

const repositoryRoot = resolve(import.meta.dirname, '..')
const hubWebRoot = join(repositoryRoot, 'apps', 'hub-web')
const outputRoot = join(hubWebRoot, 'dist')
const jsType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: source => source,
})
const patchSchema = yaml.DEFAULT_SCHEMA.extend([jsType])

/** Reviewed browser-only rows required by the Hub composition. */
export const HUB_CLIENT_ROWS = Object.freeze([
  // Hub does not run the official Host directory-picker auto-composer. The
  // browser flow still calls the selected node through the official Web API.
  { id: 'hub-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
  { id: 'hub-client-ui', name: '@k1412/dsh-hub-client-ui' },
])

function shortHash(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 12)
}

async function packageDirectories() {
  const directories = []
  for (const root of ['vendor', 'packages', 'apps']) {
    const first = await readdir(join(repositoryRoot, root), { withFileTypes: true })
    for (const entry of first) {
      if (!entry.isDirectory()) continue
      const directory = join(repositoryRoot, root, entry.name)
      if (root === 'apps') {
        directories.push(directory)
        continue
      }
      const second = await readdir(directory, { withFileTypes: true })
      for (const child of second) {
        if (child.isDirectory()) directories.push(join(directory, child.name))
      }
    }
  }
  return directories
}

async function packageMap() {
  const result = new Map()
  for (const directory of await packageDirectories()) {
    const path = join(directory, 'package.json')
    let manifest
    try {
      manifest = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (typeof manifest.name === 'string') result.set(manifest.name, { directory, manifest })
  }
  return result
}

async function parsePatch(path) {
  const source = await readFile(path, 'utf8')
  const value = yaml.load(source, { schema: patchSchema })
  if (!Array.isArray(value)) throw new Error(`${relative(repositoryRoot, path)} must contain a patch array`)
  return value
}

/** Apply the subset of Cordis patch semantics needed to determine active package rows. */
export function composeRows(patches) {
  const rows = []
  for (const patch of patches.flat()) {
    if (typeof patch !== 'object' || patch === null) continue
    if (Array.isArray(patch.insert)) {
      for (const inserted of patch.insert) rows.push({ ...inserted })
      continue
    }
    if (typeof patch.id !== 'string') continue
    const index = rows.findIndex(row => row.id === patch.id)
    if (index === -1) throw new Error(`Hub Web roster patch references unknown row ${patch.id}`)
    rows[index] = { ...rows[index], ...patch }
  }
  return rows
}

function clientExport(manifest) {
  const value = manifest.exports?.['./client']
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null && typeof value.default === 'string') return value.default
  return undefined
}

/** Build the browser boot graph and copy every graph-owned bundle. */
export async function buildHubWeb() {
  const packages = await packageMap()
  const patches = await Promise.all([
    parsePatch(join(repositoryRoot, 'packages', 'bundle', 'base', 'cordis.patch.yml')),
    parsePatch(join(repositoryRoot, 'packages', 'bundle', 'web-app', 'cordis.patch.yml')),
  ])
  const rows = composeRows(patches)
  rows.push(...HUB_CLIENT_ROWS)
  const entries = []
  for (const row of rows) {
    if (row.disabled === true || typeof row.name !== 'string') continue
    const pkg = packages.get(row.name)
    if (pkg === undefined) continue
    const declaration = pkg.manifest.dsh?.client
    if (declaration?.platform !== 'web') continue
    const exported = clientExport(pkg.manifest)
    if (exported === undefined) throw new Error(`${row.name} declares dsh.client but has no ./client export`)
    const source = resolve(pkg.directory, exported)
    const bytes = await readFile(source).catch((error) => {
      if (error?.code === 'ENOENT') {
        throw new Error(`Hub Web client bundle is missing: ${relative(repositoryRoot, source)}; run the client library build first`)
      }
      throw error
    })
    const rev = shortHash(bytes)
    const destination = join(outputRoot, 'plugins', row.name, 'client.js')
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, bytes)
    await cp(`${source}.map`, `${destination}.map`).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
    entries.push({
      id: row.name,
      url: `/plugins/${row.name}/client.js?rev=${rev}`,
      rev,
      ...(Array.isArray(declaration.inject) ? { inject: declaration.inject } : {}),
      ...(declaration.immediately === true ? { immediately: true } : {}),
    })
  }
  const graph = { rev: shortHash(JSON.stringify(entries)), entries }
  await writeFile(join(outputRoot, 'boot.js'), renderBootScript(graph))
  const indexPath = join(outputRoot, 'index.html')
  const html = await readFile(indexPath, 'utf8')
  const bootScript = '<script src="/boot.js"></script>'
  if (!html.includes('</head>')) throw new Error('Hub Web built index has no </head>')
  await writeFile(indexPath, html.replace('</head>', `${bootScript}</head>`))
  await cp(join(repositoryRoot, 'LICENSE'), join(outputRoot, 'LICENSE.txt'))
  await cp(join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), join(outputRoot, 'THIRD_PARTY_NOTICES.md'))
  process.stdout.write(`Hub Web: official shell + ${String(entries.length)} client plugins (${graph.rev})\n`)
  return graph
}

/**
 * Render startup state that must exist before the deferred Web entry executes.
 * @param {unknown} graph - reviewed static client-plugin graph.
 * @returns {string} classic startup script content.
 */
export function renderBootScript(graph) {
  const json = JSON.stringify(graph).replaceAll('<', '\\u003c')
  return 'globalThis.__zod_globalConfig = { ...globalThis.__zod_globalConfig, jitless: true };\n'
    + `window.__DSH_BOOT__ = ${json};\n`
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await buildHubWeb()
}
