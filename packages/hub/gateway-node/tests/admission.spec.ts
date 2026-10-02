import {it,expect} from 'vitest'
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createAdmission,readOwner} from '../src/admission.ts'
import {createManagement,type Manager} from '../src/management.ts'
it('excludes task admission and lifecycle preparation without cancelling existing agents',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'admission-'))
  let release!:()=>void
  try{
    const agent={status:'running',whenIdle:async()=>{}}
    const fence=createAdmission(join(dir,'lock'),{list:()=>[agent]},'0.1.7-rc.2')
    await expect(fence.prepare({action:'dsh.restart',requestId:'busy-restart'})).rejects.toThrow('busy')
    expect(agent.status).toBe('running')
    agent.status='idle'
    const task=fence.task(()=>new Promise<void>(r=>{release=r}))
    await expect.poll(()=>!!release).toBe(true)
    await expect(fence.prepare({action:'dsh.restart',requestId:'race-restart'})).rejects.toThrow('busy')
    release();await task
    const permit=await fence.prepare({action:'dsh.restart',requestId:'idle-restart'})
    await expect(fence.task(async()=>{throw new Error('Must not admit')})).rejects.toThrow('maintenance')
    expect(fence.guarded()).toBe(true)
    await fence.release(permit)
    expect(fence.guarded()).toBe(false)
    expect(await fence.task(async()=>42)).toBe(42)
  }finally{await rm(dir,{recursive:true,force:true})}
})
it('retains disk/application uncertainty and permits only an idle controlled restart to adopt that fence',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'disk-application-'));let disk='1.0.0',installs=0
  const manager={listPlugins:async()=>[],listBundles:async()=>[{name:'example',version:disk}],inspect:async()=>({status:'accepted',name:'example',version:'1.0.1',bundle:true}),installBundle:async()=>{installs++;disk='1.0.1';return {changed:true,application:'failed',error:{code:'operation-error'}}}} as unknown as Manager
  try{
    const lock=join(dir,'lock'),fence=createAdmission(lock,{list:()=>[]},'0.1.7-rc.2')
    const runtime=await createManagement({stateDirectory:join(dir,'runtime'),lockDirectory:lock,version:'0.1.7-rc.2',trustedPackages:['example'],manager,quiescent:fence.quiescent})
    await runtime.handle('management.submit',{action:'plugin.install',requestId:'install-new',package:'example',version:'1.0.1'})
    await expect.poll(async()=> (await runtime.handle('management.inventory',{}) as {jobs:Array<{status:string}>}).jobs[0]?.status).toBe('restart-required')
    expect(installs).toBe(1)
    await runtime.handle('management.retry-persistence',{});expect(fence.guarded()).toBe(true);expect(installs).toBe(1)
    expect(await runtime.handle('management.inventory',{})).toMatchObject({jobs:[{diskVersion:'1.0.1',upstreamApplication:'failed',applicationState:'active-version-unverified'}]})
    const old=await readOwner(lock);expect(old.phase).toBe('restart-required')
    await expect(runtime.handle('management.submit',{action:'plugin.remove',requestId:'remove-new',target:'example'})).rejects.toThrow('busy')
    const executable=join(dir,'restart');await writeFile(executable,`#!${process.execPath}\nconsole.log(JSON.stringify({status:'completed',installedVersion:'0.1.7-rc.2'}))`,{mode:0o700})
    const supervisor=await createManagement({stateDirectory:join(dir,'supervisor'),lockDirectory:lock,version:'external',trustedPackages:[],lifecycle:true,updateExecutor:executable})
    const permit=await fence.prepare({action:'dsh.restart',requestId:'restart-new'})
    const request={action:'dsh.restart',requestId:'restart-new',target:'current',admissionToken:permit.token,previousRuntimeInstance:permit.runtimeInstance,previousVersion:permit.version,previousGeneration:'generation-old'}
    const accepted=await Promise.all([supervisor.handle('management.submit',request),supervisor.handle('management.submit',request)])
    expect(accepted).toHaveLength(2)
    await expect.poll(async()=> (await supervisor.handle('management.inventory',{}) as {jobs:Array<{status:string}>}).jobs[0]?.status).toBe('awaiting-runtime-verification')
    await expect(fence.release(permit)).rejects.toThrow('adopted')
    const verify={requestId:'restart-new',generation:'generation-new',runtimeInstance:'new-process',version:'0.1.7-rc.2'}
    await expect(supervisor.handle('management.verify-runtime',{...verify,runtimeInstance:permit.runtimeInstance})).rejects.toThrow('not-verified')
    await expect(supervisor.handle('management.verify-runtime',{...verify,generation:'generation-old'})).rejects.toThrow('not-verified')
    await expect(supervisor.handle('management.verify-runtime',{...verify,version:'0.1.8'})).rejects.toThrow('not-verified')
    expect(fence.guarded()).toBe(true)
    expect(await supervisor.handle('management.verify-runtime',verify)).toMatchObject({status:'completed',verifiedRuntimeInstance:'new-process'})
    expect(fence.guarded()).toBe(false)
    expect(JSON.parse(await readFile(join(dir,'supervisor/management-jobs.json'),'utf8'))).toHaveLength(1)
  }finally{await rm(dir,{recursive:true,force:true})}
})
