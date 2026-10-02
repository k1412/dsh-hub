import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { createManagement, type Manager } from '../src/management.ts'
it('isolates node journals, serializes jobs, deduplicates requests and sanitizes inventory', async () => {
  const dir = await mkdtemp(join(tmpdir(),'control-test-'))
  let finish: (() => void) | undefined, installs = 0
  const manager = { listPlugins: async () => [{ entryId:'x',moduleName:'example',enabled:true,fiberPhase:'active', config:{ secret:'never-return' } }], listBundles:async()=>[{name:'example',version:'1.0.0'}], inspect:async()=>({status:'accepted',name:'example',version:'1.0.0',bundle:true}), installBundle:async()=> { installs++; await new Promise<void>(r=>{finish=r}); return {changed:true,application:'applied'} }, cancelInstall:async()=>({status:'too-late'}) } as unknown as Manager
  try {
    const a = await createManagement({stateDirectory:join(dir,'a'),version:'0.1.7-rc.2',trustedPackages:['example'],manager})
    const b = await createManagement({stateDirectory:join(dir,'b'),version:'0.1.7-rc.2',trustedPackages:['example'],manager})
    const request = { requestId:'request-123',action:'plugin.install',package:'example',version:'1.0.0' }
    await a.handle('management.submit',request)
    expect(await a.handle('management.submit',request)).toMatchObject({id:'request-123'})
    await expect(a.handle('management.submit',{...request,requestId:'request-456'})).rejects.toThrow('busy')
    expect(JSON.stringify(await a.handle('management.inventory',{}))).not.toContain('never-return')
    expect(await b.handle('management.inventory',{})).toMatchObject({jobs:[]})
    await expect.poll(()=>installs).toBe(1); finish!(); await new Promise(r=>setTimeout(r,30))
    const restored = await createManagement({stateDirectory:join(dir,'a'),version:'0.1.7-rc.2',trustedPackages:['example'],manager})
    expect(await restored.handle('management.submit',request)).toMatchObject({status:'completed'})
    await expect(b.handle('management.submit',{...request,package:'untrusted'})).rejects.toThrow('untrusted')
    await expect(b.handle('management.submit',{requestId:'update123',action:'dsh.update',target:'0.1.8'})).rejects.toThrow('supervisor-required')
  } finally { await rm(dir,{recursive:true,force:true}) }
})
it('shares an exclusive operation lock with the resident supervisor and refuses recovering a live owner',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'shared-manager-'))
  let finish: (()=>void)|undefined
  const manager={listBundles:async()=>[{name:'example',version:'1.0.0'}],inspect:async()=>({status:'accepted',name:'example',version:'1.0.0',bundle:true}),installBundle:async()=>{await new Promise<void>(r=>{finish=r});return{changed:true,application:'applied'}}} as unknown as Manager
  try{
    const node=await createManagement({stateDirectory:join(dir,'node'),lockDirectory:join(dir,'shared.lock'),version:'0.1.7-rc.2',trustedPackages:['example'],manager})
    const supervisor=await createManagement({stateDirectory:join(dir,'supervisor'),lockDirectory:join(dir,'shared.lock'),version:'external',trustedPackages:[],lifecycle:true,updateExecutor:'/configured/local-executor'})
    await node.handle('management.submit',{requestId:'shared-install',action:'plugin.install',package:'example',version:'1.0.0'})
    await expect(supervisor.handle('management.submit',{requestId:'stop-running',action:'dsh.stop',target:'current'})).rejects.toThrow('lock')
    await expect(supervisor.handle('management.recover',{})).rejects.toThrow('PID-only recovery forbidden')
    await expect.poll(()=>!!finish).toBe(true); finish!();await new Promise(r=>setTimeout(r,30))
  }finally{await rm(dir,{recursive:true,force:true})}
})
