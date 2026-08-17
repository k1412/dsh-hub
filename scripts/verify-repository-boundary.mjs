#!/usr/bin/env node

/** Prevent the focused Hub repository from regrowing the upstream monorepo. */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', shell: false })
if (result.error !== undefined) throw result.error
if (result.status !== 0) throw new Error(result.stderr)

const rootFiles = new Set([
  '.dockerignore', '.editorconfig', '.gitattributes', '.gitignore', '.oxlintrc.json',
  'AGENTS.md', 'CLAUDE.md', 'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md', 'CONTRIBUTING.en.md', 'LICENSE',
  'README.md', 'README.en.md', 'SECURITY.md', 'SECURITY.en.md', 'THIRD_PARTY_NOTICES.md',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'tsconfig.base.client.json', 'tsconfig.base.json', 'tsconfig.json', 'vitest.config.ts',
])
const scripts = new Set([
  'benchmark-hub.mts', 'build-hub-release.mjs', 'build-hub-server.mjs', 'build-hub-web.mjs',
  'capture-hub-readme.mjs', 'clean.mjs', 'client-bundle.ts', 'run-hub-typecheck.mjs',
  'verify-docs.mjs', 'verify-hub-release.mjs', 'verify-hub-server.mjs',
  'verify-hub-web-csp.mjs', 'verify-repository-boundary.mjs',
])
const workflows = new Set(['hub-ci.yml', 'hub-release.yml'])

function allowed(path) {
  if (!path.includes('/')) return rootFiles.has(path)
  if (path.startsWith('apps/hub-web/')) return true
  if (path.startsWith('deploy/hub/') || path.startsWith('deploy/node/')) return true
  if (path.startsWith('packages/hub/')) return true
  if (path === 'patches/node-pty@1.1.0.patch') return true
  if (path.startsWith('third_party/official-web/')) return true
  if (path.startsWith('docs/assets/') || path.startsWith('docs/hub/')) return true
  if (path === 'docs/upstream.md' || path === 'docs/upstream.en.md') return true
  if (path.startsWith('scripts/')) return scripts.has(path.slice('scripts/'.length))
  if (path.startsWith('.github/workflows/')) return workflows.has(path.slice('.github/workflows/'.length))
  if (path.startsWith('.github/ISSUE_TEMPLATE/')) return true
  return new Set([
    '.github/CODEOWNERS', '.github/dependabot.yml', '.github/pull_request_template.md',
  ]).has(path)
}

const files = result.stdout.split('\0').filter(Boolean)
const unexpected = files.filter(path => !allowed(path))
if (unexpected.length > 0) {
  throw new Error(`repository boundary rejected ${String(unexpected.length)} tracked path(s):\n${unexpected.join('\n')}`)
}
if (files.length > 1000) throw new Error(`focused Hub repository unexpectedly contains ${String(files.length)} tracked files`)
process.stdout.write(`repository boundary verified: ${String(files.length)} focused tracked files\n`)
