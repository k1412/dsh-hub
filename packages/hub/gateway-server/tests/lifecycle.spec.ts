import {it,expect} from 'vitest'
import {submitLifecycle,verifyLifecycle,type LifecyclePeer} from '../src/lifecycle.ts'
import type {ControlRPC} from '../../gateway-transport/src/control.ts'
const rpc=(call:(method:string,input:Record<string,unknown>)=>Promise<unknown>)=>({call}) as unknown as ControlRPC
it('requires authenticated Runtime admission and stops on generation changes before executor dispatch',async()=>{
  const calls:string[]=[]
  const supervisor:LifecyclePeer={generation:'supervisor',runtimeId:'r',capabilities:['lifecycle'],control:rpc(async(method)=>{calls.push(method);return {jobs:[]}})}
  const request={action:'dsh.restart',requestId:'restart-123',target:'current'}
  await expect(submitLifecycle(request,undefined,supervisor,()=>true)).rejects.toThrow('Runtime')
  const peer:LifecyclePeer={generation:'old',runtimeId:'r',capabilities:['admission'],control:rpc(async(method)=>{calls.push(method);return {token:'permit',runtimeInstance:'old-process',version:'0.1.7-rc.2'}})}
  await expect(submitLifecycle(request,peer,supervisor,()=>false)).rejects.toThrow('generation changed')
  expect(calls).toContain('management.release');expect(calls).not.toContain('management.submit')
})
it('verifies new process, generation and actual handshake version, with no active-plugin version claim',async()=>{
  const calls:string[]=[]
  const job={id:'restart-123',status:'awaiting-runtime-verification',previousGeneration:'old',previousRuntimeInstance:'old-process',expectedVersion:'0.1.7-rc.2'}
  const supervisor:LifecyclePeer={generation:'supervisor',runtimeId:'r',capabilities:['lifecycle'],control:rpc(async(method)=>{calls.push(method);return {jobs:[job]}})}
  let process='old-process'
  const peer:LifecyclePeer={version:'0.1.7-rc.2',generation:'new',runtimeId:'r',capabilities:['management','admission'],control:rpc(async(method)=>{calls.push(method);return {version:'0.1.7-rc.2',runtimeInstance:process}})}
  await verifyLifecycle(peer,supervisor,()=>true);expect(calls).not.toContain('management.verify-runtime')
  process='new-process';await verifyLifecycle(peer,supervisor,()=>true)
  expect(calls).toContain('management.restarted');expect(calls).toContain('management.verify-runtime')
})
