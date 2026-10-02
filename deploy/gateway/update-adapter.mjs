#!/usr/bin/env node
/** Deployment-host executor. Never run this in the Runtime's service/cgroup. */
import { readFile, mkdir, rename, readlink, symlink, unlink, open, rmdir } from 'node:fs/promises'
import { join, isAbsolute, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const [action, version, id] = process.argv.slice(2)
const lifecycle = ['install','start','stop','uninstall','restart'].includes(action)
const exactVersion = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/
if (!['apply','check','install','start','stop','uninstall','restart'].includes(action) || !(lifecycle && action !== 'install' ? version === 'current' : exactVersion.test(version ?? '')) || !/^[\w-]{8,80}$/.test(id ?? '')) throw new Error('Invalid update request')
const configPath = process.env.DSH_UPDATE_CONFIG
if (!configPath || !isAbsolute(configPath)) throw new Error('Configure DSH_UPDATE_CONFIG on the supervisor')
const config = JSON.parse(await readFile(configPath, 'utf8'))
if ((!lifecycle || action === 'install') && !config.approvedVersions?.includes(version) || !isAbsolute(config.stateDirectory) || lifecycle && !config.approvedActions?.includes(action)) throw new Error('Operation/version is not locally approved')
let uncertainChildren = false
const run = async (command, extra = []) => {
  if (!Array.isArray(command) || !isAbsolute(command[0])) throw new Error('Executor command must be an absolute local executable')
  try { return await exec(command[0], [...command.slice(1), ...extra], { timeout: config.commandTimeoutMs ?? 240000, maxBuffer: 1048576 }) }
  catch (error) {
    // execFile can terminate its direct process without terminating grandchildren.
    // Never rollback concurrently or clear locks when descendants might still mutate.
    if (error.killed || error.signal || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') uncertainChildren = true
    throw error
  }
}
const durable = async (path, value) => {
  const file = await open(`${path}.tmp`, 'w', 0o600)
  try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
  await rename(`${path}.tmp`, path)
  if (process.platform !== 'win32') { const dir = await open(dirname(path), 'r'); try { await dir.sync() } finally { await dir.close() } }
}
const emit = result => process.stdout.write(JSON.stringify(result) + '\n')
const observedVersion = async target => {
  const result = await run(config.verify, [target])
  if (config.kind === 'npm') {
    const installed = JSON.parse(await readFile(join(config.current, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version
    if (!exactVersion.test(installed) || target !== 'current' && installed !== target) throw new Error('Installed version mismatch')
    return installed
  }
  // Docker verification must report the running image's DSH version, not just exit zero.
  const observed = JSON.parse(result.stdout).version
  if (!exactVersion.test(observed) || target !== 'current' && observed !== target) throw new Error('Deployment version mismatch')
  return observed
}
if (action === 'check') {
  if (config.kind === 'npm') {
    const result = await run(config.npm, ['view', `@deepseek-ai/dsh@${version}`, 'version', '--registry=https://registry.npmjs.org'])
    if (result.stdout.trim() !== version) throw new Error('Registry version mismatch')
  } else if (config.kind === 'docker') {
    const result = await run(config.check, [version]); if (JSON.parse(result.stdout).version !== version) throw new Error('Available image version mismatch')
  } else throw new Error('external-update-required')
  emit({ status: 'available', availableVersion: version }); process.exit(0)
}
await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 })
const lock = join(config.stateDirectory, 'update.lock'), journal = join(config.stateDirectory, `${id}.json`)
let previous, installedVersion, switched = false, dockerMutation = false, retainLock = false
await mkdir(lock, { mode: 0o700 })
try {
  await durable(join(lock, 'owner.json'), { pid: process.pid, id, descendantsRequireReconciliation: true })
  let prior
  try { prior = JSON.parse(await readFile(journal, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (prior) {
    if (prior.version !== version || prior.action !== action || prior.status !== 'completed') throw Object.assign(new Error('Existing operation requires local review'), { existingJob: true })
    emit(prior)
  } else {
    await durable(journal, { version, action, status: 'running' })
    if (lifecycle && action !== 'install') {
      await run(config[action], [version, id])
      if (['start','restart'].includes(action)) installedVersion = await observedVersion('current')
    } else if (config.kind === 'npm') {
      if (!isAbsolute(config.releases) || !isAbsolute(config.current)) throw new Error('Absolute release/current paths required')
      if (action === 'install') {
        try { await readlink(config.current); throw new Error('DSH already installed') } catch (error) { if (error.code !== 'ENOENT') throw error }
      } else previous = await readlink(config.current)
      const release = join(config.releases, `${version}-${id}`)
      await mkdir(release, { recursive: true, mode: 0o700 })
      await run(config.npm, ['install', '--prefix', release, '--ignore-scripts', '--registry=https://registry.npmjs.org', `@deepseek-ai/dsh@${version}`])
      if (JSON.parse(await readFile(join(release, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version !== version) throw new Error('Staged version mismatch')
      // Persist rollback identity before changing the selected release.
      await durable(journal, { version, action, previous, status: 'switching' })
      await symlink(release, `${config.current}.next`); await rename(`${config.current}.next`, config.current); switched = true
      await run(action === 'install' ? config.start : config.restart)
      installedVersion = await observedVersion(version)
    } else if (config.kind === 'docker') {
      await run(config.prepare, [version, id]); dockerMutation = true
      await run(action === 'install' ? config.install : config.apply, [version, id])
      installedVersion = await observedVersion(version)
    } else throw new Error('external-update-required')
    const result = { version, action, previous, installedVersion, status: 'completed' }
    try { await durable(journal, result) } catch (error) { retainLock = true; throw error }
    emit(result)
  }
} catch (error) {
  if (error.existingJob) { emit({ status: 'manual-recovery-required' }); process.exitCode = 1 }
  else {
    let status = 'failed'
    if (uncertainChildren || retainLock) { status = 'manual-recovery-required'; retainLock = true }
    else try {
      if (config.kind === 'npm' && switched && previous) {
        await unlink(`${config.current}.next`).catch(() => {}); await symlink(previous, `${config.current}.next`); await rename(`${config.current}.next`, config.current)
        await run(config.restart); await observedVersion('current'); status = 'rolled-back'
      } else if (action === 'install' && config.kind === 'npm' && switched) {
        await run(config.stop, ['current', id]); await unlink(config.current); status = 'cleaned-up'
      } else if (config.kind === 'docker' && dockerMutation) {
        const rollback = action === 'install' ? config.cleanup : config.rollback
        if (!rollback) { status = 'manual-recovery-required'; retainLock = true }
        else { await run(rollback, [version, id]); status = action === 'install' ? 'cleaned-up' : 'rolled-back' }
      }
    } catch { status = uncertainChildren ? 'manual-recovery-required' : 'rollback-failed'; retainLock = true }
    const result = { version, action, previous, status }
    try { await durable(journal, result) } catch { retainLock = true; result.status = 'manual-recovery-required' }
    emit(result); process.exitCode = 1
  }
} finally {
  if (!retainLock) { await unlink(join(lock, 'owner.json')).catch(() => {}); await rmdir(lock) }
}
