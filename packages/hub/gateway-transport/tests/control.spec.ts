import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { performance } from 'node:perf_hooks'
import WebSocket, { WebSocketServer } from 'ws'
import { it, expect } from 'vitest'
import { GatewayTunnel, serveSurface, ControlRPC } from '../src/index.ts'
it('runs bounded bidirectional control alongside native traffic on two node carriers', async () => {
  const server = createServer(), sockets = new WebSocketServer({ server })
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  const port = (server.address() as {port:number}).port
  const clients: WebSocket[] = [], controls: ControlRPC[] = [], tunnels: GatewayTunnel[] = []
  let index = 0
  sockets.on('connection', ws => { const id = index++; const tunnel = new GatewayTunnel(ws,{control:true}); tunnels.push(tunnel); controls.push(new ControlRPC(ws,async()=>({hub:id}))) })
  const timing: number[] = [], rounds = Number(process.env.CONTROL_SOAK_ROUNDS ?? 100)
  const initialRss = process.memoryUsage().rss
  let maxRss = initialRss
  try {
    for (let i=0;i<2;i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`); clients.push(ws)
      await new Promise<void>(r=>ws.once('open',r))
      serveSurface(ws,{handle:async()=>new Response(`node-${i}`),openMux:()=>({receive(){},close(){}})},{control:true})
      const rpc = new ControlRPC(ws,async(_method,input)=>({node:i,value:input.value}))
      expect(await rpc.call('discover',{})).toEqual({hub:i})
    }
    for (let n=0;n<rounds;n++) {
      const start = performance.now()
      const result = await Promise.all(controls.map((rpc,i)=>rpc.call('echo',{value:`${i}-${n}`})))
      expect(result).toEqual([{node:0,value:`0-${n}`},{node:1,value:`1-${n}`}])
      expect(await Promise.all(tunnels.map(async t=>(await t.fetch(new Request('http://native/'))).text()))).toEqual(['node-0','node-1'])
      timing.push(performance.now()-start)
      maxRss = Math.max(maxRss, process.memoryUsage().rss)
      if (process.env.CONTROL_SOAK_ROUNDS) await new Promise(r => setTimeout(r, 5))
    }
    timing.sort((a,b)=>a-b)
    const report = {controlBenchmark:{rounds,nodeCalls:rounds*2,p50Ms:timing[Math.floor(rounds*.5)],p95Ms:timing[Math.floor(rounds*.95)],initialRss,maxRss,finalRss:process.memoryUsage().rss,health:controls.map(c=>c.health),errors:0,network:'loopback fixture'}}
    if (process.env.CONTROL_BENCHMARK_REPORT) await writeFile(process.env.CONTROL_BENCHMARK_REPORT, JSON.stringify(report, null, 2))
    console.info(JSON.stringify(report))
    expect(tunnels.map(t=>t.health.inflightRequests)).toEqual([0,0])
  } finally { for(const c of controls)c.close(); for(const c of clients)c.terminate(); for(const t of tunnels)t.close(); await new Promise<void>(r=>sockets.close(()=>r())); await new Promise<void>(r=>server.close(()=>r())) }
}, 90000)
