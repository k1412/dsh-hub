#!/usr/bin/env node

/** Exercise the standalone Hub binary's backup and verification commands. */

import { spawnSync } from 'node:child_process'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const binary = join(repositoryRoot, 'dist', 'hub-server.mjs')
const scratch = await mkdtemp(join(tmpdir(), 'dsh-hub-server-verify-'))
const stateDirectory = join(scratch, 'state')
const backupDirectory = join(scratch, 'backup')

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [binary, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, DSH_HUB_STATE_DIRECTORY: stateDirectory },
    shell: false,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== expectedStatus) {
    throw new Error([
      `hub-server ${args[0]} exited ${result.status}; expected ${expectedStatus}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }
  return result
}

try {
  run(['backup', '--destination', backupDirectory])
  const verified = run(['verify-backup', '--source', backupDirectory])
  if (!verified.stdout.includes('backup verified')) {
    throw new Error('verify-backup did not report success')
  }

  await appendFile(join(backupDirectory, 'hub.db'), Buffer.from([0]))
  const rejected = run(['verify-backup', '--source', backupDirectory], 1)
  if (!rejected.stderr.includes('checksum')) {
    throw new Error('verify-backup did not explain the checksum failure')
  }

  process.stdout.write('hub server backup verification: valid backup accepted and mutation rejected\n')
} finally {
  await rm(scratch, { recursive: true, force: true })
}
