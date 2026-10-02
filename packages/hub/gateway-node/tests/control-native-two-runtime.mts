import { createAdmission } from '../src/admission.ts'
/** Two real rc.2 Runtimes, model-driven official tools, authenticated Gateway carriers; fixture LLM. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import WebSocket from 'ws'
import { createDelegation, type DelegationContext } from '../src/delegation.ts'
import { createRuntimeSurface, type RuntimeContext } from '../src/runtime.ts'
import { serveSurface, ControlRPC } from '../../gateway-transport/src/index.ts'
import { GatewayNetworkManager, connectNodeNetwork } from '../../gateway-network/src/index.ts'
import { createGateway } from '../../gateway-server/src/server.ts'

const installed = process.env.DSH_NATIVE_ROOT
if (!installed) throw new Error('Set DSH_NATIVE_ROOT to an installed rc.2 package tree')
const work = await mkdtemp(join(tmpdir(), 'two-native-control-'))
process.env.DSH_TELEMETRY_DISABLED = '1'
const require = createRequire(join(installed, 'package.json'))
const load = async (name: string) => import(pathToFileURL(require.resolve(name)).href)
const app = await load('@deepseek-ai/dsh-app-boot')
const { LlmAdapter } = await load('@deepseek-ai/dsh-llm')
const contexts: any[] = [], sockets: WebSocket[] = [], delegates: Awaited<ReturnType<typeof createDelegation>>[] = []
const hub = createGateway({ publicUrl:'http://hub.localhost',statePath:join(work,'hub.sqlite'),downloadsDirectory:work,installerPath:join(work,'install.sh'),adminPassword:'fixture-password-only-123',networks:{status:async()=>({} as never),endpoint:()=>'',loginTailscale:async()=>{}} })
hub.privateServer.listen(0,'127.0.0.1'); await once(hub.privateServer,'listening')
const port = (hub.privateServer.address() as {port:number}).port
const reconnectors: (() => Promise<void>)[] = []
const overlays: Awaited<ReturnType<typeof connectNodeNetwork>>[] = []
let networkManager: GatewayNetworkManager | undefined
let overlayEndpoint: string | undefined
if (process.env.GATEWAY_CONTROL_TAILCAT_BIN_DIR) {
  const binaries = join(work, 'bin'); await mkdir(binaries); await symlink(join(process.env.GATEWAY_CONTROL_TAILCAT_BIN_DIR, 'tailcat'), join(binaries, 'tailcat'))
  networkManager = new GatewayNetworkManager({ stateDirectory: join(work, 'overlay-hub'), privatePort: port, binDirectory: binaries, tailscaleMode: 'host' })
  await networkManager.start()
  const deadline = Date.now() + 60000
  while (!overlayEndpoint && Date.now() < deadline) { try { overlayEndpoint = await networkManager.endpoint('tailcat') } catch { await new Promise(r => setTimeout(r,500)) } }
  if (!overlayEndpoint) { await networkManager.close(); await hub.close(); throw new Error('Tailcat relay unavailable') }
}
let targetNode = '', targetWorkspace = '', sourceNode = ''
let latest: any, targetCalls = 0, sourceCalls = 0, cancelled = false
const activeGrant = 'allow-a-b'
const trace: {method:string;result:any;elapsedMs:number}[] = []
async function poll(predicate:()=>boolean, milliseconds=20000) { const end=Date.now()+milliseconds; while(!predicate()) { if(Date.now()>end)throw new Error('Native test timed out'); await new Promise(r=>setTimeout(r,20)) } }
function *textReply(text:string) { yield {type:'block-start',index:0,blockType:'text'}; yield {type:'text-delta',index:0,text}; yield {type:'block-end',index:0,block:{type:'text',text}}; yield {type:'finish',reason:{kind:'stop'}} }
function *tool(name:string,args:unknown) { const id=randomUUID(), argumentsText=JSON.stringify(args); yield {type:'block-start',index:0,blockType:'tool-call'}; yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:argumentsText}; yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:argumentsText}}; yield {type:'finish',reason:{kind:'tool-calls'}} }
class TargetAdapter extends LlmAdapter {
  providerInfo(provider:string){return{id:provider,name:'B fixture'}}
  async listModels(provider:string){return[{provider,id:'model-B',name:'B'}]}
  async *stream(request:any) {
    assert.equal(request.model,'model-B'); targetCalls++
    if(targetCalls>1) { await new Promise<void>(resolve=>{const stop=()=>{cancelled=true;resolve()}; if(request.signal.aborted)stop();else request.signal.addEventListener('abort',stop,{once:true})}); request.signal.throwIfAborted() }
    yield* textReply('B native task result')
  }
}
class SourceAdapter extends LlmAdapter {
  providerInfo(provider:string){return{id:provider,name:'A fixture'}}
  async listModels(provider:string){return[{provider,id:'model-A',name:'A'}]}
  async *stream(request:any) {
    assert.equal(request.model,'model-A'); sourceCalls++
    const base={targetNode,targetRuntime:'runtime-B',workspace:targetWorkspace,requestId:`model-call-${sourceCalls}`}
    if(sourceCalls===1) {yield* tool('peer_discover',{});return}
    if(sourceCalls===2) {yield* tool('peer_task_start',{...base,prompt:'Produce target result'});return}
    if(sourceCalls===3) {await poll(()=>targetCalls===1); await new Promise(r=>setTimeout(r,100));yield* tool('peer_task_read',{...base,taskId:latest.taskId});return}
    if(sourceCalls===4) {assert.equal(latest.result,'B native task result');yield* tool('peer_task_start',{...base,prompt:'Wait until cancellation'});return}
    if(sourceCalls===5) {await poll(()=>targetCalls===2);yield* tool('peer_task_cancel',{...base,taskId:latest.taskId});return}
    assert.equal(latest.status,'cancelled');yield* textReply('A received B result and cancelled second task')
  }
}
let sourceHandle:any
try {
  for(const label of ['B','A']) {
    const directory=join(work,label);await mkdir(directory);await mkdir(join(directory,'workspace'));await writeFile(join(directory,'cordis.yml'),'[]\n');await symlink(join(installed,'node_modules'),join(directory,'node_modules'))
    process.env.DSH_HOME=join(directory,'home')
    const patches=[...app.loadOverlayPatches(`control-${label}`,require.resolve('@deepseek-ai/dsh-base/cordis.patch.yml')),...app.loadOverlayPatches(`control-${label}`,require.resolve('@deepseek-ai/dsh-web-app/cordis.patch.yml')),...app.loadOverlayPatches(`control-${label}`,require.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml')),
      ...['webserver','web-runtime','web-startup','open-in-app','client-hmr','directory-picker','session-title-llm'].map(id=>({id,disabled:true})),{id:'connection',inject:[],config:{trustedHosts:[]}},{id:'agent-default-model',config:{provider:`fixture-${label}`,model:`model-${label}`}}]
    const ctx=await app.boot(`control-${label}`,join(directory,'cordis.yml'),patches,undefined,pathToFileURL(join(installed,'package.json')).href);contexts.push(ctx)
    ctx.llm.registerAdapter([`fixture-${label}`], label==='A'?new SourceAdapter():new TargetAdapter())
    assert.equal(ctx.webServer,undefined)
    const invite=hub.store.invite('tailcat','ws://fixture.invalid',label), credential=randomUUID()+randomUUID()
    const node=hub.store.enroll({inviteToken:invite.token,clientId:randomUUID(),credential,name:label,dshVersion:'0.1.7-rc.2',runtimeId:`runtime-${label}`})
    if(label==='B'){targetNode=node.id;targetWorkspace=join(directory,'workspace')}else sourceNode=node.id
    let rpc:ControlRPC
    const delegation=await createDelegation(ctx as DelegationContext,{admission:createAdmission(join(directory,'management.lock'),ctx.agents,'0.1.7-rc.2'),stateDirectory:join(directory,'control'),workspace:join(directory,'workspace'),runtimeId:`runtime-${label}`,call:async(method,input)=>{const start=performance.now();const result=await rpc.call(method,input);latest=result;trace.push({method,result,elapsedMs:performance.now()-start});return result}});delegates.push(delegation)
    let carrierUrl = `ws://127.0.0.1:${port}`
    if (overlayEndpoint) { const network = await connectNodeNetwork({ mode: 'tailcat', endpoint: overlayEndpoint, stateDirectory: join(directory, 'overlay'), binDirectory: join(work, 'bin') }); overlays.push(network); carrierUrl = network.url.replace(/^http/, 'ws') }
    const {surface}=await createRuntimeSurface(ctx as RuntimeContext,pathToFileURL(join(installed,'package.json')).href)
    const connect = async () => {
      const ws=new WebSocket(`${carrierUrl}/connect?nodeId=${node.id}`,{handshakeTimeout:20000,headers:{authorization:`Bearer ${credential}`,'x-dsh-runtime':`runtime-${label}`,'x-dsh-control':'2','x-dsh-control-capabilities':'delegation'}});sockets.push(ws);await once(ws,'open')
      serveSurface(ws,surface,{control:true});rpc=new ControlRPC(ws,(method,input)=>delegation.handle(method,input))
    }
    await connect(); reconnectors.push(connect)
  }
  hub.store.grant({id:activeGrant,source:sourceNode,target:targetNode,sourceRuntime:'runtime-A',targetRuntime:'runtime-B',workspace:targetWorkspace,capabilities:['discover','task.start','task.read','task.cancel'],expiresAt:Date.now()+60000})
  sourceHandle=await contexts[1].agents.create({sessionId:randomUUID(),meta:{cwd:join(work,'A/workspace')},agentOptions:{provider:'fixture-A',model:'model-A',maxTokens:8192}})
  sourceHandle.agent.send({id:randomUUID(),role:'user',content:[{type:'text',text:'Use authorized peer tools to run a task, read its result and cancel another task.'}],source:{kind:'user',rpcId:randomUUID()}},'next-turn',true)
  await sourceHandle.agent.whenIdle()
  assert.equal(sourceCalls,6);assert.equal(targetCalls,2);assert(cancelled)
  assert.deepEqual(trace.map(t=>t.method),['peer.discover','task.start','task.read','task.start','task.cancel'])
  const owner={sourceNode,sourceRuntime:'runtime-A',sourceSession:sourceHandle.agent.id,targetRuntime:'runtime-B',workspace:targetWorkspace,requestId:'probe-read',taskId:trace[1]!.result.taskId}
  await assert.rejects(delegates[0]!.handle('task.read',{...owner,sourceSession:'another-session'}))
  const {taskId:_task,...startOwner}=owner
  const repeated:any=await delegates[0]!.handle('task.start',{...startOwner,authorizationLeaseMs:30_000,requestId:'model-call-2',prompt:'Produce target result'})
  assert.equal(repeated.taskId,owner.taskId);assert.equal(targetCalls,2)
  const grant = (id:string) => hub.store.grant({id,source:sourceNode,target:targetNode,sourceRuntime:'runtime-A',targetRuntime:'runtime-B',workspace:targetWorkspace,capabilities:['discover','task.start','task.read','task.cancel'],expiresAt:Date.now()+600_000})
  const start = async (requestId:string) => {
    cancelled=false
    const before=targetCalls
    const result=await contexts[1].tools.execute({name:'peer_task_start',arguments:{targetNode,targetRuntime:'runtime-B',workspace:targetWorkspace,requestId,prompt:'Wait'},agent:sourceHandle.agent,callId:randomUUID(),signal:new AbortController().signal})
    assert.equal(result.isError,false,JSON.stringify(result))
    const task={...latest}
    await poll(()=>targetCalls===before+1)
    return task
  }
  const awaitCancelled = async (taskId:string,reason?:string) => {
    const deadline=performance.now()+33_000
    while(performance.now()<deadline) {
      const task:any=await delegates[0]!.handle('task.read',{...owner,taskId})
      if(task.status==='cancelled') { if(reason)assert.equal(task.cancellationReason,reason);assert(cancelled);return }
      await new Promise(r=>setTimeout(r,25))
    }
    throw new Error('Local authorization lease failed to cooperatively cancel within 33 seconds')
  }
  // A live grant and both authenticated sockets keep the target alive beyond one lease.
  hub.store.revokeGrant(activeGrant);grant('renewal-proof')
  const renewed=await start('renewal-proof')
  await new Promise(r=>setTimeout(r,31_000))
  assert.equal((await delegates[0]!.handle('task.read',{...owner,taskId:renewed.taskId}) as any).status,'running')
  hub.store.revokeGrant('renewal-proof')
  await awaitCancelled(renewed.taskId,'authorization-revoked-or-cancelled')
  const denied=await contexts[1].tools.execute({name:'peer_task_read',arguments:{targetNode,targetRuntime:'runtime-B',workspace:targetWorkspace,requestId:'revoked-read',taskId:renewed.taskId},agent:sourceHandle.agent,callId:randomUUID(),signal:new AbortController().signal})
  assert.equal(denied.isError,true)
  console.log('native lease: renewal and revocation passed')

  grant('source-disconnect')
  const disconnected=await start('source-disconnect')
  sockets[1]!.terminate();await poll(()=>!hub.peers.has(sourceNode))
  await awaitCancelled(disconnected.taskId)
  await reconnectors[1]!();await poll(()=>hub.peers.has(sourceNode))
  hub.store.revokeGrant('source-disconnect')
  console.log('native lease: source WebSocket disconnect passed')

  grant('target-generation')
  const generationTask=await start('target-generation')
  const previousGeneration=hub.peers.get(targetNode)?.generation
  sockets[0]!.terminate();await poll(()=>!hub.peers.has(targetNode))
  await reconnectors[0]!();await poll(()=>hub.peers.has(targetNode))
  assert.notEqual(hub.peers.get(targetNode)?.generation,previousGeneration)
  // Replay through the new generation must not reauthorize or resend an old task.
  const beforeReplay=targetCalls
  const retry=await contexts[1].tools.execute({name:'peer_task_start',arguments:{targetNode,targetRuntime:'runtime-B',workspace:targetWorkspace,requestId:'target-generation',prompt:'Wait'},agent:sourceHandle.agent,callId:randomUUID(),signal:new AbortController().signal})
  assert.equal(retry.isError,false);assert.equal(latest.taskId,generationTask.taskId)
  await awaitCancelled(generationTask.taskId,'authorization-lease-expired')
  assert.equal(targetCalls,beforeReplay)
  hub.store.revokeGrant('target-generation')
  console.log('native lease: replacement target generation and no replay passed')

  grant('hub-loss')
  const orphan=await start('hub-loss')
  const lossAt=performance.now()
  await hub.close() // Actual Hub server/socket/timer shutdown; neither Runtime is closed.
  await awaitCancelled(orphan.taskId,'authorization-lease-expired')
  const hubLossCancellationMs=performance.now()-lossAt
  assert(hubLossCancellationMs<=33_000)
  console.log('native lease: actual Hub loss passed')
  const times=trace.map(t=>t.elapsedMs).sort((a,b)=>a-b)
  console.log(JSON.stringify({ok:true,runtimes:2,realModelDrivenToolCalls:5,targetModelCalls:targetCalls,crossSessionDenied:true,revocationCancels:true,renewalBeyond30Seconds:true,sourceSocketDisconnectCancels:true,newTargetGenerationExpires:true,actualHubLossCancels:true,hubLossCancellationMs,cooperativeCancellation:true,reconnectWithoutDuplicateExecution:true,nativeWebListeners:0,network:overlayEndpoint ? 'real Tailcat 0.7.0 encrypted carrier with two independent node helpers; same-host endpoints' : 'authenticated loopback WebSocket; overlay not exercised',p50Ms:times[Math.floor(times.length*.5)],p95Ms:times[Math.floor(times.length*.95)]}))
} finally { await sourceHandle?.dispose();for(const d of delegates)await d.close();for(const s of sockets)s.terminate();await hub.close();for(const network of overlays)await network.close();await networkManager?.close();for(const ctx of contexts)await ctx.fiber.dispose();await rm(work,{recursive:true,force:true}) }
