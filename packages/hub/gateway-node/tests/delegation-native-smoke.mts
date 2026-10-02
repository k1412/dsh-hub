/** DSH_NATIVE_ROOT=<installed rc.2 tree> pnpm exec tsx <this file>. No network/model credentials needed. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDelegation, type DelegationContext } from '../src/delegation.ts'

const installed = process.env.DSH_NATIVE_ROOT
if (!installed) throw new Error('Set DSH_NATIVE_ROOT to an installed DSH 0.1.7-rc.2 package tree')
const work = await mkdtemp(join(tmpdir(), 'dsh-delegation-native-'))
process.env.DSH_HOME = join(work, 'home')
process.env.DSH_TELEMETRY_DISABLED = '1'
const require = createRequire(join(installed, 'package.json'))
const load = async (name: string) => import(pathToFileURL(require.resolve(name)).href)
const app = await load('@deepseek-ai/dsh-app-boot')
await writeFile(join(work, 'cordis.yml'), '[]\n')
await symlink(join(installed, 'node_modules'), join(work, 'node_modules'))
const patches = [
  ...app.loadOverlayPatches('delegation-smoke', require.resolve('@deepseek-ai/dsh-base/cordis.patch.yml')),
  ...app.loadOverlayPatches('delegation-smoke', require.resolve('@deepseek-ai/dsh-web-app/cordis.patch.yml')),
  ...app.loadOverlayPatches('delegation-smoke', require.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml')),
  { id: 'webserver', disabled: true }, { id: 'web-runtime', disabled: true }, { id: 'web-startup', disabled: true },
  { id: 'open-in-app', disabled: true }, { id: 'client-hmr', disabled: true },
  { id: 'connection', inject: [], config: { trustedHosts: [] } },
  { id: 'directory-picker', disabled: true },
  { id: 'session-title-llm', disabled: true },
  { id: 'agent-default-model', config: { provider: 'delegation-fixture', model: 'target-model' } },
]
const ctx = await app.boot('delegation-smoke', join(work, 'cordis.yml'), patches, undefined, pathToFileURL(join(installed, 'package.json')).href)
const { LlmAdapter } = await load('@deepseek-ai/dsh-llm')
let modelCalls = 0
let slow = false
let cancellationObserved = false
class FixtureAdapter extends LlmAdapter {
  providerInfo(provider: string) { return { id: provider, name: 'Delegation fixture' } }
  async listModels(provider: string) { return [{ provider, id: 'target-model', name: 'Target fixture model' }] }
  async *stream(request: any) {
    modelCalls++
    assert.equal(request.model, 'target-model')
    if (slow) {
      await new Promise<void>((resolve) => {
        const aborted = () => { cancellationObserved = true; resolve() }
        if (request.signal.aborted) aborted()
        else request.signal.addEventListener('abort', aborted, { once: true })
      })
      request.signal.throwIfAborted()
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Native target result' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Native target result' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
ctx.llm.registerAdapter(['delegation-fixture'], new FixtureAdapter())
assert.equal(ctx.agentDefaultModel.currentSelection().model, 'target-model')
assert.equal(ctx.webServer, undefined)
const calls: { method: string; input: Record<string, unknown> }[] = []
const delegation = await createDelegation(ctx as DelegationContext, { stateDirectory: join(work, 'state'), workspace: work, runtimeId: 'target-runtime', call: async (method, input) => { calls.push({ method, input }); return { peers: [] } } })
const owner = { sourceNode: 'source-node', sourceRuntime: 'source-runtime', sourceSession: 'source-session', targetRuntime: 'target-runtime', workspace: work, requestId: 'native-1' }
async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const value = await read(); if (done(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Native delegation smoke timed out')
}
let source: any
try {
  source = await ctx.agents.create({ sessionId: 'native-source-session', meta: { cwd: work } })
  const exec = (name: string, args: unknown, agent = source.agent) => ctx.tools.execute({ name, arguments: args, agent, callId: `call-${Math.random()}`, signal: new AbortController().signal })
  const discover = await exec('peer_discover', {})
  assert.equal(discover.isError, false, JSON.stringify(discover))
  assert.equal(calls[0]!.input.sourceSession, source.agent.id)
  const forged = await exec('peer_discover', { sourceSession: 'forged' })
  assert.equal(forged.isError, true)
  const started: any = await delegation.handle('task.start', { ...owner, authorizationLeaseMs: 30_000, prompt: 'Reply with Native target result' })
  const finished: any = await poll(() => delegation.handle('task.read', { ...owner, taskId: started.taskId }), (result: any) => result.status !== 'running' && result.status !== 'starting')
  assert.equal(finished.status, 'completed', JSON.stringify(finished))
  assert.equal(finished.result, 'Native target result')
  assert.equal(modelCalls, 1)
  const duplicate: any = await delegation.handle('task.start', { ...owner, authorizationLeaseMs: 30_000, prompt: 'Reply with Native target result' })
  assert.equal(duplicate.taskId, started.taskId); assert.equal(modelCalls, 1)
  slow = true
  const cancelling: any = await delegation.handle('task.start', { ...owner, authorizationLeaseMs: 30_000, requestId: 'native-2', prompt: 'Wait for cancellation' })
  await poll(async () => modelCalls, (count) => count === 2)
  // Find the actual delegated native agent through the registry, not a fabricated tool context.
  const agents = ctx.agents.list()
  const delegated = agents.find((agent: any) => agent.session.header.origin === 'subagent')
  assert(delegated)
  const recursive = await exec('peer_discover', {}, delegated)
  assert.equal(recursive.isError, true)
  await delegation.handle('task.cancel', { ...owner, taskId: cancelling.taskId })
  const cancelled: any = await poll(() => delegation.handle('task.read', { ...owner, taskId: cancelling.taskId }), (result: any) => result.status === 'cancelled')
  assert.equal(cancelled.status, 'cancelled'); assert(cancellationObserved)
  console.log(JSON.stringify({ ok: true, realNativeTools: true, targetModel: true, actualResult: true, idempotency: true, cancellation: true, recursionDenied: true, webListener: false }))
} finally {
  await delegation.close()
  await source?.dispose()
  await ctx.fiber.dispose()
  await rm(work, { recursive: true, force: true })
}
