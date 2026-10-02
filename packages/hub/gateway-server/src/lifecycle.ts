import type { ControlPeer } from './control.ts'
interface Inventory { jobs?: Array<Record<string,unknown>>; version?: string; runtimeInstance?: string }
export interface LifecyclePeer extends ControlPeer { version?: string }
/** Only the operator HTTP handler invokes this; peer/model dispatch has no management path. */
export async function submitLifecycle(input:Record<string,unknown>, peer:LifecyclePeer|undefined, supervisor:LifecyclePeer, current:()=>boolean):Promise<unknown>{
  if(!supervisor.control||!supervisor.capabilities.includes('lifecycle'))throw new Error('independent-supervisor-required')
  const prior=await supervisor.control.call('management.inventory',{}) as Inventory
  if(prior.jobs?.some(job=>job.id===input.requestId))return supervisor.control.call('management.submit',input)
  if(!['dsh.update','dsh.restart','dsh.stop','dsh.uninstall'].includes(String(input.action)))return supervisor.control.call('management.submit',input)
  if(!peer?.control||!peer.capabilities.includes('admission'))throw new Error('Runtime 在线并支持维护准入检查后才能执行；不会取消现有任务。')
  const permit=await peer.control.call('management.prepare',{action:input.action,requestId:input.requestId}) as Record<string,unknown>
  try{
    if(!current())throw new Error('Runtime or supervisor generation changed during preparation')
    return await supervisor.control.call('management.submit',{...input,admissionToken:permit.token,previousRuntimeInstance:permit.runtimeInstance,previousGeneration:peer.generation,previousVersion:permit.version})
  }catch(error){
    // Release only an unadopted preparation. A timed-out executor must keep its fence.
    try{await peer.control.call('management.release',{token:permit.token,restoreRestart:permit.restoreRestart===true})}catch{/* adopted or disconnected; local reconciliation */}
    throw error
  }
}
export async function verifyLifecycle(peer:LifecyclePeer|undefined,supervisor:LifecyclePeer,current:()=>boolean):Promise<boolean>{
  if(!supervisor.control)return false
  const inventory=await supervisor.control.call('management.inventory',{}) as Inventory
  const pending=(inventory.jobs??[]).filter(job=>['running','awaiting-runtime-verification','persistence-failed','executor-recovery-required'].includes(String(job.status)))
  for(const job of pending){
    if(job.status!=='awaiting-runtime-verification'||!peer?.control||peer.generation===job.previousGeneration)continue
    const runtime=await peer.control.call('management.inventory',{}) as Inventory
    if(!current()||!runtime.runtimeInstance||runtime.runtimeInstance===job.previousRuntimeInstance||runtime.version!==job.expectedVersion||peer.version!==runtime.version)continue
    if(job.previousRuntimeInstance)await peer.control.call('management.restarted',{previousRuntimeInstance:job.previousRuntimeInstance})
    if(!current())continue
    await supervisor.control.call('management.verify-runtime',{requestId:job.id,generation:peer.generation,runtimeInstance:runtime.runtimeInstance,version:runtime.version})
  }
  return pending.length>0
}
