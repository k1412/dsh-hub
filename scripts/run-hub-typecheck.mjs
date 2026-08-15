#!/usr/bin/env node

/** Type-check every Hub package and the browser application in isolation. */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const pnpmEntrypoint = process.env.npm_execpath
if (pnpmEntrypoint === undefined || pnpmEntrypoint === '') {
  throw new Error('hub typecheck: npm_execpath is unavailable; invoke this gate through a pnpm package script')
}
const pnpmCommand = process.execPath
const pnpmArguments = (...args) => [pnpmEntrypoint, ...args]
const projects = [
  'packages/hub/hub-protocol/tsconfig.json',
  'packages/hub/hub-capabilities/tsconfig.json',
  'packages/hub/hub-transport/tsconfig.json',
  'packages/hub/hub-storage/tsconfig.json',
  'packages/hub/hub-node-ipc/tsconfig.json',
  'packages/hub/hub-node-agent/tsconfig.json',
  'packages/hub/hub-connector/tsconfig.json',
  'packages/hub/hub-server/tsconfig.json',
  'apps/hub-web/tsconfig.json',
]

const packageProjects = projects.filter(project => project.startsWith('packages/'))
process.stdout.write('hub typecheck: refresh package declarations\n')
const declarations = spawnSync(pnpmCommand, pnpmArguments(
  'exec', 'tsc', '-b', ...packageProjects, '--emitDeclarationOnly', '--force', '--pretty', 'false',
), {
  cwd: repositoryRoot,
  stdio: 'inherit',
  shell: false,
})
if (declarations.error !== undefined) throw declarations.error
if (declarations.status !== 0) process.exit(declarations.status ?? 1)

for (const project of projects) {
  process.stdout.write(`hub typecheck: ${project}\n`)
  const result = spawnSync(pnpmCommand, pnpmArguments(
    'exec', 'tsc', '-p', project, '--noEmit', '--pretty', 'false',
  ), {
    cwd: repositoryRoot,
    stdio: 'inherit',
    shell: false,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
