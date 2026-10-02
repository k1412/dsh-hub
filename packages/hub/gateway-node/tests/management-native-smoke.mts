/** Two actual rc.2 plugin managers; local fixture registry, no public writes or production profiles. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
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
const app=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')).href)
const contexts:any[]=[], versions=new Map<string,Buffer>()
for(const version of ['1.0.0','1.0.1','1.0.2']) {
  const dir=join(work,version);await mkdir(dir)
  await writeFile(join(dir,'package.json'),JSON.stringify({name:'gateway-control-fixture',version,type:'module',main:'index.js',...(version==='1.0.2'?{}:{dsh:{bundle:{patch:'./cordis.patch.yml'}}})}))
  await writeFile(join(dir,'index.js'),`export const name='control-fixture';export function apply(ctx){ctx.provide('controlFixture','${version}')}`)
  await writeFile(join(dir,'cordis.patch.yml'),'- insert:\n    - id: control-fixture\n      name: gateway-control-fixture\n')
  const packed=JSON.parse((await exec('npm',['pack','--json'],{cwd:dir})).stdout)[0]
  versions.set(version,await readFile(join(dir,packed.filename)))
}
let registryUrl=''
const registry=createServer((request,response)=>{
  const match=/^\/tar\/(1\.0\.[012])\.tgz$/.exec(request.url??'')
  if(match){response.end(versions.get(match[1]!));return}
  if((request.url??'').split('?')[0]!='/gateway-control-fixture'){response.writeHead(404);response.end('{}');return}
  response.setHeader('content-type','application/json')
  response.end(JSON.stringify({name:'gateway-control-fixture','dist-tags':{latest:'1.0.1'},versions:Object.fromEntries([...versions].map(([version,data])=>[version,{name:'gateway-control-fixture',version,dsh:{bundle:{patch:'./cordis.patch.yml'}},dist:{tarball:`${registryUrl}/tar/${version}.tgz`,shasum:createHash('sha1').update(data).digest('hex')}}]))}))
})
registry.listen(0,'127.0.0.1');await once(registry,'listening');registryUrl=`http://127.0.0.1:${(registry.address() as {port:number}).port}`
const managers:Awaited<ReturnType<typeof createManagement>>[]=[]
async function job(index:number,input:Record<string,unknown>){await managers[index]!.handle('management.submit',input);const end=Date.now()+60000;while(Date.now()<end){const inv:any=await managers[index]!.handle('management.inventory',{});const found=inv.jobs.find((j:any)=>j.id===input.requestId);if(found?.status!=='running')return found;await new Promise(r=>setTimeout(r,50))}throw new Error('Native manager timed out')}
try {
  for(const label of ['A','B']){
    const directory=join(work,label),home=join(directory,'home');await mkdir(directory);await mkdir(home)
    process.env.DSH_HOME=home;process.env.DSH_TELEMETRY_DISABLED='1'
    const bundles=['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']
    await writeFile(join(directory,'package.json'),JSON.stringify({name:`fixture-profile-${label.toLowerCase()}`,private:true,dsh:{profile:{bundles}}}))
    await writeFile(join(directory,'cordis.yml'),'[]\n');await writeFile(join(directory,'cordis.patch.yml'),'# preserve this private profile comment\n[]\n')
    const overlays=[...['webserver','web-runtime','web-startup','open-in-app','client-hmr','directory-picker','session-title-llm'].map(id=>({id,disabled:true})),{id:'connection',inject:[],config:{trustedHosts:[]}},{id:'plugin-manager',config:{registry:registryUrl,fallbackRegistries:[]}}]
    const profile={name:label,dir:directory,patchPath:join(directory,'cordis.patch.yml'),installAnchor:req.resolve('@deepseek-ai/dsh/package.json'),cwd:directory,home,startedBundles:bundles,overlays,telemetryDisabledEnv:'1',packageManager:{command:process.execPath,args:[pnpm],env:{}}}
    const patches=[...app.loadOverlayPatches(label,req.resolve('@deepseek-ai/dsh-base/cordis.patch.yml')),...app.loadOverlayPatches(label,req.resolve('@deepseek-ai/dsh-web-app/cordis.patch.yml')),...app.loadOverlayPatches(label,req.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml')),...overlays]
    const loaded = app.loadProfileDirectory(label, directory, profile.installAnchor)
    const resolution = await app.createRuntimeResolution({ installAnchor: profile.installAnchor, profile: loaded, home })
    const listeners = new Set<() => void>(); let ready = false
    const ctx=await app.boot(label,join(directory,'cordis.yml'),patches,async(ctx:any)=>{
      ctx.provide('profileContext',profile)
      ctx.provide('appReady',{ onReady(listener:()=>void) { if(ready)listener();else listeners.add(listener);return()=>listeners.delete(listener) } })
      await ctx.plugin(app.PluginPackages,{resolution})
    });contexts.push(ctx)
    ready=true;for(const listener of listeners)listener();listeners.clear()
    const manager=ctx.get('pluginManager');assert(manager)
    const originalInstall=manager.installBundle.bind(manager);manager.installBundle=async(...args:any[])=>{const result=await originalInstall(...args);if(result.application==='failed')console.error('Expected fixture install refusal:',result.error?.code);return result}
    managers.push(await createManagement({stateDirectory:join(directory,'journal'),version:'0.1.7-rc.2',manager:manager as Manager,trustedPackages:['gateway-control-fixture']}))
  }
  const results=await Promise.all([job(0,{requestId:'install-A',action:'plugin.install',package:'gateway-control-fixture',version:'1.0.0'}),job(1,{requestId:'install-B',action:'plugin.install',package:'gateway-control-fixture',version:'1.0.1'})])
  assert(results.every(r=>r.status==='completed'),JSON.stringify(results))
  let a:any=await managers[0]!.handle('management.inventory',{}),b:any=await managers[1]!.handle('management.inventory',{})
  assert.equal(a.bundles.find((p:any)=>p.name==='gateway-control-fixture').version,'1.0.0');assert.equal(b.bundles.find((p:any)=>p.name==='gateway-control-fixture').version,'1.0.1')
  const entry=a.plugins.find((p:any)=>p.moduleName==='gateway-control-fixture');assert(entry)
  assert.equal((await job(0,{requestId:'disable-A',action:'plugin.disable',target:entry.entryId})).status,'completed')
  assert.equal((await job(0,{requestId:'enable-A',action:'plugin.enable',target:entry.entryId})).status,'completed')
  assert.equal((await job(0,{requestId:'update-A',action:'plugin.install',package:'gateway-control-fixture',version:'1.0.1'})).status,'completed')
  const failed=await job(0,{requestId:'failed-update-A',action:'plugin.install',package:'gateway-control-fixture',version:'1.0.2'})
  assert.equal(failed.status,'failed');assert.equal(failed.rollback,'restored-previous-version')
  assert.equal(JSON.parse(await readFile(join(work,'A/package.json'),'utf8')).dependencies['gateway-control-fixture'],'1.0.1')
  assert.equal((await job(0,{requestId:'remove-A',action:'plugin.remove',target:'gateway-control-fixture'})).status,'completed')
  a=await managers[0]!.handle('management.inventory',{});b=await managers[1]!.handle('management.inventory',{})
  assert(!a.bundles.some((p:any)=>p.name==='gateway-control-fixture'));assert(b.bundles.some((p:any)=>p.name==='gateway-control-fixture'))
  assert((await readFile(join(work,'A/cordis.patch.yml'),'utf8')).includes('preserve this private profile comment'))
  console.log(JSON.stringify({ok:true,realPluginManagers:2,registry:'local fixture',parallelInstall:true,versionIsolation:true,enableDisable:true,update:true,failedUpdateRollback:true,removeIsolation:true,preservedYaml:true}))
}finally{for(const ctx of contexts)await ctx.fiber.dispose();await new Promise<void>(r=>registry.close(()=>r()));await rm(work,{recursive:true,force:true})}
