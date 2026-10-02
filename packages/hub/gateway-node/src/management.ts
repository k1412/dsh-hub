import { mkdir, readFile, rename, writeFile, access, rm } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

interface Change { application: string; changed: boolean; error?: { code: string } }
export interface Manager {
  listPlugins(): Promise<Array<{ entryId: string; moduleName: string; enabled: boolean; fiberPhase: string | null; readOnlyReason?: string }>>
  listBundles(): Promise<Array<{ name: string; version?: string; enabled: boolean; removable: boolean }>>
  inspect(spec: string): Promise<{ status: string; problem?: string; name?: string; version?: string; bundle?: boolean | null }>
  installBundle(spec: string, options: { requestId: string }): Promise<Change>
  removeBundle(name: string): Promise<Change>
  setPluginEnabled(id: string, enabled: boolean): Promise<Change>
  cancelInstall(id: string): Promise<{ status: string }>
}
interface Job { id: string; fingerprint: string; action: string; target: string; status: string; createdAt: number; finishedAt?: number; application?: string; error?: string; previousVersion?: string; rollback?: string }
export interface ManagementOptions { stateDirectory: string; lockDirectory?: string; version: string; manager?: Manager; trustedPackages: string[]; updateExecutor?: string; lifecycle?: boolean; installation?: 'npm' | 'docker' | 'external' }
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/
const version = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/
/** Node-local journal contains operation identity and outcomes, never model settings or CLI output. */
export async function createManagement(options: ManagementOptions) {
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 })
  const lockDirectory = options.lockDirectory ?? join(options.stateDirectory, 'operation.lock')
  const file = join(options.stateDirectory, 'management-jobs.json')
  let jobs: Job[] = []
  try { jobs = JSON.parse(await readFile(file, 'utf8')) as Job[] } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  for (const job of jobs) if (job.status === 'running') job.status = 'interrupted-review-required'
  let active: Job | undefined
  const snapshot = (job: Job) => ({ ...job, ...(active === job ? { status: 'running' } : {}) })
  let saving = Promise.resolve()
  const save = () => { const data = JSON.stringify(jobs); saving = saving.then(async () => { await writeFile(`${file}.tmp`, data, { mode: 0o600 }); await rename(`${file}.tmp`, file) }); return saving }
  await save()
  if (options.installation && !['npm','docker','external'].includes(options.installation)) throw new Error('Invalid installation type')
  let installation = options.installation ?? 'external'
  try { await access('/.dockerenv'); installation = 'docker' } catch { /* non-container */ }
  const manager = options.manager
  const protectedModule = (name: string) => /gateway-node|dsh-plugin-manager|dsh-connection|dsh-client-modules|dsh-typert-gateway/.test(name)
  async function run(job: Job, input: Record<string, unknown>) {
    let result: Change
    if (job.action.startsWith('dsh.')) {
      if (!options.updateExecutor || !isAbsolute(options.updateExecutor)) throw new Error('external-update-required')
      await new Promise<void>((resolve, reject) => {
        const child = spawn(options.updateExecutor as string, [job.action === 'dsh.update' ? 'apply' : job.action.slice(4), job.target, job.id], { stdio: 'ignore', shell: false, timeout: 300000 })
        child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('update-failed-review-node-journal')))
      })
      result = { changed: true, application: job.action === 'dsh.update' ? 'restart-required' : 'applied' }
    } else {
      if (!manager) throw new Error('unsupported-plugin-manager')
      if (job.action === 'plugin.install') {
        const previous = (await manager.listBundles()).find(bundle => bundle.name === input.package)
        const inspection = await manager.inspect(job.target)
        const updating = !!previous?.version && inspection.status === 'refused' && inspection.problem === 'already-installed'
        if (!updating && (inspection.status !== 'accepted' || !inspection.bundle || inspection.name !== input.package || inspection.version !== input.version)) throw new Error('version-or-bundle-check-failed')
        if (previous?.version) { job.previousVersion = previous.version; await save() }
        result = await manager.installBundle(job.target, { requestId: job.id })
        if (['failed','cancelled'].includes(result.application) && previous?.version && previous.version !== input.version) {
          const rollback = await manager.installBundle(`${String(input.package)}@${previous.version}`, { requestId: `${job.id}-rollback` })
          job.rollback = ['applied','restart-required'].includes(rollback.application) ? 'restored-previous-version' : 'rollback-failed'
        }
      } else if (job.action === 'plugin.remove') result = await manager.removeBundle(job.target)
      else if (job.action === 'plugin.enable' || job.action === 'plugin.disable') {
        const plugin = (await manager.listPlugins()).find(p => p.entryId === job.target)
        if (!plugin || plugin.readOnlyReason || protectedModule(plugin.moduleName)) throw new Error('protected-or-unknown-plugin')
        result = await manager.setPluginEnabled(job.target, job.action === 'plugin.enable')
      } else throw new Error('unsupported-action')
    }
    job.application = result.application; job.status = result.application === 'failed' ? 'failed' : result.application === 'cancelled' ? 'cancelled' : 'completed'
    if (result.error) job.error = result.error.code
  }
  return { async handle(method: string, input: Record<string, unknown>): Promise<unknown> {
    if (method === 'management.inventory') return { version: options.version, installation, runtimeLifecycle: options.lifecycle ? ['dsh.install','dsh.start','dsh.stop','dsh.uninstall','dsh.update'] : 'external-supervisor-required', update: options.updateExecutor ? 'executor' : 'external-update-required', plugins: manager ? (await manager.listPlugins()).map(p => ({ entryId: p.entryId, moduleName: p.moduleName, enabled: p.enabled, phase: p.fiberPhase, protected: !!p.readOnlyReason || protectedModule(p.moduleName) })) : [], bundles: manager ? (await manager.listBundles()).map(p => ({ name: p.name, version: p.version, enabled: p.enabled, removable: p.removable && !protectedModule(p.name) })) : [], jobs: jobs.slice(-100).map(snapshot), supported: !!manager }
    if (method === 'management.check') {
      if (input.action === 'dsh.update') {
        const target = String(input.target ?? '')
        if (!version.test(target) || !options.updateExecutor || !isAbsolute(options.updateExecutor)) throw new Error('external-update-required')
        await new Promise<void>((resolve, reject) => {
          const child = spawn(options.updateExecutor as string, ['check', target, 'check-request'], { stdio: 'ignore', shell: false, timeout: 30000 })
          child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('update-check-failed')))
        })
        return { target, status: 'available-and-locally-approved' }
      }
      const name = String(input.package ?? ''), target = String(input.version ?? '')
      if (!packageName.test(name) || !version.test(target) || !options.trustedPackages.includes(name) || !manager) throw new Error('untrusted-or-unsupported')
      const result = await manager.inspect(`${name}@${target}`)
      return { status: result.status, problem: result.problem, name: result.name, version: result.version, bundle: result.bundle }
    }
    if (method === 'management.recover') {
      if (!options.lifecycle || active) throw new Error('Recovery requires idle supervisor')
      const owner = JSON.parse(await readFile(join(lockDirectory, 'owner.json'), 'utf8')) as { pid: number }
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Invalid lock owner; inspect locally')
      try { process.kill(owner.pid, 0); throw new Error('Operation owner still alive') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      await rm(lockDirectory, { recursive: true }); return { status: 'recovered; inspect interrupted jobs before retrying' }
    }
    if (method === 'management.cancel') {
      const job = jobs.find(j => j.id === input.requestId)
      if (!job || job !== active || job.action !== 'plugin.install' || !manager) return { status: 'too-late-or-not-cancellable' }
      return manager.cancelInstall(job.id)
    }
    if (method !== 'management.submit') throw new Error('unsupported')
    const id = String(input.requestId ?? ''), action = String(input.action ?? '')
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw new Error('request-id-required')
    let target = String(input.target ?? '')
    if (action === 'plugin.install') {
      const name = String(input.package ?? ''), v = String(input.version ?? '')
      if (!packageName.test(name) || !version.test(v) || !options.trustedPackages.includes(name) || protectedModule(name)) throw new Error('untrusted-package-or-version')
      target = `${name}@${v}`
    } else if (['dsh.install','dsh.start','dsh.stop','dsh.uninstall'].includes(action)) {
      if (!options.lifecycle || !options.updateExecutor) throw new Error('external-supervisor-required')
      if (action === 'dsh.install' ? !version.test(target) : target !== 'current') throw new Error('Invalid lifecycle target')
    } else if (action === 'dsh.update') {
      if (!version.test(target) || !options.updateExecutor) throw new Error('external-update-required')
    } else if (!['plugin.remove','plugin.enable','plugin.disable'].includes(action) || !target || target.length > 256 || protectedModule(target)) throw new Error('unsupported-or-protected')
    const fingerprint = createHash('sha256').update(JSON.stringify({ action, target })).digest('hex')
    const previous = jobs.find(j => j.id === id)
    if (previous) { if (previous.fingerprint !== fingerprint) throw new Error('request-id-conflict'); return snapshot(previous) }
    if (active) throw new Error('node-busy')
    if (jobs.length >= 10000) throw new Error('journal-capacity; archive locally')
    try { await mkdir(lockDirectory, { mode: 0o700 }) } catch { throw new Error('node-busy-or-interrupted-lock; inspect supervisor') }
    await writeFile(join(lockDirectory, 'owner.json'), JSON.stringify({ pid: process.pid, requestId: id }), { mode: 0o600 })
    const job: Job = { id, fingerprint, action, target, status: 'running', createdAt: Date.now() }; active = job; jobs.push(job)
    await save()
    void run(job, input).catch(() => { job.status = 'failed'; job.error = 'operation-failed; inspect node locally' }).finally(async () => { job.finishedAt = Date.now(); await save(); await rm(lockDirectory, { recursive: true }); active = undefined }).catch(() => { /* Keep the node locked if its journal cannot persist the outcome. */ })
    return { ...job }
  } }
}
