/** Published rc.2 Remote + genuine HMR regression; disposable local profile only. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { createManagement, type Manager } from '../src/management.ts'
const root=process.env.DSH_NATIVE_ROOT,pnpm=process.env.DSH_TEST_PNPM
if(!root||!pnpm)throw new Error('Set DSH_NATIVE_ROOT and DSH_TEST_PNPM to installed trees')
const work=await mkdtemp(join(tmpdir(),'native-management-')),req=createRequire(join(root,'package.json')),exec=promisify(execFile)
// CI may expose a shell/native pnpm launcher; a local pinned cjs remains supported.
const firstLine=(await readFile(pnpm,'utf8')).split('\n')[0] ?? ''
const packageManager=/\.c?js$/.test(pnpm)||(firstLine.startsWith('#!')&&firstLine.includes('node'))
  ? {command:process.execPath,args:[pnpm],env:{}}
  : {command:pnpm,args:[] as string[],env:{}}
await exec(packageManager.command,[...packageManager.args,'--version'])
const app=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')).href)
const versions=new Map<string,Buffer>()
for(const version of ['1.0.0','1.0.1']) {
  const dir=join(work,version);await mkdir(dir)
  await writeFile(join(dir,'package.json'),JSON.stringify({name:'gateway-control-fixture',version,type:'module',main:'index.js',dsh:{bundle:{patch:'./cordis.patch.yml'}}}))
  await writeFile(join(dir,'index.js'),`export const name='control-fixture';export function apply(ctx){ctx.provide('controlFixture','${version}')}`)
  await writeFile(join(dir,'cordis.patch.yml'),'- insert:\n    - id: control-fixture\n      name: gateway-control-fixture\n')
  const packed=JSON.parse((await exec('npm',['pack','--json'],{cwd:dir})).stdout)[0]
  versions.set(version,await readFile(join(dir,packed.filename)))
}
let registryUrl=''
const registry=createServer((request,response)=>{
  const match=/^\/tar\/(1\.0\.[01])\.tgz$/.exec(request.url??'')
  if(match){response.end(versions.get(match[1]!));return}
  if((request.url??'').split('?')[0]!='/gateway-control-fixture'){response.writeHead(404);response.end('{}');return}
  response.setHeader('content-type','application/json')
  response.end(JSON.stringify({name:'gateway-control-fixture','dist-tags':{latest:'1.0.1'},versions:Object.fromEntries([...versions].map(([version,data])=>[version,{name:'gateway-control-fixture',version,dsh:{bundle:{patch:'./cordis.patch.yml'}},dist:{tarball:`${registryUrl}/tar/${version}.tgz`,shasum:createHash('sha1').update(data).digest('hex')}}]))}))
})
registry.listen(0,'127.0.0.1');await once(registry,'listening');registryUrl=`http://127.0.0.1:${(registry.address() as {port:number}).port}`

let ctx:any
const directory=process.env.DSH_HMR_RESTART_PROFILE??join(work,'profile'),home=process.env.DSH_HMR_RESTART_HOME??join(work,'home')
const originalEnv={home:process.env.DSH_HOME,telemetry:process.env.DSH_TELEMETRY_DISABLED}
const corePackages=['dsh','dsh-plugin-manager','dsh-hmr','dsh-api-gateway','dsh-app-boot']
async function coreHashes(){return Promise.all(corePackages.map(async name=>[name,createHash('sha256').update(await readFile(req.resolve(`@deepseek-ai/${name}${name==='dsh'?'/package.json':''}`))).digest('hex')]))}
const originalCore=await coreHashes()
let liveRuntimes=0,maxLiveRuntimes=0
async function boot(){
  assert.equal(liveRuntimes,0,'Dispose original Runtime before restarting its profile')
  const bundles=['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']
  const overlays=[...['webserver','web-runtime','web-startup','open-in-app','client-hmr','directory-picker','session-title-llm'].map(id=>({id,disabled:true})),{id:'connection',inject:[],config:{trustedHosts:[]}},{id:'plugin-manager',config:{registry:registryUrl,fallbackRegistries:[]}}]
  const profile={name:'hmr-fixture',dir:directory,patchPath:join(directory,'cordis.patch.yml'),installAnchor:req.resolve('@deepseek-ai/dsh/package.json'),cwd:directory,home,startedBundles:bundles,overlays,telemetryDisabledEnv:'1',packageManager}
  const loaded=app.loadProfileDirectory(profile.name,directory,profile.installAnchor)
  const resolution=await app.createRuntimeResolution({installAnchor:profile.installAnchor,profile:loaded,home})
  const listeners=new Set<()=>void>();let ready=false
  ctx=await app.boot(profile.name,join(directory,'cordis.yml'),app.readProfilePatches('dsh',profile,loaded),async(context:any)=>{
    context.provide('profileContext',profile)
    context.provide('appReady',{onReady(listener:()=>void){if(ready)listener();else listeners.add(listener);return()=>listeners.delete(listener)}})
    await context.plugin(app.PluginPackages,{resolution})
  })
  liveRuntimes++;maxLiveRuntimes=Math.max(maxLiveRuntimes,liveRuntimes)
  ready=true;for(const listener of listeners)listener();listeners.clear()
  assert(ctx.get('hmr'));assert(ctx.get('typertGateway'));assert(ctx.get('pluginManager'))
}
async function stop(){if(ctx){await ctx.fiber.dispose();ctx=undefined;liveRuntimes--}}
async function remote(endpoint:string,args:Record<string,unknown>={}){
  const handler=ctx.get('connection').createSharedFetchHandler('/api')
  const response=await handler.fetch(new Request(`http://localhost/api/${endpoint}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'hmr-fixture',method:endpoint,payload:{args}}),signal:AbortSignal.timeout(60000)}))
  assert.equal(response.status,200)
  const envelope:any=await response.json()
  assert.equal(envelope.result.ok,true,JSON.stringify(envelope))
  return envelope.result.value
}
async function diskVersion(){return JSON.parse(await readFile(join(directory,'node_modules/gateway-control-fixture/package.json'),'utf8')).version}
async function activeVersion(){
  // Public inventory is lifecycle evidence, NOT active-code version evidence.
  // The fixture publishes its compile-time version from its live apply(ctx).
  const inventory=await remote('pluginInventory/list')
  const entry=inventory.entries.find((row:any)=>row.moduleName==='gateway-control-fixture')
  assert(entry,JSON.stringify(inventory));assert.equal(entry.fiberPhase,'active')
  assert.equal(entry.enabled,true)
  return ctx.get('controlFixture')
}
try{
  process.env.DSH_HOME=home;process.env.DSH_TELEMETRY_DISABLED='1'
  if(process.env.DSH_HMR_RESTART_PROFILE){
    await boot()
    assert.equal(await diskVersion(),'1.0.1');assert.equal(await activeVersion(),'1.0.1')
    assert.deepEqual(await coreHashes(),originalCore)
    console.log(JSON.stringify({restartedActiveVersion:'1.0.1',pid:process.pid,maxLiveRuntimes}))
  }else{
    await mkdir(directory);await mkdir(home)
    assert.equal(JSON.parse(await readFile(req.resolve('@deepseek-ai/dsh/package.json'),'utf8')).version,'0.1.7-rc.2')
    await writeFile(join(directory,'package.json'),JSON.stringify({name:'remote-hmr-fixture-profile',private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}}))
    await writeFile(join(directory,'cordis.yml'),'[]\n');await writeFile(join(directory,'cordis.patch.yml'),'# fixture profile preserved\n[]\n')
    await boot()
    const initial=await remote('pluginManager/installBundle',{spec:'gateway-control-fixture@1.0.0'})
    assert.equal(initial.application,'applied',JSON.stringify(initial))
    assert.equal(await diskVersion(),'1.0.0');assert.equal(await activeVersion(),'1.0.0')
    const ordinaryUpdate=await remote('pluginManager/installBundle',{spec:'gateway-control-fixture@1.0.0'})
    assert.equal(ordinaryUpdate.application,'restart-required',JSON.stringify(ordinaryUpdate))
    // Remote dispatch alone does not introduce the outer HMR scope. Inject the
    // genuine public rc.2 transaction API (named runExclusive, not transaction).
    // No method replacement, fabricated result, or modifications to upstream code.
    const native=ctx.get('pluginManager')
    let failed:any
    // Adapt only the carrier: all management reads and writes reach official
    // services; installBundle is dispatched through the native Remote boundary.
    const manager:Manager={
      listPlugins:()=>native.listPlugins(),listBundles:()=>native.listBundles(),
      inspect:spec=>native.inspect(spec),registries:()=>native.registries(),
      installBundle:async(spec,options)=>{failed=await remote('pluginManager/installBundle',{spec,options});return failed},
      removeBundle:name=>native.removeBundle(name),
      setPluginEnabled:(id,enabled)=>native.setPluginEnabled(id,enabled),
      cancelInstall:id=>native.cancelInstall(id),
    }
    const management=await createManagement({stateDirectory:join(directory,'journal'),version:'0.1.7-rc.2',manager,trustedPackages:['gateway-control-fixture']})
    const managedJob:any=await ctx.get('hmr').runExclusive(async()=>{
      await management.handle('management.submit',{requestId:'remote-hmr-update',action:'plugin.install',package:'gateway-control-fixture',version:'1.0.1'})
      const deadline=Date.now()+60000
      while(Date.now()<deadline){
        const inventory:any=await management.handle('management.inventory',{})
        const job=inventory.jobs.find((candidate:any)=>candidate.id==='remote-hmr-update')
        if(job?.finishedAt)return job
        await new Promise(resolve=>setTimeout(resolve,25))
      }
      throw new Error('Native Remote management job timed out')
    })
    assert.equal(managedJob.status,'restart-required',JSON.stringify(managedJob))
    assert.equal(managedJob.diskVersion,'1.0.1')
    assert.equal(managedJob.applicationState,'active-version-unverified')
    assert.equal(managedJob.activeVersion,undefined)
    assert.equal(managedJob.rollback,undefined)
    assert.equal(managedJob.error,'operation-error')
    assert(failed,'Official Remote install must have returned a real result')
    assert.equal(failed.packageResult.exitCode,0,JSON.stringify(failed))
    assert.equal(failed.changed,true);assert.equal(failed.application,'failed')
    assert.equal(failed.error.code,'operation-error')
    assert.match(JSON.stringify(failed.error),/HMR transactions cannot be nested/)
    assert.equal(await diskVersion(),'1.0.1');assert.equal(await activeVersion(),'1.0.0')
    console.log(JSON.stringify({phase:'nested-hmr',remoteOk:true,application:failed.application,error:failed.error,packageExitCode:failed.packageResult.exitCode,diskVersion:await diskVersion(),activeVersion:await activeVersion(),outerScope:'official hmr.runExclusive',managementStatus:managedJob.status,managementApplicationState:managedJob.applicationState}))
    await stop()
    // A real process restart is necessary: same-process Cordis reboots retain
    // Node module resolution/cache state. The original Runtime is fully disposed.
    const restarted=await exec(packageManager.command,[...packageManager.args,'exec','tsx',fileURLToPath(import.meta.url)],{env:{...process.env,DSH_HMR_RESTART_PROFILE:directory,DSH_HMR_RESTART_HOME:home},timeout:60000})
    const restartEvidence=JSON.parse(restarted.stdout.trim().split('\n').at(-1)!)
    assert.equal(restartEvidence.maxLiveRuntimes,1)
    assert.equal(restartEvidence.restartedActiveVersion,'1.0.1');assert.notEqual(restartEvidence.pid,process.pid)
    assert.equal(await diskVersion(),'1.0.1')
    assert((await readFile(join(directory,'cordis.patch.yml'),'utf8')).includes('fixture profile preserved'))
    assert.deepEqual(await coreHashes(),originalCore)
    assert.equal(maxLiveRuntimes,1)
    console.log(JSON.stringify({ok:true,transport:'native Connection Fetch + Typert Remote',genuineHmr:true,outerHmrScopeRequired:true,diskVersion:'1.0.1',activeVersionAfterRestart:'1.0.1',maxLiveRuntimes,coreUnchanged:true,activeVersionEvidence:'live fixture service + pluginInventory/list active fiber'}))
  }
}finally{
  await stop();await new Promise<void>(r=>registry.close(()=>r()));await rm(work,{recursive:true,force:true})
  if(originalEnv.home===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=originalEnv.home
  if(originalEnv.telemetry===undefined)delete process.env.DSH_TELEMETRY_DISABLED;else process.env.DSH_TELEMETRY_DISABLED=originalEnv.telemetry
}
