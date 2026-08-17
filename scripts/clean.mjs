#!/usr/bin/env node

/** Remove only generated Hub outputs; source and state paths are never touched. */

import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const targets = [
  'apps/hub-web/dist',
  'dist/hub-release',
  'dist/hub-server',
  ...[
    'hub-protocol', 'hub-capabilities', 'hub-transport', 'hub-storage', 'hub-node-ipc',
    'hub-node-agent', 'hub-connector', 'hub-client-ui', 'hub-server',
  ].map(name => `packages/hub/${name}/lib`),
]

await Promise.all(targets.map(target => rm(resolve(root, target), { recursive: true, force: true })))
process.stdout.write(`cleaned ${String(targets.length)} generated Hub paths\n`)
