import { readOwner, runtimeInstance } from './admission.ts'
import { mkdir, readFile, rename, access, rm, open } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'

interface Change { application: string; changed: boolean; error?: { code: string } }
export interface Manager {
  listPlugins(): Promise<Array<{ entryId: string; moduleName: string; enabled: boolean; fiberPhase: string | null; readOnlyReason?: string }>>
  listBundles(): Promise<Array<{ name: string; version?: string; enabled: boolean; removable: boolean }>>
  inspect(spec: string): Promise<{ status: string; problem?: string; name?: string; version?: string; bundle?: boolean | null }>
  registries?(): Promise<{ registry: string | null; resolved: string | null }>
  installBundle(spec: string, options: { requestId: string }): Promise<Change>
  removeBundle(name: string): Promise<Change>
  setPluginEnabled(id: string, enabled: boolean): Promise<Change>
  cancelInstall(id: string): Promise<{ status: string }>
}
interface Job { id: string; fingerprint: string; action: string; target: string; status: string; createdAt: number; finishedAt?: number; application?: string; error?: string; previousVersion?: string; installedVersion?: string; rollback?: string; diskVersion?: string; activeVersion?: string; applicationState?: string; upstreamApplication?: string; previousRuntimeInstance?: string; previousGeneration?: string; expectedVersion?: string; verifiedGeneration?: string; verifiedRuntimeInstance?: string }
interface PackageVersion { name: string; version: string; bundle: boolean }
export interface ManagementOptions {
  stateDirectory: string; lockDirectory?: string; version: string; manager?: Manager; trustedPackages: string[]
  updateExecutor?: string; lifecycle?: boolean; installation?: 'npm' | 'docker' | 'external'
  /** Fault injection and deployment-specific authenticated registry lookup. */
  persist?: (path: string, data: string) => Promise<void>
  lookupVersion?: (name: string, version: string) => Promise<PackageVersion>
  quiescent?: () => Promise<void>
  executorTimeoutMs?: number
}
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/
const version = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/
/** Write, fsync, atomically replace, then sync the directory before acknowledging durability. */
export async function persistManagement(path: string, data: string): Promise<void> {
  const file = await open(`${path}.tmp`, 'w', 0o600)
  try { await file.writeFile(data); await file.sync() } finally { await file.close() }
  await rename(`${path}.tmp`, path)
  if (process.platform !== 'win32') { const directory = await open(join(path, '..'), 'r'); try { await directory.sync() } finally { await directory.close() } }
}
export async function createManagement(options: ManagementOptions) {
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 })
  const lockDirectory = options.lockDirectory ?? join(options.stateDirectory, 'operation.lock')
  const file = join(options.stateDirectory, 'management-jobs.json'), persist = options.persist ?? persistManagement
  let jobs: Job[] = [], journalUnreadable = false
  try { jobs = JSON.parse(await readFile(file, 'utf8')) as Job[]; if (!Array.isArray(jobs) || jobs.some(job => !job || typeof job.id !== 'string')) { jobs = []; throw new Error('Invalid journal') } } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') journalUnreadable = true }
  for (const job of jobs) if (job.status === 'running') job.status = 'interrupted-review-required'
  let active: Job | undefined, executing = false, persistenceFailed = journalUnreadable, uncertainExecutor = false, restartRequired = false, awaitingRuntime = false, mutationStarted = false
  let saving: Promise<void> = Promise.resolve()
  const save = () => {
    const data = JSON.stringify(jobs)
    const next = saving.then(() => persist(file, data))
    // A failed write cannot poison later recovery writes; callers still see its rejection.
    saving = next.catch(() => {})
    return next.catch(error => { persistenceFailed = true; throw error })
  }
  const snapshot = (job: Job) => ({ ...job, ...(active === job ? { status: persistenceFailed ? 'persistence-failed' : uncertainExecutor ? 'executor-recovery-required' : executing ? 'running' : restartRequired ? 'restart-required' : awaitingRuntime ? 'awaiting-runtime-verification' : 'running' } : {}) })
  if (!journalUnreadable) await save().catch(() => {}) // Keep the Runtime available, but fail closed on mutations.
  if (options.installation && !['npm','docker','external'].includes(options.installation)) throw new Error('Invalid installation type')
  let installation = options.installation ?? 'external'
  try { await access('/.dockerenv'); installation = 'docker' } catch { /* non-container */ }
  const manager = options.manager
  const protectedModule = (name: string) => /gateway-node|dsh-plugin-manager|dsh-connection|dsh-client-modules|dsh-typert-gateway/.test(name)
  async function inspectExact(name: string, target: string): Promise<PackageVersion> {
    if (options.lookupVersion) return options.lookupVersion(name, target)
    const inspected = await manager?.inspect(`${name}@${target}`)
    if (inspected?.status === 'accepted') return { name: inspected.name ?? '', version: inspected.version ?? '', bundle: inspected.bundle === true }
    if (inspected?.problem !== 'already-installed') throw new Error('version-check-refused')
    const registries = await manager?.registries?.()
    if (!registries) throw new Error('Exact registry lookup unavailable')
    const registry = registries.registry ?? registries.resolved
    const { stdout } = await promisify(execFile)('npm', ['view', `${name}@${target}`, '--json', ...(registry ? [`--registry=${registry}`] : [])], { timeout: 30000, maxBuffer: 262144 })
    const value = JSON.parse(stdout) as { name?: string; version?: string; dsh?: { bundle?: unknown } }
    return { name: value.name ?? '', version: value.version ?? '', bundle: !!value.dsh?.bundle }
  }
  async function checked(name: string, target: string): Promise<PackageVersion> {
    const value = await inspectExact(name, target)
    if (value.name !== name || value.version !== target || !value.bundle) throw new Error('version-or-bundle-check-failed')
    return value
  }
  async function executor(action: string, target: string, id: string, mutating: boolean): Promise<Record<string, unknown>> {
    if (!options.lifecycle || !options.updateExecutor || !isAbsolute(options.updateExecutor)) throw new Error('independent-supervisor-required')
    return new Promise((resolve, reject) => {
      const child = spawn(options.updateExecutor as string, [action, target, id], { stdio: ['ignore','pipe','ignore'], shell: false })
      let output = '', overflow = false
      child.stdout.on('data', bytes => { if (output.length + bytes.length > 65536) overflow = true; else output += bytes.toString() })
      const timer = setTimeout(() => {
        // Do not kill just the adapter and orphan its npm/deployment children. Keep the
        // mutation locked for explicit local executor reconciliation, even across restart.
        if (mutating) uncertainExecutor = true
        reject(new Error('executor-timeout-manual-recovery'))
      }, options.executorTimeoutMs ?? (mutating ? 300000 : 30000)); timer.unref()
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => {
        clearTimeout(timer)
        let result: Record<string, unknown>
        try { result = JSON.parse(output) as Record<string, unknown> } catch { if (mutating) uncertainExecutor = true; reject(new Error('executor-result-unverifiable')); return }
        if (overflow || result.status === 'manual-recovery-required' || result.status === 'rollback-failed') { if (mutating) uncertainExecutor = true; reject(new Error('executor-manual-recovery')); return }
        if (code !== 0) { reject(new Error('executor-failed')); return }
        if (['apply','install','check'].includes(action) && (action === 'check' ? result.availableVersion : result.installedVersion) !== target) { reject(new Error('executor-version-mismatch')); return }
        resolve(result)
      })
    })
  }
  async function run(job: Job, input: Record<string, unknown>) {
    let result: Change
    if (job.action.startsWith('dsh.')) {
      const observed = await executor(job.action === 'dsh.update' ? 'apply' : job.action.slice(4), job.target, job.id, true)
      if (typeof observed.installedVersion === 'string') { job.installedVersion = observed.installedVersion; if(job.action==='dsh.start')job.expectedVersion=observed.installedVersion }
      result = { changed: true, application: 'applied' }
      if (['dsh.restart','dsh.update','dsh.start','dsh.install'].includes(job.action)) awaitingRuntime = true
    } else {
      if (!manager) throw new Error('unsupported-plugin-manager')
      if (job.action === 'plugin.install') {
        const previous = (await manager.listBundles()).find(bundle => bundle.name === input.package)
        await checked(String(input.package), String(input.version))
        if (previous?.version) { job.previousVersion = previous.version; await save() }
        mutationStarted = true
        result = await manager.installBundle(job.target, { requestId: job.id })
        const installed = (await manager.listBundles()).find(bundle => bundle.name === input.package)?.version
        if (installed) { job.installedVersion = installed; job.diskVersion = installed }
        job.applicationState = 'active-version-unverified'; job.upstreamApplication=result.application
        let diskRecovered=false
        if(result.application==='failed' && result.error?.code==='not-bundle' && previous?.version && version.test(previous.version)){
          const restored=await manager.installBundle(`${String(input.package)}@${previous.version}`,{requestId:`${job.id}-disk-recovery`})
          const disk=(await manager.listBundles()).find(bundle=>bundle.name===input.package)?.version
          if(disk===previous.version){diskRecovered=true;job.diskVersion=disk;job.installedVersion=disk;job.rollback='disk-restored-active-unverified';restartRequired=true;result={...restored,application:'restart-required'}}
          else{uncertainExecutor=true;job.rollback='manual-recovery-required'}
        }
        // Package-manager exit status is independent from native HMR application.
        // Do not run another HMR transaction to "rollback" a partial application.
        if(diskRecovered){ /* Disk recovery is verified; active code still requires a new process. */ }
        else if (installed === input.version && ['failed','restart-required'].includes(result.application)) {
          restartRequired = true
          job.error = result.error?.code ?? 'native-restart-required'
          result = {...result,application:'restart-required'}
        } else if (installed !== input.version && !['failed','cancelled'].includes(result.application)) {
          uncertainExecutor = true
          result = {changed:true,application:'failed',error:{code:'installed-version-mismatch'}}
        } else if (['failed','cancelled'].includes(result.application)) {
          if(previous?.version && installed === previous.version) job.rollback = 'disk-restored-active-unverified'
          else { uncertainExecutor = true; job.rollback = 'manual-recovery-required' }
        }
      } else if (job.action === 'plugin.remove') {mutationStarted=true;result = await manager.removeBundle(job.target)}
      else if (job.action === 'plugin.enable' || job.action === 'plugin.disable') {
        const plugin = (await manager.listPlugins()).find(p => p.entryId === job.target)
        if (!plugin || plugin.readOnlyReason || protectedModule(plugin.moduleName)) throw new Error('protected-or-unknown-plugin')
        mutationStarted = true
        result = await manager.setPluginEnabled(job.target, job.action === 'plugin.enable')
      } else throw new Error('unsupported-action')
    }
    if(!options.lifecycle && result.application==='restart-required')restartRequired=true
    if(!options.lifecycle && job.action!=='plugin.install' && result.application==='failed' && result.changed)uncertainExecutor=true
    job.application = result.application
    job.status = awaitingRuntime ? 'awaiting-runtime-verification' : result.application === 'restart-required' ? 'restart-required' : result.application === 'failed' ? 'failed' : result.application === 'cancelled' ? 'cancelled' : 'completed'
    if (result.error) job.error = result.error.code
  }
  async function finish() {
    await save()
    if (!active) return
    const owner=await readOwner(lockDirectory).catch(error=>{
      if((error as NodeJS.ErrnoException).code==='ENOENT' && active?.error==='reservation-not-durable; no-side-effect-started')return undefined
      throw error
    })
    if(owner && owner.requestId!==active.id)throw new Error('operation-lock-owner-changed; do not modify transferred maintenance')
    const phase=awaitingRuntime?'awaiting-runtime-verification':restartRequired?'restart-required':undefined
    if(phase){
      if(!owner || !['executing',phase].includes(owner.phase ?? ''))throw new Error('operation-lock-phase-changed')
      // A durable phase is final: retries must not overwrite a new preparation
      // that can adopt it while the old Runtime is still connected.
      if(owner.phase==='executing')await persist(join(lockDirectory,'owner.json'),JSON.stringify({...owner,phase}))
    }
    if (!uncertainExecutor && !restartRequired && !awaitingRuntime) { await rm(lockDirectory, { recursive: true }); active = undefined }
  }
  async function handle(method: string, input: Record<string, unknown>): Promise<unknown> {
    if (method === 'management.inventory') return { version: options.version, runtimeInstance, installation, maintenance: await readOwner(lockDirectory).then(owner=>({phase:owner.phase,action:owner.action,requestId:owner.requestId})).catch(error=>(error as NodeJS.ErrnoException).code==='ENOENT'?null:{phase:'local-review-required'}), persistence: persistenceFailed ? 'persistence-failed' : 'healthy', recovery: uncertainExecutor ? 'manual-executor-reconciliation-required' : null, runtimeLifecycle: options.lifecycle ? ['dsh.install','dsh.start','dsh.stop','dsh.uninstall','dsh.update','dsh.restart'] : 'external-supervisor-required', update: options.lifecycle && options.updateExecutor ? 'executor' : 'external-supervisor-required', plugins: manager ? (await manager.listPlugins()).map(p => ({ entryId: p.entryId, moduleName: p.moduleName, enabled: p.enabled, phase: p.fiberPhase, protected: !!p.readOnlyReason || protectedModule(p.moduleName) })) : [], bundles: manager ? (await manager.listBundles()).map(p => ({ name: p.name, version: p.version, enabled: p.enabled, removable: p.removable && !protectedModule(p.name) })) : [], jobs: jobs.slice(-100).map(snapshot), supported: !!manager }
    if (method === 'management.retry-persistence') {
      if (journalUnreadable) throw new Error('Unreadable journal; repair locally and reload')
      if (executing || uncertainExecutor) throw new Error('Operation or executor requires reconciliation')
      await save(); persistenceFailed = false
      if (active) await finish()
      return { status: 'journal-durable; no-operation-replayed' }
    }
    if(method==='management.restarted'){
      if(options.lifecycle || !input.previousRuntimeInstance || input.previousRuntimeInstance===runtimeInstance)throw new Error('new-runtime-required')
      for(const job of jobs)if(job.status==='restart-required'&&job.previousRuntimeInstance===input.previousRuntimeInstance){job.status='runtime-restarted';job.applicationState='new-runtime-online; active-plugin-version-unverified'}
      await save();return {status:'recorded'}
    }
    if (method === 'management.verify-runtime') {
      if(executing)throw new Error('Operation still executing or finalizing')
      const job=jobs.find(j=>j.id===input.requestId)
      if(!options.lifecycle || !job || job.status!=='awaiting-runtime-verification' || !input.generation || input.generation===job.previousGeneration || !input.runtimeInstance || input.runtimeInstance===job.previousRuntimeInstance || input.version!==job.expectedVersion)throw new Error('runtime-handshake-not-verified')
      if((await readOwner(lockDirectory)).requestId!==job.id)throw new Error('stale-verification')
      job.status='completed';job.activeVersion=String(input.version);job.verifiedGeneration=String(input.generation);job.verifiedRuntimeInstance=String(input.runtimeInstance)
      awaitingRuntime=false;await finish();return snapshot(job)
    }
    if (method === 'management.check') {
      if (String(input.action).startsWith('dsh.')) return executor('check', String(input.target), 'check-request', false)
      const name = String(input.package ?? ''), target = String(input.version ?? '')
      if (!packageName.test(name) || !version.test(target) || !options.trustedPackages.includes(name) || !manager) throw new Error('untrusted-or-unsupported')
      return { status: 'available', ...await checked(name, target) }
    }
    if (method === 'management.recover') {
      if (!options.lifecycle || active) throw new Error('Recovery requires idle supervisor')
      const owner = JSON.parse(await readFile(join(lockDirectory, 'owner.json'), 'utf8')) as { pid: number; executorMayOutlive?: boolean }
      if (owner.executorMayOutlive) throw new Error('Local executor journal/process reconciliation required; PID-only recovery forbidden')
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
    if (persistenceFailed) throw new Error('persistence-failed; retry journal persistence before submitting')
    const id = String(input.requestId ?? ''), action = String(input.action ?? '')
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw new Error('request-id-required')
    let target = String(input.target ?? '')
    if (action === 'plugin.install') {
      const name = String(input.package ?? ''), v = String(input.version ?? '')
      if (!packageName.test(name) || !version.test(v) || !options.trustedPackages.includes(name) || protectedModule(name)) throw new Error('untrusted-package-or-version')
      target = `${name}@${v}`
    } else if (['dsh.install','dsh.start','dsh.stop','dsh.uninstall','dsh.update','dsh.restart'].includes(action)) {
      if (!options.lifecycle || !options.updateExecutor) throw new Error('independent-supervisor-required')
      if (['dsh.install','dsh.update'].includes(action) ? !version.test(target) : target !== 'current') throw new Error('Invalid lifecycle target')
    } else if (!['plugin.remove','plugin.enable','plugin.disable'].includes(action) || !target || target.length > 256 || protectedModule(target)) throw new Error('unsupported-or-protected')
    const fingerprint = createHash('sha256').update(JSON.stringify({ action, target })).digest('hex')
    const previous = jobs.find(j => j.id === id)
    if (previous) { if (previous.fingerprint !== fingerprint) throw new Error('request-id-conflict'); return snapshot(previous) }
    if (active) throw new Error('node-busy')
    if (jobs.length >= 10000) throw new Error('journal-capacity; archive locally')
    const guardedLifecycle=['dsh.update','dsh.restart','dsh.stop','dsh.uninstall'].includes(action)
    if(guardedLifecycle){
      const owner=await readOwner(lockDirectory).catch(()=>undefined)
      if(!owner || owner.phase!=='prepared'||owner.action!==action||owner.requestId!==id||owner.token!==input.admissionToken||!owner.quiescent||owner.runtimeInstance!==input.previousRuntimeInstance)throw new Error('runtime-admission-required')
    } else {try { await mkdir(lockDirectory, { mode: 0o700 }) } catch { throw new Error('node-busy-or-interrupted-lock; inspect supervisor') }}
    const job: Job = { id, fingerprint, action, target, status: 'running', createdAt: Date.now() }; active = job; jobs.push(job)
    try {
      await persist(join(lockDirectory, 'owner.json'), JSON.stringify({ pid: process.pid, requestId: id, executorMayOutlive: action.startsWith('dsh.') || action === 'plugin.install', action, phase:'executing', quiescent:guardedLifecycle }))
      await save()
    } catch { persistenceFailed = true; job.status = 'failed'; job.error = 'reservation-not-durable; no-side-effect-started'; throw new Error('persistence-failed; no-side-effect-started') }
    if(guardedLifecycle){job.previousRuntimeInstance=String(input.previousRuntimeInstance);job.previousGeneration=String(input.previousGeneration);job.expectedVersion=action==='dsh.update'?target:String(input.previousVersion)}
    if(['dsh.start','dsh.install'].includes(action))job.expectedVersion=action==='dsh.install'?target:String(input.expectedVersion ?? '')
    if(!options.lifecycle)job.previousRuntimeInstance=runtimeInstance
    try{await save()}catch{job.status='failed';job.error='reservation-not-durable; no-side-effect-started';throw new Error('persistence-failed; no-side-effect-started')}
    executing = true; mutationStarted=false
    void (async () => {
      try { if(!options.lifecycle && options.quiescent)await options.quiescent(); await run(job, input) } catch { if(mutationStarted)uncertainExecutor=true; job.status = 'failed'; job.error ??= 'operation-failed; inspect node locally' }
      finally {
        job.finishedAt = Date.now()
        // Keep the execution fence until both journal and lock owner are durable.
        // Cancellation still reaches the manager while run() is in progress.
        try { await finish() } catch { persistenceFailed = true } finally { executing = false }
      }
    })()
    return snapshot(job)
  }
  let serial:Promise<unknown>=Promise.resolve()
  return {handle(method:string,input:Record<string,unknown>):Promise<unknown>{
    if(method==='management.inventory'||method==='management.check')return handle(method,input)
    const next=serial.then(()=>handle(method,input));serial=next.catch(()=>{});return next
  }}
}
