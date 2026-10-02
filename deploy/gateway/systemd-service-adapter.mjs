#!/usr/bin/env node
/** Optional Linux user-service adapter. Configure the EXISTING DSH unit, never a second Runtime. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, lstat, rename } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
const exec = promisify(execFile)
const [operation, target = 'current', id = 'manual'] = process.argv.slice(2)
const unit = process.env.DSH_SERVICE_UNIT, current = process.env.DSH_CURRENT_RELEASE
if (!unit || !/^[a-zA-Z0-9_.@-]+\.service$/.test(unit) || !current || !isAbsolute(current)) throw new Error('Configure DSH_SERVICE_UNIT and DSH_CURRENT_RELEASE locally')
const systemctl = async (...args) => exec('/usr/bin/systemctl', ['--user', ...args, unit], { timeout: 60000, maxBuffer: 65536 })
if (['start','stop','restart'].includes(operation)) await systemctl(operation)
else if (operation === 'verify') {
  await systemctl('is-active', '--quiet')
  const manifest = JSON.parse(await readFile(join(current, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
  if (target !== 'current' && manifest.version !== target) throw new Error('Runtime version mismatch')
} else if (operation === 'uninstall') {
  if (!/^[\w-]{8,80}$/.test(id)) throw new Error('Invalid operation ID')
  if (!(await lstat(current)).isSymbolicLink()) throw new Error('Refusing to remove a non-release installation')
  await systemctl('stop')
  await rename(current, `${current}.removed-${id}`)
  // Preserve profiles, credentials and old release files for local recovery.
} else throw new Error('Unsupported service operation')
