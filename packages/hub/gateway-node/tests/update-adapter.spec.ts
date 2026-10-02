import { it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readlink, symlink, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec=promisify(execFile)
it('stages npm releases, preserves rollback, verifies approved versions and idempotency', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'update-adapter-'))
  try {
    await mkdir(join(dir,'old'));await symlink(join(dir,'old'),join(dir,'current'))
    const npm=join(dir,'npm.mjs')
    await writeFile(npm,`import{mkdir,writeFile}from'node:fs/promises';import{join}from'node:path';const a=process.argv.slice(2),p=a[a.indexOf('--prefix')+1];await mkdir(join(p,'node_modules/@deepseek-ai/dsh'),{recursive:true});await writeFile(join(p,'node_modules/@deepseek-ai/dsh/package.json'),JSON.stringify({version:a.at(-1).split('@').at(-1)}));`)
    const config={kind:'npm',stateDirectory:join(dir,'state'),approvedVersions:['0.1.7-rc.2','0.1.8'],releases:join(dir,'releases'),current:join(dir,'current'),npm:[process.execPath,npm],restart:[process.execPath,'-e','process.exit(0)'],verify:[process.execPath,'-e','process.exit(0)']}
    const path=join(dir,'config.json');await writeFile(path,JSON.stringify(config))
    const run=(version:string,id:string)=>exec(process.execPath,[resolve('deploy/gateway/update-adapter.mjs'),'apply',version,id],{env:{...process.env,DSH_UPDATE_CONFIG:path}})
    await run('0.1.7-rc.2','request-1');const first=await readlink(config.current);expect(first).toContain('0.1.7-rc.2-request-1')
    await run('0.1.7-rc.2','request-1');expect(await readlink(config.current)).toBe(first)
    await expect(run('9.9.9','untrusted')).rejects.toThrow()
    config.verify=[process.execPath,'-e',"process.exit(process.argv[1] === 'current' ? 0 : 1)"];await writeFile(path,JSON.stringify(config))
    await expect(run('0.1.8','request-2')).rejects.toThrow();expect(await readlink(config.current)).toBe(first)
    expect(JSON.parse(await readFile(join(dir,'state/request-2.json'),'utf8')).status).toBe('rolled-back')
    await expect(run('0.1.8','request-1')).rejects.toThrow();expect(JSON.parse(await readFile(join(dir,'state/request-1.json'),'utf8')).status).toBe('completed')
  } finally {await rm(dir,{recursive:true,force:true})}
})
it('uses configured deployment commands for Docker and never npm',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'docker-adapter-'))
  try{
    const log=join(dir,'events'),script=join(dir,'executor.mjs');await writeFile(script,`import{appendFile}from'node:fs/promises';await appendFile(process.argv[2],process.argv.slice(3).join(' ')+ '\\n');if(process.argv[3]==='verify')process.exit(1);`)
    const command=(name:string)=>[process.execPath,script,log,name]
    const config={kind:'docker',stateDirectory:join(dir,'state'),approvedVersions:['0.1.8'],prepare:command('prepare'),apply:command('apply'),verify:command('verify'),rollback:command('rollback')}
    const path=join(dir,'config');await writeFile(path,JSON.stringify(config))
    await expect(exec(process.execPath,[resolve('deploy/gateway/update-adapter.mjs'),'apply','0.1.8','docker-123'],{env:{...process.env,DSH_UPDATE_CONFIG:path}})).rejects.toThrow()
    expect((await readFile(log,'utf8')).split('\n').slice(0,4)).toEqual(['prepare 0.1.8 docker-123','apply 0.1.8 docker-123','verify 0.1.8','rollback 0.1.8 docker-123'])
  }finally{await rm(dir,{recursive:true,force:true})}
})
it('requires explicit lifecycle approval and invokes only deployment-owned start/stop/uninstall commands',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lifecycle-adapter-'))
  try{
    const log=join(dir,'events'),script=join(dir,'executor.mjs');await writeFile(script,`import{appendFile}from'node:fs/promises';await appendFile(process.argv[2],process.argv.slice(3).join(' ')+ '\\n');if(process.argv[3]==='verify')console.log(JSON.stringify({version:'0.1.7-rc.2'}));`)
    const command=(name:string)=>[process.execPath,script,log,name]
    const config={kind:'docker',stateDirectory:join(dir,'state'),approvedActions:['start','stop','uninstall'],start:command('start'),stop:command('stop'),uninstall:command('uninstall'),verify:command('verify')}
    const path=join(dir,'config');await writeFile(path,JSON.stringify(config))
    const run=(action:string)=>exec(process.execPath,[resolve('deploy/gateway/update-adapter.mjs'),action,'current',`${action}-123456`],{env:{...process.env,DSH_UPDATE_CONFIG:path}})
    await run('start');await run('start');await run('stop');await run('uninstall')
    expect((await readFile(log,'utf8')).trim().split('\n')).toEqual(['start current start-123456','verify current','stop current stop-123456','uninstall current uninstall-123456'])
    config.approvedActions=[];await writeFile(path,JSON.stringify(config));await expect(run('start')).rejects.toThrow()
  }finally{await rm(dir,{recursive:true,force:true})}
})
it('installs an absent npm release once and refuses replacing an existing install without stopping it',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'initial-install-'))
  try{
    const script=join(dir,'npm.mjs');await writeFile(script,`import{mkdir,writeFile}from'node:fs/promises';import{join}from'node:path';const a=process.argv.slice(2),p=a[a.indexOf('--prefix')+1];await mkdir(join(p,'node_modules/@deepseek-ai/dsh'),{recursive:true});await writeFile(join(p,'node_modules/@deepseek-ai/dsh/package.json'),JSON.stringify({version:'0.1.7-rc.2'}));`)
    const config={kind:'npm',stateDirectory:join(dir,'state'),approvedVersions:['0.1.7-rc.2'],approvedActions:['install'],releases:join(dir,'releases'),current:join(dir,'current'),npm:[process.execPath,script],start:[process.execPath,'-e','process.exit(0)'],verify:[process.execPath,'-e','process.exit(0)'],stop:[process.execPath,'-e','process.exit(99)']}
    const path=join(dir,'config');await writeFile(path,JSON.stringify(config))
    const run=(id:string)=>exec(process.execPath,[resolve('deploy/gateway/update-adapter.mjs'),'install','0.1.7-rc.2',id],{env:{...process.env,DSH_UPDATE_CONFIG:path}})
    await run('install-123');const installed=await readlink(config.current);await run('install-123')
    await expect(run('install-456')).rejects.toThrow();expect(await readlink(config.current)).toBe(installed)
    expect(JSON.parse(await readFile(join(dir,'state/install-456.json'),'utf8')).status).toBe('failed')
  }finally{await rm(dir,{recursive:true,force:true})}
})
it.each([false,true])('reports Docker first-install verification failure honestly (cleanup configured: %s)',async(cleanup)=>{
  const dir=await mkdtemp(join(tmpdir(),'docker-initial-'))
  try{
    const log=join(dir,'events'),script=join(dir,'executor.mjs');await writeFile(script,`import{appendFile}from'node:fs/promises';await appendFile(process.argv[2],process.argv[3]+'\n');if(process.argv[3]==='verify')process.exit(1);`.replace("+'\n'","+'\\n'"))
    const command=(name:string)=>[process.execPath,script,log,name]
    const config={kind:'docker',stateDirectory:join(dir,'state'),approvedVersions:['0.1.8'],approvedActions:['install'],prepare:command('prepare'),install:command('install'),verify:command('verify'),...(cleanup?{cleanup:command('cleanup')}:{})}
    const path=join(dir,'config');await writeFile(path,JSON.stringify(config))
    await expect(exec(process.execPath,[resolve('deploy/gateway/update-adapter.mjs'),'install','0.1.8','first-install'],{env:{...process.env,DSH_UPDATE_CONFIG:path}})).rejects.toThrow()
    expect((await readFile(log,'utf8')).trim().split('\n')).toEqual(['prepare','install','verify',...(cleanup?['cleanup']:[])])
    expect(JSON.parse(await readFile(join(dir,'state/first-install.json'),'utf8')).status).toBe(cleanup?'cleaned-up':'manual-recovery-required')
    if(!cleanup)expect(JSON.parse(await readFile(join(dir,'state/update.lock/owner.json'),'utf8')).descendantsRequireReconciliation).toBe(true)
  }finally{await rm(dir,{recursive:true,force:true})}
})
it('retains its lock after child timeout and does not rollback concurrently with a possible orphan',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'adapter-timeout-'))
  try{
    const log=join(dir,'events'),script=join(dir,'executor.mjs')
    await writeFile(script,`import{appendFile}from'node:fs/promises';import{spawn}from'node:child_process';await appendFile(process.argv[2],process.argv[3]+'\\n');if(process.argv[3]==='apply'){spawn(process.execPath,['-e','setTimeout(()=>{},300)'],{stdio:'ignore'}).unref();setTimeout(()=>{},5000)}`)
    const command=(name:string)=>[process.execPath,script,log,name]
    const config={kind:'docker',commandTimeoutMs:150,stateDirectory:join(dir,'state'),approvedVersions:['0.1.8'],prepare:command('prepare'),apply:command('apply'),verify:command('verify'),rollback:command('rollback')}
    const path=join(dir,'config');await writeFile(path,JSON.stringify(config))
    await expect(exec(process.execPath,[resolve('deploy/gateway/update-adapter.mjs'),'apply','0.1.8','timeout-test'],{env:{...process.env,DSH_UPDATE_CONFIG:path}})).rejects.toThrow()
    expect(JSON.parse(await readFile(join(dir,'state/timeout-test.json'),'utf8')).status).toBe('manual-recovery-required')
    expect(await readFile(log,'utf8')).not.toContain('rollback')
    expect(await readFile(join(dir,'state/update.lock/owner.json'),'utf8')).toContain('descendantsRequireReconciliation')
    await new Promise(r=>setTimeout(r,400))
  }finally{await rm(dir,{recursive:true,force:true})}
})
it('checks actual available versions and refuses a successful command reporting the wrong installed Docker version',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'adapter-versions-'))
  try{
    const command=(version:string)=>[process.execPath,'-e',`console.log(JSON.stringify({version:${JSON.stringify(version)}}))`]
    const config={kind:'docker',stateDirectory:join(dir,'state'),approvedVersions:['0.1.8'],check:command('0.1.7'),prepare:command('0.1.8'),apply:command('0.1.8'),verify:command('0.1.7'),rollback:command('0.1.7')}
    const path=join(dir,'config');await writeFile(path,JSON.stringify(config))
    const run=(action:string,id:string)=>exec(process.execPath,[resolve('deploy/gateway/update-adapter.mjs'),action,'0.1.8',id],{env:{...process.env,DSH_UPDATE_CONFIG:path}})
    await expect(run('check','check-version')).rejects.toThrow()
    config.check=command('0.1.8');await writeFile(path,JSON.stringify(config))
    expect(JSON.parse((await run('check','check-version')).stdout)).toMatchObject({availableVersion:'0.1.8'})
    await expect(run('apply','wrong-version')).rejects.toThrow()
    expect(JSON.parse(await readFile(join(dir,'state/wrong-version.json'),'utf8')).status).toBe('rolled-back')
  }finally{await rm(dir,{recursive:true,force:true})}
})
