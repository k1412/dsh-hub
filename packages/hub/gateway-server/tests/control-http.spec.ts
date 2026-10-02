import { it, expect } from 'vitest'
import { createFixture } from './fixture.ts'
it('keeps legacy nodes usable, gates control by operator and persists directional grant administration',async()=>{
  const f=await createFixture()
  try{
    const a=await f.addNode('A'),b=await f.addNode('B')
    expect((await f.request(`/control/${a.id}`,{operator:true})).status).toBe(409)
    expect((await f.request('/control/grants')).status).toBe(401)
    const payload={source:a.id,target:b.id,workspace:'/delegated',capabilities:'discover,task.start,task.read,task.cancel',expiresAt:String(Date.now()+60000)}
    expect((await f.request('/control/grants',{operator:true,method:'POST',headers:{origin:f.publicUrl,'content-type':'application/json'},body:JSON.stringify(payload)})).status).toBe(303)
    expect(f.gateway.store.grants()).toMatchObject([{source:a.id,target:b.id,sourceRuntime:'runtime-A',targetRuntime:'runtime-B'}])
    expect((await f.request('/control/grants',{operator:true,method:'POST',headers:{origin:'http://attacker.invalid','content-type':'application/json'},body:JSON.stringify({...payload,source:b.id,target:a.id})})).status).toBe(403)
    const grant=f.gateway.store.grants()[0]!
    expect((await f.request('/control/grants',{operator:true,method:'POST',headers:{origin:f.publicUrl,'content-type':'application/json'},body:JSON.stringify({revoke:grant.id})})).status).toBe(303)
    expect(f.gateway.store.grants()).toEqual([])
    expect(f.gateway.store.auditRows()).toHaveLength(2)
  }finally{await f.close()}
})
it('keeps authenticated supervisor separate from native generation and usable after Runtime stops',async()=>{
  const {default:WebSocket}=await import('ws')
  const {once}=await import('node:events')
  const {ControlRPC,serveSurface}=await import('../../gateway-transport/src/index.ts')
  const f=await createFixture()
  let socket:InstanceType<typeof WebSocket>|undefined
  try{
    const a=await f.addNode('A'),native=f.gateway.peers.get(a.id)
    socket=new WebSocket(`ws://127.0.0.1:${f.privatePort}/supervise?nodeId=${a.id}`,{headers:{authorization:`Bearer ${a.credential}`,'x-dsh-runtime':'runtime-A','x-dsh-control':'2','x-dsh-control-capabilities':'lifecycle'}})
    await once(socket,'open')
    serveSurface(socket,{handle:async()=>new Response('',{status:404}),openMux:()=>{throw new Error('No Runtime')}},{control:true})
    const actions:unknown[]=[]
    const control=new ControlRPC(socket,async(method,input)=>{actions.push({method,input});return {runtimeLifecycle:['dsh.start','dsh.stop'],jobs:[]}})
    expect(f.gateway.peers.get(a.id)).toBe(native)
    a.socket.terminate();await new Promise(r=>setTimeout(r,20))
    expect((await f.request(`/control/${a.id}`,{operator:true})).status).toBe(200)
    expect((await f.request(`/control/${a.id}`,{operator:true,method:'POST',headers:{origin:f.publicUrl,'content-type':'application/json'},body:JSON.stringify({method:'management.submit',action:'dsh.start',target:'current',requestId:'start-123'})})).status).toBe(200)
    expect(actions).toContainEqual({method:'management.submit',input:{method:'management.submit',action:'dsh.start',target:'current',requestId:'start-123'}})
    await expect(control.call('peer.discover',{})).rejects.toThrow()
    await f.request(`/nodes/${a.id}/revoke`,{operator:true,method:'POST',headers:{origin:f.publicUrl}})
    expect(f.gateway.supervisors.has(a.id)).toBe(false)
  }finally{socket?.terminate();await f.close()}
})
it('never routes lifecycle or version checks into a management-capable Runtime without a supervisor',async()=>{
  const {default:WebSocket}=await import('ws'),{once}=await import('node:events')
  const {ControlRPC,serveSurface}=await import('../../gateway-transport/src/index.ts')
  const f=await createFixture();let socket:InstanceType<typeof WebSocket>|undefined
  try{
    const node=await f.addNode('A');await f.disconnect(node)
    socket=new WebSocket(`ws://127.0.0.1:${f.privatePort}/connect?nodeId=${node.id}`,{headers:{authorization:`Bearer ${node.credential}`,'x-dsh-runtime':'runtime-A','x-dsh-control':'2','x-dsh-control-capabilities':'management'}})
    await once(socket,'open');serveSurface(socket,node.surface,{control:true})
    const calls:unknown[]=[];const rpc=new ControlRPC(socket,async(method,input)=>{calls.push({method,input});return {version:'fixture',plugins:[],bundles:[],jobs:[]}})
    for(const action of ['dsh.install','dsh.start','dsh.stop','dsh.uninstall','dsh.update','dsh.restart']){
      for(const method of ['management.submit','management.check']){
        const result=await f.request(`/control/${node.id}`,{operator:true,method:'POST',headers:{origin:f.publicUrl,'content-type':'application/json'},body:JSON.stringify({method,action,target:'0.1.8',requestId:'no-fallback'})})
        expect(result.status).not.toBe(200)
      }
    }
    expect(calls).toEqual([])
    expect((await f.request(`/control/${node.id}`,{operator:true})).status).toBe(200)
    expect(calls).toHaveLength(1)
    const cleanup={method:'task.cleanup',requestId:'unused-id',retentionMs:86400000}
    expect((await f.request(`/control/${node.id}`,{method:'POST',headers:{origin:f.publicUrl,'content-type':'application/json'},body:JSON.stringify(cleanup)})).status).toBe(401)
    expect((await f.request(`/control/${node.id}`,{operator:true,method:'POST',headers:{origin:f.publicUrl,'content-type':'application/json'},body:JSON.stringify(cleanup)})).status).toBe(200)
    expect(calls.at(-1)).toEqual({method:'task.cleanup',input:{retentionMs:86400000}});rpc.close()
  }finally{socket?.terminate();await f.close()}
})
it('leaves native access usable while refusing the older experimental control protocol',async()=>{
  const {default:WebSocket}=await import('ws'),{once}=await import('node:events')
  const f=await createFixture();let socket:InstanceType<typeof WebSocket>|undefined
  try{
    const node=await f.addNode('A');await f.disconnect(node)
    socket=new WebSocket(`ws://127.0.0.1:${f.privatePort}/connect?nodeId=${node.id}`,{headers:{authorization:`Bearer ${node.credential}`,'x-dsh-runtime':'runtime-A','x-dsh-control':'1','x-dsh-control-capabilities':'management'}})
    let accepted:unknown;socket.once('upgrade',res=>{accepted=res.headers['x-dsh-control']});await once(socket,'open')
    expect(accepted).toBeUndefined();expect(f.gateway.peers.get(node.id)?.control).toBeUndefined()
    expect((await f.request(`/control/${node.id}`,{operator:true})).status).toBe(409)
    expect(f.gateway.peers.has(node.id)).toBe(true)
  }finally{socket?.terminate();await f.close()}
})
