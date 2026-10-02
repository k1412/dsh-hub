#!/usr/bin/env node
/** Run on the node/deployment host. Never attach an engine socket to the Hub. */
import { readFile, writeFile, mkdir, rename, readlink, symlink, unlink } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const [action, version, id] = process.argv.slice(2)
const lifecycle = ['install','start','stop','uninstall'].includes(action)
if (!['apply','check','install','start','stop','uninstall'].includes(action) || !(lifecycle && action !== 'install' ? version === 'current' : /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? '')) || !/^[\w-]{8,80}$/.test(id ?? '')) throw new Error('Invalid update request')
const configPath = process.env.DSH_UPDATE_CONFIG
if (!configPath || !isAbsolute(configPath)) throw new Error('Configure DSH_UPDATE_CONFIG on the node')
const config = JSON.parse(await readFile(configPath, 'utf8'))
if ((!lifecycle || action === 'install') && !config.approvedVersions?.includes(version) || !isAbsolute(config.stateDirectory) || lifecycle && !config.approvedActions?.includes(action)) throw new Error('Version is not locally approved')
const run = async (command, extra = []) => {
  if (!Array.isArray(command) || !isAbsolute(command[0])) throw new Error('Executor command must be an absolute local executable')
  // Output stays local; the gateway receives only a job outcome.
  return exec(command[0], [...command.slice(1), ...extra], { timeout: 240000, maxBuffer: 1048576 })
}
if (action === 'check') {
  if (config.kind === 'npm') {
    const result = await run(config.npm, ['view', `@deepseek-ai/dsh@${version}`, 'version', '--registry=https://registry.npmjs.org'])
    if (result.stdout.trim() !== version) throw new Error('Registry version mismatch')
  } else if (config.kind === 'docker') await run(config.check, [version])
  else throw new Error('external-update-required')
  process.exit(0)
}
await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 })
const lock = join(config.stateDirectory, 'update.lock')
const journal = join(config.stateDirectory, `${id}.json`)
let previous
let switched = false
await mkdir(lock)
try {
  try { const prior = JSON.parse(await readFile(journal, 'utf8')); if (prior.version !== version || prior.action !== action) throw Object.assign(new Error('Request conflict'), { existingJob: true }); if (prior.status === 'completed') { const { rmdir } = await import('node:fs/promises'); await rmdir(lock); process.exit(0) } throw Object.assign(new Error('Interrupted job requires local review'), { existingJob: true }) } catch (error) { if (error.code !== 'ENOENT') throw error }
  await writeFile(journal, JSON.stringify({ version, action, status: 'running' }), { mode: 0o600 })
  if (lifecycle && action !== 'install') {
    await run(config[action], [version, id])
    if (action === 'start') await run(config.verify, [version])
  } else if (config.kind === 'npm') {
    if (!isAbsolute(config.releases) || !isAbsolute(config.current)) throw new Error('Absolute release and current paths required')
    if (action === 'install') {
      try { await readlink(config.current); throw new Error('DSH already installed') } catch (error) { if (error.code !== 'ENOENT') throw error }
    } else previous = await readlink(config.current)
    const release = join(config.releases, `${version}-${id}`)
    await mkdir(release, { recursive: true, mode: 0o700 })
    await run(config.npm, ['install', '--prefix', release, '--ignore-scripts', '--registry=https://registry.npmjs.org', `@deepseek-ai/dsh@${version}`])
    const pkg = JSON.parse(await readFile(join(release, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
    if (pkg.version !== version) throw new Error('Installed version mismatch')
    await symlink(release, `${config.current}.next`); await rename(`${config.current}.next`, config.current); switched = true
    await run(action === 'install' ? config.start : config.restart); await run(config.verify, [version])
  } else if (config.kind === 'docker') {
    // Fixed deployment-owned commands must implement image pinning and readiness checks.
    await run(config.prepare, [version, id]); await run(action === 'install' ? config.install : config.apply, [version, id]); await run(config.verify, [version])
  } else throw new Error('external-update-required')
  await writeFile(journal, JSON.stringify({ version, action, previous, status: 'completed' }), { mode: 0o600 })
} catch (error) {
  if (error.existingJob) throw error
  let status = 'failed'
  try {
    if (config.kind === 'npm' && switched && previous) { await unlink(`${config.current}.next`).catch(() => {}); await symlink(previous, `${config.current}.next`); await rename(`${config.current}.next`, config.current); await run(config.restart) }
    else if (action === 'install' && config.kind === 'npm' && switched) { await run(config.stop, ['current', id]); await unlink(config.current).catch(() => {}) }
    else if (!lifecycle && config.kind === 'docker') await run(config.rollback, [version, id])
    status = config.kind === 'npm' && !switched || lifecycle && action !== 'install' ? 'failed' : 'rolled-back'
  } catch { status = 'rollback-failed' }
  await writeFile(journal, JSON.stringify({ version, action, previous, status }), { mode: 0o600 })
  process.exitCode = 1
} finally { const { rmdir } = await import('node:fs/promises'); await rmdir(lock) }
