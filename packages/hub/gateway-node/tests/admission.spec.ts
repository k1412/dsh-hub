import {it,expect} from 'vitest'
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createAdmission,readOwner} from '../src/admission.ts'
import {createManagement,persistManagement,type Manager} from '../src/management.ts'
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
it('does not verify or retry persistence before the lifecycle owner is durably finalized',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'admission-finalize-'))
  const lock=join(dir,'lock'),calls=join(dir,'calls')
  let release!:()=>void,entered!:()=>void
  const held=new Promise<void>(resolve=>{release=resolve}),writing=new Promise<void>(resolve=>{entered=resolve})
  let supervisor:Awaited<ReturnType<typeof createManagement>>|undefined
  try{
    const fence=createAdmission(lock,{list:()=>[]},'0.1.7-rc.2')
    const executable=join(dir,'restart')
    await writeFile(executable,`#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},'once\\n');console.log(JSON.stringify({status:'completed',installedVersion:'0.1.7-rc.2'}))`,{mode:0o700})
    supervisor=await createManagement({stateDirectory:join(dir,'supervisor'),lockDirectory:lock,version:'external',trustedPackages:[],lifecycle:true,updateExecutor:executable,persist:async(path,data)=>{
      if(path===join(lock,'owner.json')&&JSON.parse(data).phase==='awaiting-runtime-verification'){entered();await held}
      await persistManagement(path,data)
    }})
    const permit=await fence.prepare({action:'dsh.restart',requestId:'restart-finalize'})
    const request={action:'dsh.restart',requestId:'restart-finalize',target:'current',admissionToken:permit.token,previousRuntimeInstance:permit.runtimeInstance,previousVersion:permit.version,previousGeneration:'generation-old'}
    await supervisor.handle('management.submit',request)
    await writing
    const verify={requestId:'restart-finalize',generation:'generation-new',runtimeInstance:'new-process',version:'0.1.7-rc.2'}
    await expect(supervisor.handle('management.verify-runtime',verify)).rejects.toThrow('executing')
    await expect(supervisor.handle('management.retry-persistence',{})).rejects.toThrow('Operation')
    expect(await supervisor.handle('management.submit',request)).toMatchObject({id:'restart-finalize',status:'running'})
    await expect(supervisor.handle('management.submit',{...request,requestId:'restart-another'})).rejects.toThrow('busy')
    expect(await supervisor.handle('management.inventory',{})).toMatchObject({jobs:[{status:'running'}]})
    expect(await readOwner(lock)).toMatchObject({requestId:'restart-finalize',phase:'executing'})
    expect(fence.guarded()).toBe(true)
    expect(await readFile(calls,'utf8')).toBe('once\n')
    release()
    await expect.poll(async()=> (await supervisor!.handle('management.inventory',{}) as {jobs:Array<{status:string}>}).jobs[0]?.status).toBe('awaiting-runtime-verification')
    expect(await readOwner(lock)).toMatchObject({requestId:'restart-finalize',phase:'awaiting-runtime-verification'})
    expect(await supervisor.handle('management.verify-runtime',verify)).toMatchObject({status:'completed',verifiedRuntimeInstance:'new-process'})
    expect(fence.guarded()).toBe(false)
    expect(await readFile(calls,'utf8')).toBe('once\n')
    expect(JSON.parse(await readFile(join(dir,'supervisor/management-jobs.json'),'utf8'))).toMatchObject([{id:'restart-finalize',status:'completed'}])
  }finally{
    release()
    if(supervisor)await expect.poll(async()=> (await supervisor!.handle('management.inventory',{}) as {jobs:Array<{status:string}>}).jobs[0]?.status!=='running').toBe(true)
    await rm(dir,{recursive:true,force:true})
  }
})
it('retains disk/application uncertainty and permits only an idle controlled restart to adopt that fence',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'disk-application-'));let disk='1.0.0',installs=0
  let holdRetry=false,releaseRetry!:()=>void,retryEntered!:()=>void,pendingRetry:Promise<unknown>|undefined
  const retryWait=new Promise<void>(resolve=>{releaseRetry=resolve}),retryWriting=new Promise<void>(resolve=>{retryEntered=resolve})
  const ownerPhases:string[]=[]
  const manager={listPlugins:async()=>[],listBundles:async()=>[{name:'example',version:disk}],inspect:async()=>({status:'accepted',name:'example',version:'1.0.1',bundle:true}),installBundle:async()=>{installs++;disk='1.0.1';return {changed:true,application:'failed',error:{code:'operation-error'}}}} as unknown as Manager
  try{
    const lock=join(dir,'lock'),fence=createAdmission(lock,{list:()=>[]},'0.1.7-rc.2')
    const runtime=await createManagement({stateDirectory:join(dir,'runtime'),lockDirectory:lock,version:'0.1.7-rc.2',trustedPackages:['example'],manager,quiescent:fence.quiescent,persist:async(path,data)=>{
      if(holdRetry&&path===join(dir,'runtime/management-jobs.json')){retryEntered();await retryWait}
      if(path===join(lock,'owner.json'))ownerPhases.push(JSON.parse(data).phase)
      await persistManagement(path,data)
    }})
    await runtime.handle('management.submit',{action:'plugin.install',requestId:'install-new',package:'example',version:'1.0.1'})
    await expect.poll(async()=> (await runtime.handle('management.inventory',{}) as {jobs:Array<{status:string}>}).jobs[0]?.status).toBe('restart-required')
    expect(installs).toBe(1)
    const ownerWrites=ownerPhases.length
    await runtime.handle('management.retry-persistence',{});expect(fence.guarded()).toBe(true);expect(installs).toBe(1)
    expect(ownerPhases).toHaveLength(ownerWrites)
    expect(await runtime.handle('management.inventory',{})).toMatchObject({jobs:[{diskVersion:'1.0.1',upstreamApplication:'failed',applicationState:'active-version-unverified'}]})
    const old=await readOwner(lock);expect(old.phase).toBe('restart-required')
    await expect(runtime.handle('management.submit',{action:'plugin.remove',requestId:'remove-new',target:'example'})).rejects.toThrow('busy')
    const executable=join(dir,'restart');await writeFile(executable,`#!${process.execPath}\nconsole.log(JSON.stringify({status:'completed',installedVersion:'0.1.7-rc.2'}))`,{mode:0o700})
    const supervisor=await createManagement({stateDirectory:join(dir,'supervisor'),lockDirectory:lock,version:'external',trustedPackages:[],lifecycle:true,updateExecutor:executable})
    holdRetry=true;pendingRetry=runtime.handle('management.retry-persistence',{})
    await retryWriting
    const permit=await fence.prepare({action:'dsh.restart',requestId:'restart-new'})
    releaseRetry()
    await expect(pendingRetry).rejects.toThrow('owner-changed')
    await expect(runtime.handle('management.retry-persistence',{})).rejects.toThrow('owner-changed')
    expect(await readOwner(lock)).toMatchObject({requestId:'restart-new',phase:'prepared',token:permit.token})
    expect(ownerPhases).toHaveLength(ownerWrites)
    expect(installs).toBe(1)
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
  }finally{releaseRetry();await pendingRetry?.catch(()=>{});await rm(dir,{recursive:true,force:true})}
})
