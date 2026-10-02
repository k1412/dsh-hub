import { mkdir, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { persistManagement } from './management.ts'
export const runtimeInstance = `${process.pid}:${performance.timeOrigin}`
export interface ActivityAgent { status: string; whenIdle(): Promise<void> }
export interface ActivityRegistry { list(): ActivityAgent[] }
export interface AdmissionOwner { pid: number; requestId: string; action?: string; phase?: string; token?: string; runtimeInstance?: string; version?: string; quiescent?: boolean; executorMayOutlive?: boolean }
export async function readOwner(directory: string): Promise<AdmissionOwner> { return JSON.parse(await readFile(join(directory,'owner.json'),'utf8')) as AdmissionOwner }
export async function assertQuiescent(agents: ActivityRegistry | undefined): Promise<void> {
  if (!agents?.list) throw new Error('native-activity-api-required')
  const list=agents.list()
  if(list.some(a=>a.status!=='idle'))throw new Error('native-agents-busy; no-task-cancelled')
  let timer:ReturnType<typeof setTimeout>|undefined
  try { await Promise.race([Promise.all(list.map(a=>a.whenIdle())),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('native-maintenance-busy')),250)})]) }
  finally {if(timer)clearTimeout(timer)}
  if(agents.list().some(a=>a.status!=='idle'))throw new Error('native-agents-busy; no-task-cancelled')
}
/** The existing node operation lock fences Hub admissions, not arbitrary local CLI changes. */
export function createAdmission(directory:string, agents:ActivityRegistry|undefined, version:string) {
  async function quiescent() {
    await assertQuiescent(agents)
    const owner=await readOwner(directory)
    await persistManagement(join(directory,'owner.json'),JSON.stringify({...owner,quiescent:true}))
    // A native request admitted while the idle check yielded must still cause refusal.
    if(agents?.list().some(a=>a.status!=='idle'))throw new Error('native-agents-busy; no-task-cancelled')
  }
  const api = {
    runtimeInstance,
    quiescent,
    guarded() {try{return JSON.parse(readFileSync(join(directory,'owner.json'),'utf8')).quiescent===true}catch{return false}},
    async task<T>(run:()=>Promise<T>):Promise<T>{
      try{await mkdir(directory,{mode:0o700})}catch{throw new Error('node-maintenance; delegation-admission-closed')}
      try{await persistManagement(join(directory,'owner.json'),JSON.stringify({pid:process.pid,requestId:randomUUID(),phase:'task-admission'}));return await run()}
      finally{await rm(directory,{recursive:true,force:true})}
    },
    async prepare(input:Record<string,unknown>){
      const action=String(input.action),requestId=String(input.requestId)
      if(!['dsh.update','dsh.restart','dsh.stop','dsh.uninstall'].includes(action)||!/^[\w-]{8,80}$/.test(requestId))throw new Error('invalid-maintenance-request')
      let previous:AdmissionOwner|undefined
      try{await mkdir(directory,{mode:0o700})}catch{
        const owner=await readOwner(directory)
        if(action!=='dsh.restart'||owner.phase!=='restart-required'||owner.pid!==process.pid)throw new Error('node-busy-or-recovery-required')
        previous=owner
      }
      const token=randomUUID()
      try{
        await persistManagement(join(directory,'owner.json'),JSON.stringify({pid:process.pid,requestId,action,phase:'prepared',token,runtimeInstance,version,executorMayOutlive:true}))
        await quiescent()
        return {token,runtimeInstance,version,restoreRestart:!!previous}
      }catch(error){if(previous)await persistManagement(join(directory,'owner.json'),JSON.stringify(previous));else await rm(directory,{recursive:true,force:true});throw error}
    },
    async release(input:Record<string,unknown>){
      const owner=await readOwner(directory)
      if(owner.phase!=='prepared'||owner.token!==input.token)throw new Error('maintenance-already-adopted-or-stale')
      // Once prepared for a restart of a partially applied plugin, retain its fence.
      if(input.restoreRestart===true)await persistManagement(join(directory,'owner.json'),JSON.stringify({...owner,phase:'restart-required'}))
      else await rm(directory,{recursive:true,force:true})
      return {status:'released'}
    },
  }
  let preparing=false
  return {...api,prepare(input:Record<string,unknown>){
    if(preparing)return Promise.reject(new Error('node-busy; preparation already in progress'))
    preparing=true;return api.prepare(input).finally(()=>{preparing=false})
  }}
}
