#!/usr/bin/env node

/** Public-documentation completeness, link, asset, and privacy gate. */

import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const required = [
  'README.md', 'README.en.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
  'docs/assets/overview.png', 'docs/assets/nodes.png', 'docs/assets/mobile.png',
  'docs/assets/plugins.png', 'docs/assets/snapshots.png',
  'docs/upstream.md', 'docs/upstream.en.md',
]
const forbidden = [
  /agent\.k1412\.top/iu,
  /\/home\/wuyang/iu,
  /wuyangv?@gmail\.com/iu,
  /(?:mac-neo|wuyang-home|nas-work)/iu,
  /100\.94\.16\.3/gu,
  /DSH_HUB_ENROLLMENT_CODE=['"][A-Za-z0-9_-]{20,}/gu,
  /CF-Access-Client-Secret:\s*\S+/giu,
]

async function filesUnder(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await filesUnder(path))
    else result.push(path)
  }
  return result
}

for (const relative of required) {
  const info = await stat(resolve(root, relative)).catch(() => undefined)
  if (info === undefined || !info.isFile() || info.size === 0) throw new Error(`required public file is missing: ${relative}`)
}

for (const image of required.filter(path => path.endsWith('.png'))) {
  const info = await stat(resolve(root, image))
  if (info.size < 20_000) throw new Error(`documentation screenshot is unexpectedly small: ${image}`)
}

const hubDocs = (await readdir(resolve(root, 'docs/hub'))).filter(name => name.endsWith('.md'))
for (const name of hubDocs) {
  if (name.endsWith('.zh.md')) {
    const mirror = name.replace(/\.zh\.md$/u, '.md')
    if (!hubDocs.includes(mirror)) throw new Error(`English mirror is missing for docs/hub/${name}`)
  } else {
    const mirror = name.replace(/\.md$/u, '.zh.md')
    if (!hubDocs.includes(mirror)) throw new Error(`Chinese primary document is missing for docs/hub/${name}`)
  }
}

const markdown = [
  resolve(root, 'README.md'),
  resolve(root, 'README.en.md'),
  resolve(root, 'CONTRIBUTING.md'),
  resolve(root, 'SECURITY.md'),
  resolve(root, 'docs/upstream.md'),
  resolve(root, 'docs/upstream.en.md'),
  ...(await filesUnder(resolve(root, 'docs/hub'))).filter(path => extname(path) === '.md'),
]

for (const path of markdown) {
  const source = await readFile(path, 'utf8')
  for (const pattern of forbidden) {
    pattern.lastIndex = 0
    if (pattern.test(source)) throw new Error(`private deployment detail matched ${String(pattern)} in ${path.slice(root.length + 1)}`)
  }
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
    let target = match[1]?.trim()
    if (target === undefined || /^(?:https?:|mailto:|#)/u.test(target)) continue
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
    target = target.split('#', 1)[0] ?? ''
    if (target === '') continue
    const info = await stat(resolve(dirname(path), target)).catch(() => undefined)
    if (info === undefined) throw new Error(`broken local link ${target} in ${path.slice(root.length + 1)}`)
  }
}

const chinese = await readFile(resolve(root, 'README.md'), 'utf8')
if (!/[\u3400-\u9fff]/u.test(chinese) || !chinese.includes('## 快速开始') || !chinese.includes('docs/assets/overview.png')) {
  throw new Error('README.md must remain the complete Chinese-first project home')
}
process.stdout.write(`documentation verified: ${String(markdown.length)} Markdown files, ${String(hubDocs.length / 2)} bilingual Hub guides\n`)
