import { it, expect } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagement, persistManagement, type Manager } from '../src/management.ts'
const request = {requestId:'durable-request',action:'plugin.install',package:'example',version:'1.0.0'}
function fixture(install: Manager['installBundle']): Manager {
  return {listPlugins:async()=>[],listBundles:async()=>[{name:'example',version:'1.0.0',enabled:true,removable:true}],inspect:async()=>({status:'accepted',name:'example',version:'1.0.0',bundle:true}),installBundle:install,removeBundle:async()=>({application:'applied',changed:true}),setPluginEnabled:async()=>({application:'applied',changed:true}),cancelInstall:async()=>({status:'too-late'})}
}
it('fails closed before side effects, recovers an IO rejection without replay and keeps its journal usable',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'journal-io-'));let fail=false,calls=0
  try{
    const m=await createManagement({stateDirectory:dir,version:'fixture',trustedPackages:['example'],manager:fixture(async()=>{calls++;return {changed:true,application:'applied'}}),persist:async(p,d)=>{if(fail)throw new Error('EIO');await persistManagement(p,d)}})
    fail=true;await expect(m.handle('management.submit',request)).rejects.toThrow('persistence-failed')
    expect(calls).toBe(0);expect(await m.handle('management.inventory',{})).toMatchObject({persistence:'persistence-failed',jobs:[{status:'persistence-failed'}]})
    fail=false;await m.handle('management.retry-persistence',{});expect(calls).toBe(0)
    expect(await m.handle('management.submit',request)).toMatchObject({status:'failed'})
    await m.handle('management.submit',{...request,requestId:'fresh-request'})
    await expect.poll(async()=> (await m.handle('management.inventory',{}) as {jobs:{status:string}[]}).jobs.at(-1)?.status).toBe('completed')
    expect(calls).toBe(1)
  }finally{await rm(dir,{recursive:true,force:true})}
})
it('survives background final-write failure and never acknowledges an undurable completion',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'journal-final-'));let fail=false,calls=0
  try{
    const m=await createManagement({stateDirectory:dir,version:'fixture',trustedPackages:['example'],manager:fixture(async()=>{
      expect(JSON.parse(await readFile(join(dir,'management-jobs.json'),'utf8'))[0].status).toBe('running');calls++;fail=true;return {changed:true,application:'applied'}
    }),persist:async(p,d)=>{if(fail)throw new Error('ENOSPC');await persistManagement(p,d)}})
    await m.handle('management.submit',request)
    await expect.poll(async()=> (await m.handle('management.inventory',{}) as {persistence:string}).persistence).toBe('persistence-failed')
    await expect(m.handle('management.submit',{...request,requestId:'other-request'})).rejects.toThrow('persistence-failed')
    expect(await m.handle('management.inventory',{})).toMatchObject({jobs:[{status:'persistence-failed'}]})
    fail=false;await m.handle('management.retry-persistence',{});expect(calls).toBe(1)
    expect(await m.handle('management.submit',request)).toMatchObject({status:'completed'})
  }finally{await rm(dir,{recursive:true,force:true})}
})
it('rejects wrong installed versions and preserves restart-required as a distinct state',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'version-check-'))
  try{
    const manager=fixture(async()=>({changed:true,application:'restart-required'}))
    const m=await createManagement({stateDirectory:dir,version:'fixture',trustedPackages:['example'],manager,lookupVersion:async(name,version)=>({name,version,bundle:true})})
    await m.handle('management.submit',request)
    await expect.poll(async()=> (await m.handle('management.inventory',{}) as {jobs:{status:string}[]}).jobs.at(-1)?.status).toBe('restart-required')
    await m.handle('management.submit',{...request,requestId:'wrong-version',version:'1.0.1'})
    await expect.poll(async()=> (await m.handle('management.inventory',{}) as {jobs:{status:string}[]}).jobs.at(-1)?.status).toBe('failed')
    expect(await m.handle('management.inventory',{})).toMatchObject({jobs:[{}, {error:'installed-version-mismatch',rollback:'restored-previous-version'}]})
  }finally{await rm(dir,{recursive:true,force:true})}
})
it('keeps uncertain executor locks across supervisor restart even after the original PID has exited',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'executor-lock-'))
  try{
    const lock=join(dir,'operation.lock');await mkdir(lock);await writeFile(join(lock,'owner.json'),JSON.stringify({pid:2147483647,executorMayOutlive:true}))
    const m=await createManagement({stateDirectory:dir,version:'external',trustedPackages:[],lifecycle:true,updateExecutor:'/configured/executor'})
    await expect(m.handle('management.recover',{})).rejects.toThrow('PID-only recovery forbidden')
    await expect(m.handle('management.submit',{requestId:'stop-runtime',action:'dsh.stop',target:'current'})).rejects.toThrow('lock')
  }finally{await rm(dir,{recursive:true,force:true})}
})
it('keeps startup IO failures visible and never overwrites an unreadable journal',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'journal-startup-'))
  try{
    const m=await createManagement({stateDirectory:dir,version:'fixture',trustedPackages:[],persist:async()=>{throw new Error('EIO')}})
    expect(await m.handle('management.inventory',{})).toMatchObject({persistence:'persistence-failed'})
    const journal=join(dir,'management-jobs.json');await writeFile(journal,'corrupt')
    const restarted=await createManagement({stateDirectory:dir,version:'fixture',trustedPackages:[]})
    expect(await restarted.handle('management.inventory',{})).toMatchObject({persistence:'persistence-failed'})
    await expect(restarted.handle('management.retry-persistence',{})).rejects.toThrow('repair locally')
    expect(await readFile(journal,'utf8')).toBe('corrupt')
  }finally{await rm(dir,{recursive:true,force:true})}
})
it('locks timed out management executors until explicit local reconciliation, even after they exit',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'management-timeout-'))
  try{
    const executor=join(dir,'executor');await writeFile(executor,`#!${process.execPath}\nsetTimeout(()=>console.log(JSON.stringify({status:'completed'})),150)`,{mode:0o700})
    const m=await createManagement({stateDirectory:dir,version:'external',trustedPackages:[],lifecycle:true,updateExecutor:executor,executorTimeoutMs:20})
    await m.handle('management.submit',{requestId:'timeout-stop',action:'dsh.stop',target:'current'})
    await expect.poll(async()=> (await m.handle('management.inventory',{}) as {recovery:string}).recovery).toBe('manual-executor-reconciliation-required')
    await new Promise(r=>setTimeout(r,250))
    expect(await m.handle('management.inventory',{})).toMatchObject({jobs:[{status:'executor-recovery-required'}]})
    await expect(m.handle('management.retry-persistence',{})).rejects.toThrow('reconciliation')
    await expect(m.handle('management.submit',{requestId:'after-timeout',action:'dsh.stop',target:'current'})).rejects.toThrow('busy')
  }finally{await rm(dir,{recursive:true,force:true})}
})
