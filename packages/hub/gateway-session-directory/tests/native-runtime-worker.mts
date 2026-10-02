/** Real published Runtime fixture; only network overlay and model inference are local fixtures. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdir, writeFile, appendFile, symlink, cp, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const installed = process.env.DSH_NATIVE_ROOT
if (!installed) throw new Error('DSH_NATIVE_ROOT required')
const work = process.env.DSH_TEST_WORK as string, label = process.env.DSH_TEST_LABEL as string
process.env.DSH_HOME = join(work, 'home'); process.env.DSH_TELEMETRY_DISABLED = '1'
const require = createRequire(join(installed, 'package.json'))
const load = async (name: string) => import(pathToFileURL(require.resolve(name)).href)
await mkdir(join(work, 'node_modules/@k1412'), { recursive: true })
await symlink(join(installed, 'node_modules/@deepseek-ai'), join(work, 'node_modules/@deepseek-ai'))
const pkg = join(work, 'node_modules/@k1412/dsh-gateway-node')
await cp(resolve('dist/gateway/node-package'), pkg, { recursive: true })
// The real shipped browser module is unmodified. This fixture replaces only the
// host connector bootstrap because serveSurface below owns the local test carrier.
await rename(join(pkg, 'lib/index.js'), join(pkg, 'lib/actual.js'))
await symlink(join(installed, 'node_modules/ws'), join(work, 'node_modules/ws'))
const fixtureTransport = pathToFileURL(resolve('packages/hub/gateway-transport/src/index.ts')).href
await writeFile(join(pkg, 'lib/index.js'), `
import { activateGateway } from './actual.js';
export { inject, Config } from './actual.js';
import WebSocket from 'ws';
import { serveSurface } from '${fixtureTransport}';
export async function apply(ctx, config) {
  return activateGateway(ctx, config, ({config,surface,metadata}) => {
    let socket, serving;
    const connect = async () => {
      socket = new WebSocket(config.endpoint, {headers:{authorization:'Bearer '+config.credential,'x-dsh-runtime':metadata.runtimeId,'x-dsh-version':metadata.dshVersion,'x-dsh-session-directory':metadata.sessionDirectory?'1':'0'}});
      await new Promise((ok,fail)=>{socket.once('open',ok);socket.once('error',fail)});
      serving = serveSurface(socket,surface);
    };
    const close = async () => {serving?.close();socket?.terminate()};
    const ready = connect();
    (globalThis.__gatewayFixtureConnections ??= new Map()).set(config.nodeId,{ready,connect,close});
    return {close};
  });
}
`)
const connections = JSON.parse(process.env.DSH_TEST_CONNECTIONS as string) as Array<{id:string;url:string;credential:string}>
for (const [index, config] of connections.entries()) await writeFile(join(work, `connection-${index}.json`), JSON.stringify({
  protocol:1, nodeId:config.id, credential:config.credential, clientId:`fixture-${index}`, name:label,
  mode:'tailcat', endpoint:config.url, stateDir:work, hubUrl:'http://hub.localhost',
}), {mode:0o600})
await writeFile(join(work, 'package.json'), '{"type":"module"}')
await writeFile(join(work, 'cordis.yml'), '[]\n')
const app = await load('@deepseek-ai/dsh-app-boot')
const patches = [
  ...app.loadOverlayPatches('directory-smoke', require.resolve('@deepseek-ai/dsh-base/cordis.patch.yml')),
  ...app.loadOverlayPatches('directory-smoke', require.resolve('@deepseek-ai/dsh-web-app/cordis.patch.yml')),
  ...app.loadOverlayPatches('directory-smoke', require.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml')),
  ...['webserver', 'web-runtime', 'web-startup', 'open-in-app', 'client-hmr', 'directory-picker'].map(id => ({ id, disabled: true })),
  { id: 'connection', inject: [], config: { trustedHosts: [] } },
  { insert: [ { id: 'browse-host', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
    { id: 'browse-client', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
    ...connections.map((_config,index) => ({ id: `gateway-${index}`, name: '@k1412/dsh-gateway-node', config: { connectionFile: join(work, `connection-${index}.json`), runtimeId: `runtime-${label}`, sessionDirectory: index === 0 } })) ] },
]
const ctx = await app.boot('directory-smoke', join(work, 'cordis.yml'), patches, undefined, pathToFileURL(join(work, 'package.json')).href)
const { LlmAdapter } = await load('@deepseek-ai/dsh-llm')
class FixtureAdapter extends LlmAdapter {
  providerInfo(provider: string) { return { id: provider, name: 'Directory fixture' } }
  async listModels(provider: string) { return [{ provider, id: 'fixture-a', name: 'Fixture model A' }] }
  async *stream() {
    const text = `Native historical reply ${label}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
ctx.llm.registerAdapter(['directory-fixture'], new FixtureAdapter())
if (ctx.webServer) throw new Error('Native Web listener unexpectedly active')
const workspace = await ctx.workspaceController.create({ path: work })
const created = await ctx.sessionController.create({ workspaceId: workspace.workspace.workspaceId, sessionId: 'directory-shared-session' })
await ctx.sessionController.rename({ sessionId: created.sessionId, title: `Directory target ${label}` })
const handles = (globalThis as unknown as { __gatewayFixtureConnections: Map<string, {ready:Promise<void>;connect():Promise<void>;close():Promise<void>}> }).__gatewayFixtureConnections
if (!handles || handles.size !== 2) throw new Error('Both named Gateway plugin instances must activate inside one Runtime')
await Promise.all([...handles.values()].map(h => h.ready))
const graphIds = ctx.clientModules.graph().entries.map((entry: {id:string}) => entry.id)
if (new Set(graphIds).size !== graphIds.length) throw new Error('Named host instances must not duplicate browser module registrations')
if (graphIds.filter((id: string) => id === '@k1412/dsh-gateway-node').length !== 1) throw new Error('Exactly one navigation client must serve both named instances')
const experimental = handles.get(connections[0]!.id)!
process.send?.({ ready: true, entries: ctx.clientModules.graph().entries.length, plugin: ctx.clientModules.graph().entries.some((e: {id:string})=>e.id === '@k1412/dsh-gateway-node'), sessionId: created.sessionId })
process.on('message', (message: { command: string }) => { void (async () => {
  if (message.command === 'disconnect') { await experimental.close(); process.send?.({ disconnected: true }) }
  if (message.command === 'reconnect') { await experimental.connect(); process.send?.({ reconnected: true }) }
  if (message.command === 'rebuilt') { await appendFile(join(pkg, 'lib/client.js'), '\n// isolated fixture artifact rebuild\n'); ctx.clientModules.rebuilt('@k1412/dsh-gateway-node'); process.send?.({ rebuilt: true }) }
  if (message.command === 'stop') { await ctx.fiber.dispose(); process.exit(0) }
})().catch(() => { process.send?.({ error: true }) }) })
