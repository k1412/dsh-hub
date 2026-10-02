import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { generateHubIpcSecret, type HubIpcFrame } from '@k1412/dsh-hub-node-ipc'
import { HubConnectorServer } from '../../hub-node-agent/src/ipc-server.ts'
import type { HubEnvelopeBody } from '@k1412/dsh-hub-protocol'
import { detectDshVersion, HubConnector, normalizeEventFrame } from '../src/index.ts'
import * as HubConnectorPlugin from '../src/index.ts'
import type { SessionLifecycle } from '../src/session-lifecycle.ts'

const roots: string[] = []
const servers: HubConnectorServer[] = []
const contexts: Context[] = []

type TestApiProxy = {
  sessions?: Record<string, (...args: unknown[]) => Promise<unknown>>
  settings?: Record<string, (...args: unknown[]) => Promise<unknown>>
  host?: Record<string, (...args: unknown[]) => Promise<unknown>>
  workspace?: Record<string, (...args: unknown[]) => Promise<unknown>>
  events?: Record<string, (...args: unknown[]) => AsyncIterable<unknown>>
  respond?: (...args: unknown[]) => Promise<unknown>
}

type TestGateway = {
  dispatch?: (...args: unknown[]) => Promise<unknown>
  dispatchRpc?: (...args: unknown[]) => Promise<unknown>
  invoke?: (...args: unknown[]) => Promise<unknown>
  stream?: (...args: unknown[]) => Promise<AsyncIterable<unknown>>
  wireStream?: { open: (...args: unknown[]) => Promise<AsyncIterable<unknown>> }
}

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.allSettled(servers.splice(0).map(server => server.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function* idle(signal: AbortSignal): AsyncGenerator<never> {
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

function testGateway(): TestGateway {
  return {
    invoke: async () => { throw new Error('unexpected test Gateway invocation') },
    dispatch: async () => ({
      ok: false,
      error: { code: 'internal', message: 'test Gateway has no Remote endpoints', details: {} },
    }),
  }
}

describe('Hub Connector coexistence', () => {
  it('waits for late legacy ApiProxy activation instead of reconnecting through unowned Remote endpoints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hub-delayed-legacy-')); roots.push(root)
    const secretFile = join(root, 'connector.secret'); const endpoint = join(root, 'agent.sock')
    const secret = generateHubIpcSecret(); await writeFile(secretFile, `${secret}\n`, { mode: 0o600 })
    let connected = 0; let disconnected = 0; const bodies: HubEnvelopeBody[] = []
    const server = new HubConnectorServer(endpoint, secret, 'delayed-legacy-agent', {
      connected: () => { connected += 1 }, body: (_runtime, body) => { bodies.push(body) }, disconnected: () => { disconnected += 1 },
    }); servers.push(server); await server.listen()
    const context = new Context(); contexts.push(context)
    const invoke = vi.fn(async () => { throw new Error('legacy Remote endpoint is unowned') })
    context.provide('typertGateway', { invoke })
    await context.plugin(HubConnectorPlugin, { ipcEndpoint: endpoint, secretFile, runtimeId: 'legacy-runtime',
      dshVersion: '0.1.0-rc.6', reconnectMaximumMs: 1_000 })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(connected).toBe(0); expect(invoke).not.toHaveBeenCalled()
    context.provide('apiProxy', { sessions: { list: async (request: { rpcId: string }) => ({ rpcId: request.rpcId, result: { ok: true, value: { items: [] } } }) },
      events: { mux: (_request: unknown, signal: AbortSignal) => idle(signal), host: (_request: unknown, signal: AbortSignal) => idle(signal) },
    } as never)
    await vi.waitFor(() => { expect(bodies.some(body => body.type === 'stream.frame' && body.stream === 'index')).toBe(true) })
    expect(server.baselines()[0]?.dshVersion).toBe('0.1.0-rc.6')
    expect(connected).toBe(1); expect(disconnected).toBe(0); expect(invoke).not.toHaveBeenCalled()
  })

  it('backs off after clean EOF caused by a failed startup baseline instead of flooding Runtime notifications', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hub-eof-backoff-')); roots.push(root)
    const secretFile = join(root, 'connector.secret'); const endpoint = join(root, 'agent.sock')
    const secret = generateHubIpcSecret(); await writeFile(secretFile, `${secret}\n`, { mode: 0o600 })
    let attempts = 0
    const server = new HubConnectorServer(endpoint, secret, 'eof-backoff-agent', {
      connected: () => { attempts += 1 }, body: () => undefined, disconnected: () => undefined,
    }); servers.push(server); await server.listen()
    const connector = new HubConnector({ sessions: { list: async () => { throw new Error('temporary storage initialization failure') } },
      events: { mux: (_request, signal) => idle(signal), host: (_request, signal) => idle(signal) },
    }, testGateway(), { ipcEndpoint: endpoint, secretFile, runtimeId: 'eof-runtime', dshVersion: '0.1.0-rc.6', reconnectMaximumMs: 1_000 })
    const controller = new AbortController(); const task = connector.run(controller.signal)
    try {
      await vi.waitFor(() => { expect(attempts).toBe(1) })
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(attempts).toBe(1)
    } finally { controller.abort(); await task.catch(() => undefined) }
  })
  it('reads current Workspace follow baselines for concurrent nodes and releases both generations', async () => {
    const closed: string[] = []
    const targets = ['node-a', 'node-b'].map(owner => {
      const value = { items: [{ workspaceId: 'shared-workspace', path: `/${owner}`, sessionIds: [] }], archivedSessionIds: [], pinnedSessionIds: [] }
      const connector = new HubConnector(undefined, { stream: async ({ namespace, method, args, signal }) => {
        expect({ namespace, method, args }).toEqual({ namespace: 'workspace', method: 'follow', args: {} })
        return (async function* () { try { yield { type: 'baseline', value }; throw new Error('a unary read must not follow updates') }
          finally { expect(signal?.aborted).toBe(true); closed.push(owner) } })()
      } }, { ipcEndpoint: '/unused', secretFile: '/unused', runtimeId: owner, dshVersion: '0.1.7-rc.2', reconnectMaximumMs: 1_000 })
      return { value, bridge: connector as unknown as { webRemote(endpoint: string, payload: unknown): Promise<unknown> } }
    })
    for (const endpoint of ['workspace.list', 'workspace/list']) {
      const results = await Promise.all(targets.map(target => target.bridge.webRemote(endpoint, endpoint.includes('/') ? { args: {} } : {})))
      expect(results).toEqual(targets.map(target => target.value))
    }
    expect(closed).toEqual(['node-a', 'node-b', 'node-a', 'node-b'])
    const native = vi.fn(async () => ({ result: { ok: true, value: targets[0]?.value } }))
    const stream = vi.fn(async () => { throw new Error('legacy must keep the native list') })
    const legacy = new HubConnector({ workspace: { list: native } }, { stream }, { ipcEndpoint: '/unused', secretFile: '/unused',
      runtimeId: 'legacy', dshVersion: '0.1.0-rc.6', reconnectMaximumMs: 1_000 }) as unknown as { webRemote(endpoint: string, payload: unknown): Promise<unknown> }
    await expect(legacy.webRemote('workspace.list', {})).resolves.toEqual(targets[0]?.value)
    expect(stream).not.toHaveBeenCalled()
  })

  it('loads and paginates pinned histories through current pages with an observed cursor on simultaneous nodes', async () => {
    const targets = ['node-a', 'node-b'].map(owner => {
      const projections = { asOfSeq: 7, values: { owner } }
      const invoke = vi.fn(async ({ namespace, method, args }: { namespace: string; method: string; args: Record<string, unknown> }) => {
        expect(namespace).toBe('session')
        if (method === 'projections') { expect(args).toEqual({ request: { sessionId: 'shared-session' } }); return projections }
        expect(method).toBe('page')
        const request = args.request as { throughSeq: number; beforeSeq?: number; maxMessages?: number }
        expect(request).toMatchObject({ address: { kind: 'session', sessionId: 'shared-session' }, throughSeq: 7, maxMessages: 2 })
        return { records: [{ type: 'event', event: { type: 'user/message', seq: request.beforeSeq === undefined ? 7 : 1, data: { owner } } }],
          hasMore: request.beforeSeq === undefined }
      })
      const connector = new HubConnector(undefined, { invoke }, { ipcEndpoint: '/unused', secretFile: '/unused',
        runtimeId: owner, dshVersion: '0.1.7-rc.2', reconnectMaximumMs: 1_000 })
      return { owner, projections, bridge: connector as unknown as { webRemote(endpoint: string, payload: unknown): Promise<unknown> } }
    })
    for (const endpoint of ['session.history', 'session/history']) {
      const tail = await Promise.all(targets.map(target => target.bridge.webRemote(endpoint, endpoint.includes('/')
        ? { args: { request: { sessionId: 'shared-session', maxMessages: 2 } } } : { sessionId: 'shared-session', maxMessages: 2 })))
      tail.forEach((value, index) => { expect(value).toEqual({ events: [{ event: { type: 'user/message', seq: 7, data: { owner: targets[index]?.owner } } }],
        hasMore: true, projections: targets[index]?.projections }) })
      const older = await targets[0]?.bridge.webRemote(endpoint, endpoint.includes('/')
        ? { args: { request: { sessionId: 'shared-session', beforeSeq: 7, maxMessages: 2 } } }
        : { sessionId: 'shared-session', beforeSeq: 7, maxMessages: 2 })
      expect(older).toEqual({ events: [{ event: { type: 'user/message', seq: 1, data: { owner: 'node-a' } } }], hasMore: false })
    }
  })

  it('keeps legacy native history authoritative for both Web request forms', async () => {
    const value = { events: [{ event: { seq: 1 } }], hasMore: false, projections: { asOfSeq: 1, values: {} } }
    const history = vi.fn(async () => ({ result: { ok: true, value } }))
    const invoke = vi.fn(async () => { throw new Error('legacy history must not call Remote') })
    const connector = new HubConnector({ sessions: { history } }, { invoke }, { ipcEndpoint: '/unused', secretFile: '/unused',
      runtimeId: 'legacy', dshVersion: '0.1.0-rc.6', reconnectMaximumMs: 1_000 })
    const bridge = connector as unknown as { webRemote(endpoint: string, payload: unknown): Promise<unknown> }
    await expect(bridge.webRemote('session.history', { sessionId: 'legacy-session' })).resolves.toEqual(value)
    await expect(bridge.webRemote('session/history', { args: { request: { sessionId: 'legacy-session' } } })).resolves.toEqual(value)
    expect(history).toHaveBeenCalledTimes(2); expect(invoke).not.toHaveBeenCalled()
  })

  it('rebuilds the pinned model selector from the current catalog and Session projection', async () => {
    const selected = { provider: 'configured', model: 'session-model', reasoningEffort: 'high' }
    const catalog = { default: { provider: 'configured', model: 'default-model' }, routableProviders: ['configured'],
      groups: [{ id: 'configured', name: 'Provider', models: [{ id: 'session-model', name: 'Session model' }] }],
      failures: [{ id: 'offline', name: 'Unavailable', message: 'catalog unavailable' }] }
    let next: typeof selected | null = selected
    const invoke = vi.fn(async ({ method, args }: { method: string; args: Record<string, unknown> }) => {
      if (method === 'modelCatalog') { expect(args).toEqual({}); return catalog }
      if (method === 'projections') { expect(args).toEqual({ request: { sessionId: 'same-session' } }); return { values: { modelSelection: { next } } } }
      if (method === 'selectModel') { expect(args).toEqual({ request: { sessionId: 'same-session', ...selected } }); return { selected } }
      throw new Error(`removed Remote must not be called: ${method}`)
    })
    const connector = new HubConnector(undefined, { invoke }, { ipcEndpoint: '/unused', secretFile: '/unused',
      runtimeId: 'default', dshVersion: '0.1.7-rc.2', reconnectMaximumMs: 1_000 })
    const bridge = connector as unknown as { invokeWeb(operation: string, value: unknown): Promise<{ body: string }> }
    const request = async (method: string, payload: unknown) => {
      const response = await bridge.invokeWeb('fetch', { method: 'POST', path: `/api/${method}`,
        headers: [['content-type', 'application/json']], body: JSON.stringify({ type: 'client-request', rpcId: 'models-probe', method, payload }) })
      return (JSON.parse(response.body) as { result: unknown }).result
    }
    for (const method of ['session.models', 'session/models']) {
      await expect(request(method, method.includes('/') ? { args: { request: { sessionId: 'same-session' } } } : { sessionId: 'same-session' }))
        .resolves.toEqual({ ok: true, value: { current: selected, routable: true, groups: catalog.groups, failures: catalog.failures } })
    }
    await expect(request('session.selectModel', { sessionId: 'same-session', ...selected })).resolves.toEqual({ ok: true, value: { selected } })
    next = null
    await expect(request('session.models', { sessionId: 'same-session' })).resolves.toMatchObject({ value: { current: catalog.default } })
    catalog.routableProviders = []
    await expect(request('session.models', { sessionId: 'same-session' })).resolves.toMatchObject({ value: { routable: false } })
  })

  it('keeps simultaneous model catalogs and the same Session id scoped to each node Runtime', async () => {
    const targets = ['node-a', 'node-b'].map(owner => {
      const invoke = vi.fn(async ({ method }: { method: string }) => method === 'modelCatalog'
        ? { default: { provider: owner, model: `${owner}-model` }, routableProviders: [owner],
          groups: [{ id: owner, models: [{ id: `${owner}-model` }] }], failures: [] }
        : { values: { modelSelection: { next: null } } })
      const connector = new HubConnector(undefined, { invoke }, { ipcEndpoint: '/unused', secretFile: '/unused',
        runtimeId: owner, dshVersion: '0.1.7-rc.2', reconnectMaximumMs: 1_000 })
      return { owner, invoke, bridge: connector as unknown as { webRemote(endpoint: string, payload: unknown): Promise<unknown> } }
    })
    const results = await Promise.all(targets.map(target => target.bridge.webRemote('session.models', { sessionId: 'same-session' })))
    results.forEach((result, index) => {
      const target = targets[index]; if (target === undefined) throw new Error('missing target')
      expect(result).toMatchObject({ current: { provider: target.owner, model: `${target.owner}-model` }, groups: [{ id: target.owner }] })
      expect(target.invoke.mock.calls).toContainEqual([expect.objectContaining({ method: 'projections', args: { request: { sessionId: 'same-session' } } })])
    })
  })

  it('preserves the legacy model directory on older Runtime APIs', async () => {
    const value = { current: { provider: 'legacy', model: 'old-model' }, routable: true, groups: [], failures: [] }
    const models = vi.fn(async () => ({ result: { ok: true, value } }))
    const invoke = vi.fn(async () => { throw new Error('current catalog must not replace a legacy service') })
    const connector = new HubConnector({ sessions: { models } }, { invoke }, { ipcEndpoint: '/unused', secretFile: '/unused',
      runtimeId: 'legacy', dshVersion: '0.1.0-rc.7', reconnectMaximumMs: 1_000 })
    const bridge = connector as unknown as { webRemote(endpoint: string, payload: unknown): Promise<unknown> }
    await expect(bridge.webRemote('session.models', { sessionId: 'legacy-session' })).resolves.toEqual(value)
    expect(invoke).not.toHaveBeenCalled()
    expect(models).toHaveBeenCalledOnce()
  })

  it('waits for current Runtime storage services before advertising lifecycle support', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hub-delayed-services-')); roots.push(root)
    const secretFile = join(root, 'connector.secret'); const endpoint = join(root, 'agent.sock')
    const secret = generateHubIpcSecret(); await writeFile(secretFile, `${secret}\n`, { mode: 0o600 })
    const server = new HubConnectorServer(endpoint, secret, 'delayed-services-agent', {
      connected: () => undefined, body: () => undefined, disconnected: () => undefined,
    }); servers.push(server); await server.listen()
    const context = new Context(); contexts.push(context)
    context.provide('typertGateway', { invoke: async () => ({ items: [] }) })
    await context.plugin(HubConnectorPlugin, { ipcEndpoint: endpoint, secretFile, runtimeId: 'delayed-runtime',
      dshVersion: '0.1.7-rc.2', reconnectMaximumMs: 1_000 })
    expect(server.baselines()).toEqual([])
    context.provide('sessionPersistence', { name: 'session-persistence-jsonl', config: { root },
      stat: async () => undefined, resolveCurrentLog: async () => undefined, acquireWriteLease: async () => ({ release: async () => undefined }),
    } as never)
    context.provide('workspaceRegistry', { archivedSessionIds: [], archiveSession: async () => undefined,
      unarchiveSession: async () => undefined, list: () => [],
    } as never)
    expect(server.baselines()).toEqual([])
    context.provide('sessions', { get: () => undefined } as never)
    await vi.waitFor(() => { expect(server.baselines()[0]?.capabilities.some(capability => capability.name === 'dsh.session-lifecycle')).toBe(true) })
  })
  it('hides trash from source indexes and both Web RPC carriers, and rejects stale conversation URLs', async () => {
    const lifecycle = {
      hidden: (id: string) => id === 'removed',
      assertAvailable: (id: unknown) => { if (id === 'removed') throw new Error('session is in trash') },
    } as unknown as SessionLifecycle
    const invoke = vi.fn(async () => ({ items: [
      { sessionId: 'kept', updatedAt: 1, running: false },
      { sessionId: 'removed', updatedAt: 2, running: false },
    ] }))
    const connector = new HubConnector(undefined, { invoke }, {
      ipcEndpoint: '/unused', secretFile: '/unused', runtimeId: 'default', dshVersion: '0.1.7-rc.2', reconnectMaximumMs: 1_000,
    }, lifecycle)
    const methods = connector as unknown as {
      listSessions(): Promise<Array<{ sessionId: string }>>
      invokeWeb(operation: string, value: unknown): Promise<{ body: string }>
    }
    expect(await methods.listSessions()).toMatchObject([{ sessionId: 'kept' }])
    for (const method of ['session.list', 'session/list']) {
      const response = await methods.invokeWeb('fetch', {
        method: 'POST', path: `/api/${method}`, headers: [['content-type', 'application/json']],
        body: JSON.stringify({ type: 'client-request', rpcId: method, method,
          payload: method.includes('/') ? { args: { _request: {} } } : {} }),
      })
      expect(JSON.parse(response.body)).toMatchObject({ result: { ok: true, value: { items: [{ sessionId: 'kept' }] } } })
    }
    const count = invoke.mock.calls.length
    const response = await methods.invokeWeb('fetch', {
      method: 'POST', path: '/api/session/prompt', headers: [['content-type', 'application/json']],
      body: JSON.stringify({ type: 'client-request', rpcId: 'stale', method: 'session/prompt',
        payload: { args: { request: { sessionId: 'removed', content: [] } } } }),
    })
    expect(JSON.parse(response.body)).toMatchObject({ result: { ok: false, error: { message: 'session is in trash' } } })
    expect(invoke.mock.calls.length).toBe(count)
  })
  it('bridges the pinned Web directory picker to current DSH Remote methods', async () => {
    const listing = { path: '/home/dsh', home: '/home/dsh', crumbs: [], entries: [
      { name: 'work', path: '/home/dsh/work', hidden: false },
    ], truncated: false }
    const calls: Array<{ namespace: string; method: string; args: Record<string, unknown> }> = []
    const connector = new HubConnector(undefined, {
      invoke: async request => {
        calls.push(request)
        if (request.method === 'list') return listing
        if (request.method === 'createDirectory') return '/home/dsh/new'
        if (request.method === 'pick') return null
        throw new Error(`unexpected directory method ${request.method}`)
      },
    }, {
      ipcEndpoint: '/unused', secretFile: '/unused', runtimeId: 'default', dshVersion: '0.1.7-rc.2', reconnectMaximumMs: 1_000,
    })
    const invokeWeb = (connector as unknown as {
      invokeWeb(operation: string, value: unknown): Promise<{ body: string; status: number }>
    }).invokeWeb.bind(connector)
    async function request(method: string, payload: unknown): Promise<unknown> {
      const result = await invokeWeb('fetch', {
        method: 'POST', path: `/api/${method}`, headers: [['content-type', 'application/json']],
        body: JSON.stringify({ type: 'client-request', rpcId: method, method, payload }),
      })
      expect(result.status).toBe(200)
      return (JSON.parse(result.body) as { result: { ok: boolean; value: unknown } }).result
    }
    await expect(request('host.listDirectory', {})).resolves.toEqual({ ok: true, value: listing })
    await expect(request('host.listDirectory', { path: '/home/dsh/work' })).resolves.toEqual({ ok: true, value: listing })
    await expect(request('host.createDirectory', { path: '/home/dsh', name: 'new' })).resolves.toEqual({
      ok: true, value: { path: '/home/dsh/new' },
    })
    await expect(request('host.pickDirectory', {})).resolves.toEqual({ ok: true, value: { path: null } })
    expect(calls).toEqual([
      { namespace: 'directoryPicker', method: 'list', args: {} },
      { namespace: 'directoryPicker', method: 'list', args: { path: '/home/dsh/work' } },
      { namespace: 'directoryPicker', method: 'createDirectory', args: { path: '/home/dsh', name: 'new' } },
      { namespace: 'directoryPicker', method: 'pick', args: {} },
    ])
  })

  it('completes the pinned Web readiness handshake without a removed current Host Remote', async () => {
    const invoke = vi.fn(async ({ namespace, method }: { namespace: string; method: string }) => {
      if (namespace === 'session' && method === 'list') return { items: [{ sessionId: 'owned', updatedAt: 1, running: false, blank: true }] }
      throw new Error('removed Host Remote must not be invoked')
    })
    const connector = new HubConnector(undefined, { invoke }, {
      ipcEndpoint: '/unused', secretFile: '/unused', runtimeId: 'default', dshVersion: '0.1.7-rc.2', reconnectMaximumMs: 1_000,
    })
    const web = (connector as unknown as { invokeWeb(operation: string, value: unknown): Promise<{ body: string }> }).invokeWeb.bind(connector)
    for (const method of ['host.describe', 'host/describe']) {
      const response = await web('fetch', { method: 'POST', path: `/api/${method}`, headers: [['content-type', 'application/json']],
        body: JSON.stringify({ type: 'client-request', rpcId: method, method, payload: {} }) })
      expect(JSON.parse(response.body)).toMatchObject({ result: { ok: true, value: {
        version: '0.1.7-rc.2', cwd: process.cwd(), attachedSessions: 1, canOpenPath: false,
      } } })
    }
    expect(invoke.mock.calls.every(([request]) => request.namespace === 'session')).toBe(true)
  })

  it('joins each current Runtime permission catalog for list, history and live projection frames', async () => {
    for (const owner of ['first-node', 'second-node']) {
      const options = [{ value: owner, name: `Preset for ${owner}` }]
      const values = { permissions: { currentValue: owner }, plan: { active: false, pending: false } }
      const invoke = vi.fn(async ({ namespace, method }: { namespace: string; method: string }) => {
        if (namespace === 'permissionPresets' && method === 'catalog') return { options }
        throw new Error('unexpected catalog source')
      })
      const connector = new HubConnector(undefined, { invoke }, {
        ipcEndpoint: '/unused', secretFile: '/unused', runtimeId: 'default', dshVersion: '0.1.7-rc.2', reconnectMaximumMs: 1_000,
      }) as unknown as {
        filterWebResult(endpoint: string, value: unknown): Promise<unknown>
        legacyWebFrame(event: { rpcId: string; payload: Record<string, unknown> }): Promise<unknown>
      }
      for (const endpoint of ['session.history', 'session/history']) {
        await expect(connector.filterWebResult(endpoint, { events: [], projections: { asOfSeq: 4, values } })).resolves.toMatchObject({
          projections: { values: { permissions: { currentValue: owner, options } } },
        })
      }
      await expect(connector.filterWebResult('session.list', { items: [1, 2].map(index => ({
        sessionId: `session-${index}`, projections: { asOfSeq: 4, values },
      })) })).resolves.toMatchObject({ items: [1, 2].map(() => ({ projections: { values: { permissions: { currentValue: owner, options } } } })) })
      await expect(connector.legacyWebFrame({ rpcId: 'live', payload: { type: 'session/projection', sessionId: 'same-local-id',
        key: 'permissions', value: values.permissions, seq: 5 } })).resolves.toMatchObject({
        payload: { value: { currentValue: owner, options } },
      })
      expect(values.permissions).toEqual({ currentValue: owner })
      expect(invoke).toHaveBeenCalledTimes(4)
    }
  })

  it('keeps the legacy Host directory service on older DSH runtimes', async () => {
    const listing = { path: '/work', home: '/home', crumbs: [], entries: [], truncated: false }
    const hostList = vi.fn(async () => ({ result: { ok: true, value: listing } }))
    const remoteInvoke = vi.fn(async () => { throw new Error('current Remote must not be called') })
    const connector = new HubConnector({ host: { listDirectory: hostList } }, { invoke: remoteInvoke }, {
      ipcEndpoint: '/unused', secretFile: '/unused', runtimeId: 'default', dshVersion: '0.1.0-rc.7', reconnectMaximumMs: 1_000,
    })
    const invokeWeb = (connector as unknown as {
      invokeWeb(operation: string, value: unknown): Promise<{ body: string }>
    }).invokeWeb.bind(connector)
    const response = await invokeWeb('fetch', {
      method: 'POST', path: '/api/host.listDirectory', headers: [['content-type', 'application/json']],
      body: JSON.stringify({ type: 'client-request', rpcId: 'legacy-directory', method: 'host.listDirectory', payload: {} }),
    })
    expect(JSON.parse(response.body)).toMatchObject({ result: { ok: true, value: listing } })
    expect(hostList).toHaveBeenCalledOnce()
    expect(remoteInvoke).not.toHaveBeenCalled()
  })

  it('adapts the pinned Web workspace mutations to current Typert request arguments', async () => {
    const workspace = {
      workspaceId: 'workspace-1', path: '/home/dsh/project', title: 'project',
      sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const remoteInvoke = vi.fn(async ({ method }: { method: string }) =>
      method === 'create' ? { workspace, created: true } : { workspace: { ...workspace, title: 'renamed' } })
    const connector = new HubConnector(undefined, { invoke: remoteInvoke }, {
      ipcEndpoint: '/unused', secretFile: '/unused', runtimeId: 'default', dshVersion: '0.1.7-rc.2', reconnectMaximumMs: 1_000,
    })
    const invokeWeb = (connector as unknown as {
      invokeWeb(operation: string, value: unknown): Promise<{ body: string; status: number }>
    }).invokeWeb.bind(connector)
    async function request(method: string, payload: unknown): Promise<unknown> {
      const response = await invokeWeb('fetch', {
        method: 'POST', path: `/api/${method}`, headers: [['content-type', 'application/json']],
        body: JSON.stringify({ type: 'client-request', rpcId: method, method, payload }),
      })
      expect(response.status).toBe(200)
      return (JSON.parse(response.body) as { result: unknown }).result
    }
    await expect(request('workspace.create', { path: workspace.path })).resolves.toEqual({
      ok: true, value: { workspace, created: true },
    })
    await expect(request('workspace.rename', { workspaceId: workspace.workspaceId, title: 'renamed' })).resolves.toEqual({
      ok: true, value: { workspace: { ...workspace, title: 'renamed' } },
    })
    expect(remoteInvoke).toHaveBeenNthCalledWith(1, {
      namespace: 'workspace', method: 'create', args: { request: { path: workspace.path } }, signal: expect.any(AbortSignal),
    })
    expect(remoteInvoke).toHaveBeenNthCalledWith(2, {
      namespace: 'workspace', method: 'rename', args: { request: { workspaceId: workspace.workspaceId, title: 'renamed' } },
      signal: expect.any(AbortSignal),
    })
  })

  it('keeps legacy workspace mutation arguments on older DSH runtimes', async () => {
    const create = vi.fn(async () => ({ result: { ok: true, value: { workspace: { path: '/work' }, created: true } } }))
    const remoteInvoke = vi.fn(async () => { throw new Error('current Remote must not be called') })
    const connector = new HubConnector({ workspace: { create } }, { invoke: remoteInvoke }, {
      ipcEndpoint: '/unused', secretFile: '/unused', runtimeId: 'default', dshVersion: '0.1.0-rc.7', reconnectMaximumMs: 1_000,
    })
    const invokeWeb = (connector as unknown as {
      invokeWeb(operation: string, value: unknown): Promise<{ body: string }>
    }).invokeWeb.bind(connector)
    const response = await invokeWeb('fetch', {
      method: 'POST', path: '/api/workspace.create', headers: [['content-type', 'application/json']],
      body: JSON.stringify({ type: 'client-request', rpcId: 'legacy-workspace', method: 'workspace.create', payload: { path: '/work' } }),
    })
    expect(JSON.parse(response.body)).toMatchObject({ result: { ok: true, value: { created: true } } })
    expect(create).toHaveBeenCalledWith({ rpcId: expect.any(String), payload: { path: '/work' } }, undefined)
    expect(remoteInvoke).not.toHaveBeenCalled()
  })

  it('normalizes current Gateway event frames for the legacy Web stream envelope', () => {
    expect(normalizeEventFrame({ type: 'projection', sessionId: 's1', key: 'plan', value: { pending: false }, seq: 7 })).toMatchObject({
      payload: { type: 'session/projection', sessionId: 's1', key: 'plan', value: { pending: false }, seq: 7 },
    })
    expect(normalizeEventFrame({ type: 'ready', clientId: 'client-1', host: { home: '/workspace' } })).toBeUndefined()
    expect(normalizeEventFrame({ type: 'emit', event: 'api-session/status', args: [{ sessionId: 's1', running: true }] })).toMatchObject({
      payload: { type: 'api-session/status', args: [{ sessionId: 's1', running: true }] },
    })
    expect(normalizeEventFrame({
      type: 'waterfall', event: 'user-questions/request', eventId: 'question-1', agentId: 'agent-1',
      request: { sessionId: 's1', questions: [{ id: 'confirm', question: 'Continue?' }] },
    })).toEqual({
      rpcId: 'question-1',
      payload: {
        type: 'question/requested', event: 'user-questions/request', eventId: 'question-1', agentId: 'agent-1',
        sessionId: 's1', questions: [{ id: 'confirm', question: 'Continue?' }],
      },
    })
  })

  it('forwards actual Context Session events on two Remote-only owners and removes listeners on disposal', async () => {
    const targets = await Promise.all(['node-a', 'node-b', 'legacy'].map(async owner => {
      const root = await mkdtemp(join(tmpdir(), 'hub-native-events-')); roots.push(root)
      const secretFile = join(root, 'connector.secret'); const endpoint = join(root, 'agent.sock')
      const secret = generateHubIpcSecret(); await writeFile(secretFile, `${secret}\n`, { mode: 0o600 })
      const bodies: HubEnvelopeBody[] = []
      const server = new HubConnectorServer(endpoint, secret, `${owner}-boot-12345678`, {
        connected: () => undefined, body: (_runtime, body) => { bodies.push(body) }, disconnected: () => undefined,
      }); servers.push(server); await server.listen()
      const context = new Context(); contexts.push(context)
      context.provide('typertGateway', {
        invoke: async () => ({ items: [] }),
        stream: async ({ signal }: { signal: AbortSignal }) => idle(signal),
      })
      context.provide('sessionPersistence', {} as never)
      context.provide('workspaceRegistry', { archivedSessionIds: [], list: () => [] } as never)
      context.provide('sessions', { get: () => undefined } as never)
      if (owner === 'legacy') context.provide('apiProxy', {
        sessions: { list: async () => ({ result: { ok: true, value: { items: [] } } }) },
        events: { mux: (_request: unknown, signal: AbortSignal) => idle(signal), host: (_request: unknown, signal: AbortSignal) => idle(signal) },
      } as never)
      await context.plugin(HubConnectorPlugin, { ipcEndpoint: endpoint, secretFile, runtimeId: owner, dshVersion: owner === 'legacy' ? '0.1.0-rc.6' : '0.1.7-rc.2', reconnectMaximumMs: 1_000 })
      await vi.waitFor(() => { expect(bodies.some(body => body.type === 'stream.frame' && body.stream === 'index'), owner).toBe(true) })
      return { owner, context, bodies }
    }))
    for (const target of targets) {
      const emit = target.context as unknown as { emit(event: string, session: { id: string }, record: unknown): void }
      emit.emit('session/event', { id: 'same-session' }, { type: 'assistant/message', seq: 3, data: { owner: target.owner } })
    }
    const events = (target: typeof targets[number]) => target.bodies.filter(body => body.type === 'stream.frame' && body.stream === 'mux')
    await vi.waitFor(() => { expect(events(targets[0]!)).toHaveLength(1); expect(events(targets[1]!)).toHaveLength(1) })
    for (const target of targets.slice(0, 2)) expect(events(target)[0]).toMatchObject({ runtimeId: target.owner, payload: {
      type: 'server-request', method: 'session/event', payload: { type: 'session/event', sessionId: 'same-session', event: { data: { owner: target.owner } } },
    } })
    expect(events(targets[2]!)).toHaveLength(0)
    for (const target of targets) {
      await target.context.fiber.dispose()
      const count = events(target).length
      ;(target.context as unknown as { emit(event: string, session: { id: string }, record: unknown): void }).emit('session/event', { id: 'same-session' }, {})
      expect(events(target)).toHaveLength(count)
    }
  })

  it('answers a current Remote waterfall through $events/result', async () => {
    const calls: unknown[][] = []
    const connector = new HubConnector(undefined, {
      dispatchRpc: async (...args: unknown[]) => {
        calls.push(args)
        return { ok: true, value: undefined }
      },
    }, {
      ipcEndpoint: '/unused', secretFile: '/unused', runtimeId: 'default', dshVersion: '0.1.6-alpha.2', reconnectMaximumMs: 1_000,
    })
    ;(connector as unknown as { remoteEventClientId: string }).remoteEventClientId = 'event-client-1'
    const invokeSessions = (connector as unknown as {
      invokeSessions(operation: string, value: unknown, commandId: string): Promise<unknown>
    }).invokeSessions.bind(connector)
    await expect(invokeSessions('interaction.respond', {
      sessionId: 'session-1', requestId: 'event-1', response: { answers: [{ id: 'continue', selected: ['Yes'] }] },
    }, 'answer-1')).resolves.toEqual({ ok: true })
    expect(calls).toEqual([['$events/result', { args: {
      clientId: 'event-client-1', eventId: 'event-1',
      outcome: { kind: 'result', value: { answers: [{ id: 'continue', selected: ['Yes'] }] } },
    } }, expect.any(AbortSignal)]])
  })

  it('forwards the official Web /api/respond envelope to current Remote events', async () => {
    const calls: unknown[][] = []
    const connector = new HubConnector(undefined, {
      dispatchRpc: async (...args: unknown[]) => {
        calls.push(args)
        return { ok: true, value: undefined }
      },
    }, {
      ipcEndpoint: '/unused', secretFile: '/unused', runtimeId: 'default', dshVersion: '0.1.6-alpha.2', reconnectMaximumMs: 1_000,
    })
    ;(connector as unknown as { remoteEventClientId: string }).remoteEventClientId = 'event-client-web'
    const invokeWeb = (connector as unknown as { invokeWeb(operation: string, value: unknown): Promise<unknown> }).invokeWeb.bind(connector)
    const result = await invokeWeb('fetch', {
      method: 'POST', path: '/api/respond', headers: [['content-type', 'application/json']],
      body: JSON.stringify({ type: 'client-response', rpcId: 'event-web-1', result: {
        ok: true, value: { sessionId: 'session-1', answer: { answers: [{ id: 'continue', selected: ['Yes'] }] } },
      } }),
    }) as { body: string; status: number }
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toEqual({ accepted: true })
    expect(calls[0]).toEqual(['$events/result', { args: {
      clientId: 'event-client-web', eventId: 'event-web-1', outcome: { kind: 'result', value: {
        sessionId: 'session-1', answer: { answers: [{ id: 'continue', selected: ['Yes'] }] },
      } },
    } }, expect.any(AbortSignal)])
  })

  it.each(['legacy', 'remote', 'disconnected'] as const)('reports rejected answers through both carriers (%s)', async (kind) => {
    const receipt = { accepted: false, reason: kind === 'legacy' ? 'not-pending' : kind === 'remote' ? 'response-rejected' : 'response-unavailable' }
    const connector = new HubConnector(kind === 'legacy' ? { respond: async () => receipt } : undefined, {
      dispatchRpc: async () => ({ ok: false, error: { message: 'event expired' } }),
    }, {
      ipcEndpoint: '/unused', secretFile: '/unused', runtimeId: 'default', dshVersion: 'test', reconnectMaximumMs: 1_000,
    })
    if (kind !== 'disconnected') (connector as unknown as { remoteEventClientId: string }).remoteEventClientId = 'event-client'
    const invokeWeb = (connector as unknown as { invokeWeb(operation: string, value: unknown): Promise<{ body: string }> }).invokeWeb.bind(connector)
    const result = await invokeWeb('fetch', {
      method: 'POST', path: '/api/respond', headers: [['content-type', 'application/json']],
      body: JSON.stringify({ type: 'client-response', rpcId: 'expired-question', result: { ok: true, value: {} } }),
    })
    expect(JSON.parse(result.body)).toEqual(receipt)
    const invokeSessions = (connector as unknown as { invokeSessions(operation: string, value: unknown, id: string): Promise<unknown> }).invokeSessions.bind(connector)
    await expect(invokeSessions('interaction.respond', { requestId: 'expired-question', response: {} }, 'answer')).rejects.toThrow(receipt.reason)
  })

  it('captures the current event client id before forwarding a question', async () => {
    const frames: HubIpcFrame[] = []
    const resultCalls: unknown[][] = []
    const connector = new HubConnector(undefined, {
      dispatchRpc: async (...args: unknown[]) => {
        resultCalls.push(args)
        return { ok: true, value: undefined }
      },
      wireStream: {
        open: async (_endpoint: string, _payload: unknown, signal: AbortSignal) => (async function* () {
          yield { type: 'ready', clientId: 'client-from-gateway', host: { home: '/workspace' } }
          yield {
            type: 'waterfall', event: 'user-questions/request', eventId: 'question-from-gateway', agentId: 'agent-1',
            request: { sessionId: 'session-1', questions: [{ id: 'continue', question: 'Continue?' }] },
          }
          await new Promise<void>((resolve) => {
            // The real Gateway closes this iterator when the Connector stream lifetime ends.
            // Mirror that cancellation in the functional test.
            signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        })(),
      },
    }, {
      ipcEndpoint: '/unused', secretFile: '/unused', runtimeId: 'default', dshVersion: '0.1.6-alpha.2', reconnectMaximumMs: 1_000,
    })
    ;(connector as unknown as { send: (frame: HubIpcFrame) => Promise<void> }).send = async (frame) => { frames.push(frame) }
    ;(connector as unknown as { publishIndex: () => Promise<void> }).publishIndex = async () => undefined
    const controller = new AbortController()
    const pumping = (connector as unknown as { pumpStreams(signal: AbortSignal): Promise<void> }).pumpStreams(controller.signal)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({
      type: 'ipc.hub-body', body: { type: 'stream.frame', payload: {
        type: 'server-request', rpcId: 'question-from-gateway', method: 'question/requested',
      } },
    })
    const invokeSessions = (connector as unknown as {
      invokeSessions(operation: string, value: unknown, commandId: string): Promise<unknown>
    }).invokeSessions.bind(connector)
    await expect(invokeSessions('interaction.respond', {
      sessionId: 'session-1', requestId: 'question-from-gateway', response: { answers: [{ id: 'continue', selected: ['Yes'] }] },
    }, 'answer-2')).resolves.toEqual({ ok: true })
    expect(resultCalls[0]?.[0]).toBe('$events/result')
    controller.abort(new Error('test complete'))
    await pumping
  })

  it.each(['invoke', 'dispatch'] as const)('admits legacy Web prompts with stable identities on independent owners (%s)', async (gatewayKind) => {
    const admitted = new Map<string, Map<string, unknown>>()
    for (const owner of ['node-a', 'node-b']) {
      const messages = new Map<string, unknown>(); admitted.set(owner, messages)
      const admit = async (endpoint: string, args: Record<string, unknown>) => {
        expect(endpoint).toBe('session/prompt')
        expect(Object.keys(args)).toEqual(['request'])
        const request = args.request as Record<string, unknown>
        if (typeof request.requestId !== 'string' || request.requestId.length === 0) throw new Error('wire field "request" failed boundary validation')
        expect(request).toMatchObject({ sessionId: 'same-session', mode: 'steer', content: [{ type: 'text', text: '你好啊' }], clientTimeZone: 'Asia/Shanghai' })
        messages.set(request.requestId, request)
        return { accepted: true }
      }
      const connector = new HubConnector(undefined, gatewayKind === 'invoke' ? {
        invoke: ({ namespace, method, args }) => admit(`${namespace}/${method}`, args),
      } : { dispatch: async (endpoint, args) => ({ ok: true, value: await admit(endpoint, args as Record<string, unknown>) }) }, {
        ipcEndpoint: '/unused', secretFile: '/unused', runtimeId: owner, dshVersion: '0.1.7-rc.2', reconnectMaximumMs: 1_000,
      })
      const fetch = (connector as unknown as { invokeWeb(operation: string, input: unknown): Promise<{ body: string }> }).invokeWeb.bind(connector)
      for (const endpoint of ['session.prompt', 'session/prompt']) {
        for (const explicit of [false, true]) {
          const request = { sessionId: 'same-session', mode: 'steer', content: [{ type: 'text', text: '你好啊' }], clientTimeZone: 'Asia/Shanghai',
            ...(explicit ? { requestId: 'native-id' } : {}) }
          const input = { method: 'POST', path: `/api/${endpoint}`, headers: [['content-type', 'application/json']],
            body: JSON.stringify({ type: 'client-request', rpcId: 'stable-web-id', method: endpoint,
              payload: endpoint.includes('/') ? { args: { request } } : request }) }
          for (let replay = 0; replay < 2; replay++) {
            const response = await fetch('fetch', input)
            expect(JSON.parse(response.body).result).toEqual({ ok: true, value: { accepted: true } })
          }
        }
      }
      expect([...messages.keys()]).toEqual(['stable-web-id', 'native-id'])
    }
    expect(admitted.get('node-a')).not.toBe(admitted.get('node-b'))
  })

  it('leaves legacy prompt payloads unchanged and never retries a rejected modern prompt', async () => {
    const payload = { sessionId: 'same-session', mode: 'queue', content: [{ type: 'text', text: 'hello' }] }
    const legacy = vi.fn(async (request: { rpcId: string; payload: unknown }) => ({ result: { ok: true, value: { accepted: true } }, rpcId: request.rpcId }))
    const invoke = vi.fn(async () => { throw new Error('model unavailable') })
    const options = { ipcEndpoint: '/unused', secretFile: '/unused', runtimeId: 'default', dshVersion: 'test', reconnectMaximumMs: 1_000 }
    const connectors = [new HubConnector({ sessions: { prompt: legacy } }, { invoke }, options), new HubConnector(undefined, { invoke }, options)]
    for (const [index, connector] of connectors.entries()) {
      const fetch = (connector as unknown as { invokeWeb(operation: string, input: unknown): Promise<{ body: string }> }).invokeWeb.bind(connector)
      const result = JSON.parse((await fetch('fetch', { method: 'POST', path: '/api/session.prompt', headers: [['content-type', 'application/json']],
        body: JSON.stringify({ type: 'client-request', rpcId: 'web-id', method: 'session.prompt', payload }) })).body).result
      expect(result.ok).toBe(index === 0)
      if (index === 1) expect(result.error.message).toBe('model unavailable')
    }
    expect(legacy.mock.calls[0]?.[0].payload).toEqual(payload)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('adapts current Typert Remote session calls without the legacy ApiProxy', async () => {
    const calls: Array<{ namespace: string; method: string; args: Record<string, unknown> }> = []
    let listed = false
    const gateway = {
      invoke: async (request: { namespace: string; method: string; args: Record<string, unknown> }) => {
        calls.push(request)
        expect(Object.keys(request.args)).toEqual([request.method === 'list' ? '_request' : 'request'])
        if (request.namespace === 'session' && request.method === 'list') {
          return { items: listed ? [{ sessionId: 'new-session', updatedAt: 10, running: true, cwd: '/workspace' }] : [] }
        }
        if (request.namespace === 'session' && request.method === 'create') {
          listed = true
          return { sessionId: 'new-session' }
        }
        if (request.namespace === 'session' && request.method === 'projections') return { asOfSeq: -1, values: {} }
        if (request.namespace === 'session' && request.method === 'page') { expect(request.args.request).toMatchObject({ throughSeq: -1 }); return { records: [], hasMore: false } }
        if (request.namespace === 'session' && request.method === 'prompt') return { accepted: true }
        throw new Error(`unexpected Remote ${request.namespace}.${request.method}`)
      },
    }
    const connector = new HubConnector(undefined, gateway, {
      ipcEndpoint: '/unused', secretFile: '/unused', runtimeId: 'default', dshVersion: '0.1.5-rc.2', reconnectMaximumMs: 1_000,
    })
    const invokeSessions = (connector as unknown as {
      invokeSessions(operation: string, value: unknown, commandId: string): Promise<unknown>
    }).invokeSessions.bind(connector)
    await expect(invokeSessions('create', {
      clientMutationId: 'new-session-mutation', workspacePath: '/workspace', initialMessage: 'run the skill',
    }, 'command-1')).resolves.toMatchObject({ sessionId: 'new-session', running: true })
    await expect(invokeSessions('message.append', {
      clientMutationId: 'answer-mutation', sessionId: 'new-session', text: 'answer this',
    }, 'command-2')).resolves.toMatchObject({ accepted: true })
    expect(calls.map(call => `${call.namespace}.${call.method}`)).toEqual([
      'session.list', 'session.create', 'session.projections', 'session.page', 'session.prompt', 'session.list', 'session.projections', 'session.page',
      'session.projections', 'session.page', 'session.prompt', 'session.list', 'session.projections', 'session.page',
    ])
  })

  it('forwards current Remote command endpoints used by tools and skills', async () => {
    const calls: Array<{ namespace: string; method: string; args: Record<string, unknown> }> = []
    const connector = new HubConnector(undefined, {
      invoke: async (request: { namespace: string; method: string; args: Record<string, unknown> }) => {
        calls.push(request)
        return { completed: true, output: 'skill-result' }
      },
    }, {
      ipcEndpoint: '/unused', secretFile: '/unused', runtimeId: 'default', dshVersion: '0.1.6-alpha.2', reconnectMaximumMs: 1_000,
    })
    const invokeWeb = (connector as unknown as { invokeWeb(operation: string, value: unknown): Promise<unknown> }).invokeWeb.bind(connector)
    const result = await invokeWeb('fetch', {
      method: 'POST', path: '/api/commands/execute', headers: [['content-type', 'application/json']],
      body: JSON.stringify({ type: 'client-request', rpcId: 'tool-rpc-1', method: 'commands/execute', payload: { args: {
        agentId: 'session-1', line: '/skill run-check', submittedAttachments: [],
      } } }),
    }) as { body: string; status: number }
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toMatchObject({ rpcId: 'tool-rpc-1', result: { ok: true, value: { completed: true } } })
    expect(calls).toEqual([expect.objectContaining({ namespace: 'commands', method: 'execute', args: {
      agentId: 'session-1', line: '/skill run-check', submittedAttachments: [],
    } })])
  })

  it('rejects a queued write when IPC closes before the write reaches the socket', async () => {
    const connector = new HubConnector({} as TestApiProxy, testGateway(), {
      ipcEndpoint: '/unused',
      secretFile: '/unused',
      runtimeId: 'default',
      dshVersion: 'test',
      reconnectMaximumMs: 1_000,
    })
    let releaseWrite: (() => void) | undefined
    const previousWrite = new Promise<void>((resolve) => { releaseWrite = resolve })
    const write = vi.fn()
    const socket = { destroyed: false, write }
    ;(connector as unknown as { active: { socket: typeof socket; writes: Promise<void> } }).active = {
      socket,
      writes: previousWrite,
    }
    const send = (connector as unknown as {
      send: (frame: HubIpcFrame) => Promise<void>
    }).send.bind(connector)
    const pending = send({ type: 'ipc.heartbeat', timestamp: Date.now() })

    socket.destroyed = true
    releaseWrite?.()

    await expect(pending).rejects.toThrow('Connector IPC is offline')
    expect(write).not.toHaveBeenCalled()
  })

  it('detects the DSH package version from the launching CLI entrypoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hub-version-'))
    roots.push(root)
    const packageRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh')
    const entrypoint = join(packageRoot, 'lib', 'bin.js')
    await mkdir(join(packageRoot, 'lib'), { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh', version: '0.1.0-rc.6',
    }))
    await writeFile(entrypoint, '#!/usr/bin/env node\n')
    await expect(detectDshVersion(entrypoint)).resolves.toBe('0.1.0-rc.6')
  })

  it('reserves interactive capacity after all four bulk Web slots are stalled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hub-priority-'))
    roots.push(root)
    const endpoint = join(root, 'agent.sock')
    const secretFile = join(root, 'connector.secret')
    const secret = generateHubIpcSecret()
    await writeFile(secretFile, `${secret}\n`, { mode: 0o600 })
    await chmod(secretFile, 0o600)

    const success = <T>(rpcId: string, value: T) => ({ rpcId, result: { ok: true as const, value } })
    const api = {
      sessions: { list: async (request: { rpcId: string }) => success(request.rpcId, { items: [] }) },
      events: {
        mux: (_request: unknown, signal: AbortSignal) => idle(signal),
        host: (_request: unknown, signal: AbortSignal) => idle(signal),
      },
    } as unknown as TestApiProxy

    let slowStartedResolve: (() => void) | undefined
    const slowStarted = new Promise<void>((resolve) => { slowStartedResolve = resolve })
    let slowStartedCount = 0
    let releaseSlow: (() => void) | undefined
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve })
    const gateway = testGateway()
    vi.spyOn(gateway, 'dispatch').mockImplementation(async (method) => {
      if (method.startsWith('probe/slow-')) {
        slowStartedCount += 1
        if (slowStartedCount === 4) slowStartedResolve?.()
        await slowGate
        return { ok: true, value: { completed: 'slow' } } as never
      }
      if (method === 'goals/pause') return { ok: true, value: { completed: 'goal' } } as never
      if (method === 'commands/execute') return { ok: true, value: { completed: 'created' } } as never
      if (method === 'settings/update') return { ok: true, value: { completed: 'settings' } } as never
      if (method === 'respond') return { ok: true, value: { completed: 'answer' } } as never
      if (method === 'session/cancel') return { ok: true, value: { accepted: true } } as never
      throw new Error(`unexpected Gateway method ${method}`)
    })

    let baselineResolve: (() => void) | undefined
    const baseline = new Promise<void>((resolve) => { baselineResolve = resolve })
    const bodies: HubEnvelopeBody[] = []
    const server = new HubConnectorServer(endpoint, secret, 'agent-boot-id-priority', {
      connected: () => baselineResolve?.(),
      body: (_runtimeId, body) => { bodies.push(body) },
      disconnected: () => undefined,
    })
    servers.push(server)
    await server.listen()
    const connector = new HubConnector(api, gateway, {
      ipcEndpoint: endpoint,
      secretFile,
      runtimeId: 'default',
      dshVersion: 'test',
      reconnectMaximumMs: 1_000,
    })
    const controller = new AbortController()
    const running = connector.run(controller.signal)
    await baseline

    const webCommand = (commandId: string, method: string): HubEnvelopeBody => ({
      type: 'capability.invoke',
      commandId,
      runtimeId: 'default',
      capability: 'dsh.web',
      capabilityVersion: '1.0.0',
      operation: 'fetch',
      idempotencyKey: `${commandId}-mutation`,
      payload: {
        clientMutationId: `${commandId}-request`,
        method: 'POST',
        path: `/api/${method}`,
        headers: [['content-type', 'application/json']],
        body: JSON.stringify({
          type: 'client-request', rpcId: `${commandId}-rpc`, method, payload: {},
        }),
      },
    })

    try {
      await Promise.all(Array.from({ length: 4 }, async (_, index) => {
        const suffix = String(index + 1).padStart(4, '0')
        await server.send('default', webCommand(`command-priority-slow-${suffix}`, `probe/slow-${suffix}`))
      }))
      await slowStarted
      await Promise.all([
        server.send('default', webCommand('command-priority-goal-0001', 'goals/pause')),
        server.send('default', webCommand('command-priority-create-0001', 'commands/execute')),
        server.send('default', webCommand('command-priority-settings-0001', 'settings/update')),
        server.send('default', webCommand('command-priority-answer-0001', 'respond')),
        server.send('default', webCommand('command-priority-cancel-0001', 'session/cancel')),
      ])
      await vi.waitFor(() => { expect(bodies).toContainEqual(expect.objectContaining({
        type: 'capability.result', commandId: 'command-priority-goal-0001', status: 'ok',
      })) })
      await vi.waitFor(() => { expect(bodies).toContainEqual(expect.objectContaining({
        type: 'capability.result', commandId: 'command-priority-create-0001', status: 'ok',
      })) })
      await vi.waitFor(() => { expect(bodies).toContainEqual(expect.objectContaining({
        type: 'capability.result', commandId: 'command-priority-settings-0001', status: 'ok',
      })) })
      await vi.waitFor(() => { expect(bodies).toContainEqual(expect.objectContaining({
        type: 'capability.result', commandId: 'command-priority-answer-0001', status: 'ok',
      })) })
      await vi.waitFor(() => { expect(bodies).toContainEqual(expect.objectContaining({
        type: 'capability.result', commandId: 'command-priority-cancel-0001', status: 'ok',
      })) })
      const cancelled = bodies.find(body => body.type === 'capability.result' && body.commandId === 'command-priority-cancel-0001')
      expect(cancelled).toMatchObject({ value: { body: expect.stringContaining('"accepted":true') } })
      expect(bodies.some(body => body.type === 'capability.result'
        && body.commandId.startsWith('command-priority-slow-'))).toBe(false)
      releaseSlow?.()
      await vi.waitFor(() => { expect(bodies).toContainEqual(expect.objectContaining({
        type: 'capability.result', commandId: 'command-priority-slow-0001', status: 'ok',
      })) })
    } finally {
      releaseSlow?.()
      controller.abort(new Error('test complete'))
      await running
    }
  })

  it('loads beside local Web and desktop consumers through the real Cordis Loader', async () => {
    expect('default' in HubConnectorPlugin).toBe(false)
    const root = await mkdtemp(join(tmpdir(), 'dsh-hub-loader-'))
    roots.push(root)
    const endpoint = join(root, 'agent.sock')
    const secretFile = join(root, 'connector.secret')
    const configFile = join(root, 'cordis.yml')
    const secret = generateHubIpcSecret()
    await writeFile(secretFile, `${secret}\n`, { mode: 0o600 })
    await chmod(secretFile, 0o600)

    const calls: string[] = []
    const success = <T>(rpcId: string, value: T) => ({ rpcId, result: { ok: true as const, value } })
    const sessionEvents = async function* (signal: AbortSignal) {
      yield {
        rpcId: 'loader-session-event-0001',
        payload: {
          type: 'session/event', sessionId: 'loader-shared-session',
          event: { type: 'step/start', seq: 1, time: 1, data: {} },
        },
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
    const api = {
      sessions: {
        list: async (request: { rpcId: string }) => success(request.rpcId, { items: [{
          sessionId: 'loader-shared-session', updatedAt: Date.now(), running: false, blank: false, cwd: root,
        }] }),
        history: async (request: { rpcId: string }) => success(request.rpcId, { events: [], hasMore: false }),
        prompt: async (request: { rpcId: string; payload: { content: Array<{ text?: string }> } }) => {
          calls.push(request.payload.content[0]?.text ?? '')
          return success(request.rpcId, { accepted: true as const })
        },
      },
      host: { describe: async (request: { rpcId: string }) => success(request.rpcId, {
        version: '0.1.0-rc.5', cwd: root, attachedSessions: 1, canOpenPath: true,
      }) },
      settings: { describe: async (request: { rpcId: string }) => success(request.rpcId, {
        writable: true, hasDocument: true, namespaces: [],
      }) },
      events: {
        mux: (_request: unknown, signal: AbortSignal) => sessionEvents(signal),
        host: (_request: unknown, signal: AbortSignal) => idle(signal),
      },
      respond: async () => ({ accepted: true as const }),
    } as unknown as TestApiProxy

    let baselineResolve: (() => void) | undefined
    const baseline = new Promise<void>((resolve) => { baselineResolve = resolve })
    const bodies: HubEnvelopeBody[] = []
    const server = new HubConnectorServer(endpoint, secret, 'agent-boot-id-loader', {
      connected: () => baselineResolve?.(),
      body: (_runtimeId, body) => { bodies.push(body) },
      disconnected: () => undefined,
    })
    servers.push(server)
    await server.listen()

    await writeFile(configFile, [
      '- id: local-web',
      '  name: test:local-web',
      '- id: desktop',
      '  name: test:desktop',
      '- id: hub-connector',
      "  name: '@k1412/dsh-hub-connector'",
      '  config:',
      `    ipcEndpoint: ${JSON.stringify(endpoint)}`,
      `    secretFile: ${JSON.stringify(secretFile)}`,
      '    runtimeId: loader-runtime',
      '    dshVersion: 0.1.0-rc.5',
      '    reconnectMaximumMs: 1000',
      '',
    ].join('\n'))
    const context = new Context()
    contexts.push(context)
    context.baseUrl = `${pathToFileURL(root).href}/`
    context.provide('apiProxy', api)
    context.provide('typertGateway', testGateway())
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const surface = (name: string) => ({
      inject: ['apiProxy'],
      async apply(ctx: Context) {
        await ctx.apiProxy.sessions.prompt({
          rpcId: `rpc-${name}` as never,
          payload: {
            sessionId: 'loader-shared-session' as never,
            mode: 'queue',
            content: [{ type: 'text', text: `from ${name}` }],
          },
        })
      },
    })
    const modules = new Map<string, unknown>([
      ['test:local-web', surface('local-web')],
      ['test:desktop', surface('desktop')],
      ['@k1412/dsh-hub-connector', HubConnectorPlugin],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        const module = modules.get(specifier)
        if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
        return module
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configFile).href },
    })
    await context.loader.await()
    await baseline

    await vi.waitFor(() => { expect(bodies.some(body => body.type === 'stream.frame'
      && body.runtimeId === 'loader-runtime' && body.capability === 'dsh.sessions'
      && body.stream === 'index')).toBe(true) })
    const index = bodies.find(body => body.type === 'stream.frame'
      && body.runtimeId === 'loader-runtime' && body.capability === 'dsh.sessions'
      && body.stream === 'index')
    if (index?.type !== 'stream.frame') throw new Error('Connector session index was not published')
    expect(index.payload).toMatchObject({
      sessions: [{ sessionId: 'loader-shared-session', workspacePath: root }],
    })
    await vi.waitFor(() => { expect(bodies.some(body => body.type === 'stream.frame'
      && body.capability === 'dsh.web' && body.stream === 'mux')).toBe(true) })
    expect(bodies.some(body => body.type === 'stream.frame'
      && body.capability === 'dsh.sessions' && body.stream === 'events')).toBe(false)

    await server.send('loader-runtime', {
      type: 'capability.invoke',
      commandId: 'command-loader-0001',
      runtimeId: 'loader-runtime',
      capability: 'dsh.sessions',
      capabilityVersion: '1.0.0',
      operation: 'message.append',
      idempotencyKey: 'mutation-hub-loader',
      payload: {
        clientMutationId: 'mutation-hub',
        sessionId: 'loader-shared-session',
        text: 'from hub',
        attachments: [],
      },
    })
    await vi.waitFor(() =>{  expect(bodies).toContainEqual(expect.objectContaining({
      type: 'capability.result', commandId: 'command-loader-0001', status: 'ok',
    })) })
    expect(calls).toEqual(['from local-web', 'from desktop', 'from hub'])
  })

  it('uses the same ApiProxy session as local Web and desktop surfaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hub-connector-'))
    roots.push(root)
    const endpoint = join(root, 'agent.sock')
    const secretFile = join(root, 'connector.secret')
    const secret = generateHubIpcSecret()
    await writeFile(secretFile, `${secret}\n`, { mode: 0o600 })
    await chmod(secretFile, 0o600)

    const calls: Array<{ surface: string; text: string }> = []
    const event = {
      type: 'user/message',
      seq: 1,
      time: Date.now(),
      data: { source: { kind: 'user', rpcId: 'hub-mutation-0001' }, content: [{ type: 'text', text: 'from Hub' }] },
    }
    let prompted = false
    const success = <T>(rpcId: string, value: T) => ({ rpcId, result: { ok: true as const, value } })
    const api = {
      sessions: {
        list: async (request: { rpcId: string }) => success(request.rpcId, { items: [{
          sessionId: 'shared-session', updatedAt: Date.now(), running: false, blank: false, cwd: root,
        }] }),
        history: async (request: { rpcId: string }) => success(request.rpcId, {
          events: prompted ? [{ event }] : [], hasMore: false,
        }),
        prompt: async (request: { rpcId: string; payload: { content: Array<{ text?: string }> } }) => {
          calls.push({ surface: 'hub', text: request.payload.content[0]?.text ?? '' })
          prompted = true
          return success(request.rpcId, { accepted: true as const })
        },
      },
      host: {
        describe: async (request: { rpcId: string }) => success(request.rpcId, {
          version: '0.1.0-rc.5', cwd: root, attachedSessions: 1, canOpenPath: true,
        }),
      },
      settings: {
        describe: async (request: { rpcId: string }) => success(request.rpcId, {
          writable: true, hasDocument: true, namespaces: [],
        }),
      },
      events: {
        mux: (_request: unknown, signal: AbortSignal) => idle(signal),
        host: (_request: unknown, signal: AbortSignal) => idle(signal),
      },
      respond: async () => ({ accepted: true as const }),
    } as unknown as TestApiProxy

    calls.push({ surface: 'local-web', text: 'existing local action' })
    calls.push({ surface: 'desktop', text: 'existing desktop action' })

    let baselineResolve: (() => void) | undefined
    const baseline = new Promise<void>((resolve) => { baselineResolve = resolve })
    const bodies: HubEnvelopeBody[] = []
    const server = new HubConnectorServer(endpoint, secret, 'agent-boot-id-0001', {
      connected: () => baselineResolve?.(),
      body: (_runtimeId, body) => { bodies.push(body) },
      disconnected: () => undefined,
    })
    servers.push(server)
    await server.listen()
    const gateway = testGateway()
    const gatewayDispatch = vi.spyOn(gateway, 'dispatch').mockResolvedValue({
      ok: true,
      value: { manifests: ['dynamic-cordis-runner'] },
    } as never)
    const connector = new HubConnector(api, gateway, {
      ipcEndpoint: endpoint,
      secretFile,
      runtimeId: 'default',
      dshVersion: '0.1.0-rc.5',
      reconnectMaximumMs: 1_000,
    })
    const controller = new AbortController()
    const running = connector.run(controller.signal)
    await baseline

    await server.send('default', {
      type: 'capability.invoke',
      commandId: 'command-web-fetch-0001',
      runtimeId: 'default',
      capability: 'dsh.web',
      capabilityVersion: '1.0.0',
      operation: 'fetch',
      idempotencyKey: 'web-fetch-mutation-0001',
      payload: {
        clientMutationId: 'web-fetch-0001',
        method: 'POST',
        path: '/api/host.describe',
        headers: [['content-type', 'application/json']],
        body: JSON.stringify({
          type: 'client-request', rpcId: 'web-rpc-0001', method: 'host.describe', payload: {},
        }),
      },
    })
    await vi.waitFor(() => { expect(bodies).toContainEqual(expect.objectContaining({
      type: 'capability.result', commandId: 'command-web-fetch-0001', status: 'ok',
    })) })
    const webResult = bodies.find(body => body.type === 'capability.result'
      && body.commandId === 'command-web-fetch-0001')
    if (webResult?.type !== 'capability.result' || webResult.status !== 'ok'
      || typeof webResult.value !== 'object' || webResult.value === null) {
      throw new Error('official Web fetch result missing')
    }
    const webBody = JSON.parse(String((webResult.value as { body?: unknown }).body)) as Record<string, unknown>
    expect(webBody).toMatchObject({
      rpcId: 'web-rpc-0001',
      result: { ok: true, value: { version: '0.1.0-rc.5', cwd: root } },
    })

    await server.send('default', {
      type: 'capability.invoke',
      commandId: 'command-web-remote-0001',
      runtimeId: 'default',
      capability: 'dsh.web',
      capabilityVersion: '1.0.0',
      operation: 'fetch',
      idempotencyKey: 'web-remote-mutation-0001',
      payload: {
        clientMutationId: 'web-remote-0001',
        method: 'POST',
        path: '/api/dynamicCordisRunner/inventory',
        headers: [['content-type', 'application/json']],
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'web-remote-rpc-0001',
          method: 'dynamicCordisRunner/inventory',
          payload: { refresh: true },
        }),
      },
    })
    await vi.waitFor(() => { expect(bodies).toContainEqual(expect.objectContaining({
      type: 'capability.result', commandId: 'command-web-remote-0001', status: 'ok',
    })) })
    const remoteResult = bodies.find(body => body.type === 'capability.result'
      && body.commandId === 'command-web-remote-0001')
    if (remoteResult?.type !== 'capability.result' || remoteResult.status !== 'ok'
      || typeof remoteResult.value !== 'object' || remoteResult.value === null) {
      throw new Error('official Web Remote result missing')
    }
    expect(gatewayDispatch).toHaveBeenCalledWith(
      'dynamicCordisRunner/inventory',
      { refresh: true },
      expect.any(AbortSignal),
    )
    expect(JSON.parse(String((remoteResult.value as { body?: unknown }).body))).toMatchObject({
      rpcId: 'web-remote-rpc-0001',
      result: { ok: true, value: { manifests: ['dynamic-cordis-runner'] } },
    })

    gatewayDispatch.mockRejectedValueOnce(Object.assign(new Error('goal revision is stale'), { name: 'conflict' }))
    await server.send('default', {
      type: 'capability.invoke',
      commandId: 'command-web-goal-clear-0001',
      runtimeId: 'default',
      capability: 'dsh.web',
      capabilityVersion: '1.0.0',
      operation: 'fetch',
      idempotencyKey: 'web-goal-clear-mutation-0001',
      payload: {
        clientMutationId: 'web-goal-clear-0001',
        method: 'POST',
        path: '/api/goals/clear',
        headers: [['content-type', 'application/json']],
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'web-goal-clear-rpc-0001',
          method: 'goals/clear',
          payload: { args: { agentId: 'shared-session', ref: { id: 'goal-1', revision: 1 } } },
        }),
      },
    })
    await vi.waitFor(() => { expect(bodies).toContainEqual(expect.objectContaining({
      type: 'capability.result', commandId: 'command-web-goal-clear-0001', status: 'ok',
    })) })
    const clearResult = bodies.find(body => body.type === 'capability.result'
      && body.commandId === 'command-web-goal-clear-0001')
    if (clearResult?.type !== 'capability.result' || clearResult.status !== 'ok'
      || typeof clearResult.value !== 'object' || clearResult.value === null) {
      throw new Error('Goal clear Web result missing')
    }
    expect(JSON.parse(String((clearResult.value as { body?: unknown }).body))).toMatchObject({
      rpcId: 'web-goal-clear-rpc-0001',
      result: { ok: false, error: { code: 'internal', message: 'goal revision is stale' } },
    })

    await server.send('default', {
      type: 'capability.invoke',
      commandId: 'command-hub-000001',
      runtimeId: 'default',
      capability: 'dsh.sessions',
      capabilityVersion: '1.0.0',
      operation: 'message.append',
      idempotencyKey: 'hub-mutation-0001',
      payload: {
        clientMutationId: 'hub-mutation-0001',
        sessionId: 'shared-session',
        text: 'from Hub',
        attachments: [],
      },
    })
    await vi.waitFor(() =>{  expect(bodies).toContainEqual(expect.objectContaining({
      type: 'capability.result', commandId: 'command-hub-000001', status: 'ok',
    })) })
    expect(calls).toEqual([
      { surface: 'local-web', text: 'existing local action' },
      { surface: 'desktop', text: 'existing desktop action' },
      { surface: 'hub', text: 'from Hub' },
    ])

    controller.abort(new Error('test complete'))
    await running
  })

  it('reconciles a repeated session-create mutation without creating a second DSH session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hub-connector-create-'))
    roots.push(root)
    const endpoint = join(root, 'agent.sock')
    const secretFile = join(root, 'connector.secret')
    const secret = generateHubIpcSecret()
    await writeFile(secretFile, `${secret}\n`, { mode: 0o600 })
    await chmod(secretFile, 0o600)

    let createdSessionId: string | undefined
    let createCalls = 0
    const success = <T>(rpcId: string, value: T) => ({ rpcId, result: { ok: true as const, value } })
    const api = {
      sessions: {
        list: async (request: { rpcId: string }) => success(request.rpcId, {
          items: createdSessionId === undefined ? [] : [{
            sessionId: createdSessionId, updatedAt: Date.now(), running: false, blank: true, cwd: root,
          }],
        }),
        history: async (request: { rpcId: string }) => success(request.rpcId, { events: [], hasMore: false }),
        create: async (request: { rpcId: string; payload: { sessionId: string } }) => {
          createCalls += 1
          createdSessionId = request.payload.sessionId
          return success(request.rpcId, { sessionId: request.payload.sessionId })
        },
      },
      host: { describe: async (request: { rpcId: string }) => success(request.rpcId, {
        version: '0.1.0-rc.5', cwd: root, attachedSessions: 1, canOpenPath: true,
      }) },
      settings: { describe: async (request: { rpcId: string }) => success(request.rpcId, {
        writable: true, hasDocument: true, namespaces: [],
      }) },
      events: {
        mux: (_request: unknown, signal: AbortSignal) => idle(signal),
        host: (_request: unknown, signal: AbortSignal) => idle(signal),
      },
      respond: async () => ({ accepted: true as const }),
    } as unknown as TestApiProxy

    let baselineResolve: (() => void) | undefined
    const baseline = new Promise<void>((resolve) => { baselineResolve = resolve })
    const bodies: HubEnvelopeBody[] = []
    const server = new HubConnectorServer(endpoint, secret, 'agent-boot-id-create', {
      connected: () => baselineResolve?.(),
      body: (_runtimeId, body) => { bodies.push(body) },
      disconnected: () => undefined,
    })
    servers.push(server)
    await server.listen()
    const connector = new HubConnector(api, testGateway(), {
      ipcEndpoint: endpoint,
      secretFile,
      runtimeId: 'default',
      dshVersion: '0.1.0-rc.5',
      reconnectMaximumMs: 1_000,
    })
    const controller = new AbortController()
    const running = connector.run(controller.signal)
    await baseline

    const payload = { clientMutationId: 'create-mutation-0001' }
    for (const commandId of ['command-create-000001', 'command-create-000002']) {
      await server.send('default', {
        type: 'capability.invoke',
        commandId,
        runtimeId: 'default',
        capability: 'dsh.sessions',
        capabilityVersion: '1.0.0',
        operation: 'create',
        idempotencyKey: 'create-mutation-0001',
        payload,
      })
      await vi.waitFor(() => {
        expect(bodies).toContainEqual(expect.objectContaining({
          type: 'capability.result', commandId, status: 'ok',
        }))
      })
    }
    expect(createCalls).toBe(1)

    controller.abort(new Error('test complete'))
    await running
  })

  it('reopens ApiProxy streams on resync so a pending question is replayed', async ({ onTestFinished }) => {
    // Exercise the largest legal first backoff (999ms), rather than randomly
    // fitting reconnect + IPC authentication inside waitFor's 1000ms default.
    const jitter = vi.spyOn(Math, 'random').mockReturnValue(0.999)
    onTestFinished(() => { jitter.mockRestore() })
    const root = await mkdtemp(join(tmpdir(), 'dsh-hub-connector-resync-'))
    roots.push(root)
    const endpoint = join(root, 'agent.sock')
    const secretFile = join(root, 'connector.secret')
    const secret = generateHubIpcSecret()
    await writeFile(secretFile, `${secret}\n`, { mode: 0o600 })
    await chmod(secretFile, 0o600)

    const success = <T>(rpcId: string, value: T) => ({ rpcId, result: { ok: true as const, value } })
    let muxSubscriptions = 0
    const pendingQuestion = async function* (signal: AbortSignal) {
      muxSubscriptions += 1
      yield {
        rpcId: 'question-rpc-resync-0001',
        payload: {
          type: 'question/requested',
          sessionId: 'session-resync',
          questions: [{ id: 'continue', question: 'Continue?' }],
        },
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
    const api = {
      sessions: {
        list: async (request: { rpcId: string }) => success(request.rpcId, { items: [{
          sessionId: 'session-resync', updatedAt: Date.now(), running: true, blank: false, cwd: root,
        }] }),
        history: async (request: { rpcId: string }) => success(request.rpcId, { events: [], hasMore: false }),
      },
      host: { describe: async (request: { rpcId: string }) => success(request.rpcId, {
        version: '0.1.0-rc.5', cwd: root, attachedSessions: 1, canOpenPath: true,
      }) },
      settings: { describe: async (request: { rpcId: string }) => success(request.rpcId, {
        writable: true, hasDocument: true, namespaces: [],
      }) },
      events: {
        mux: (_request: unknown, signal: AbortSignal) => pendingQuestion(signal),
        host: (_request: unknown, signal: AbortSignal) => idle(signal),
      },
      respond: async () => ({ accepted: true as const }),
    } as unknown as TestApiProxy

    let connections = 0
    const bodies: HubEnvelopeBody[] = []
    const questionFrames = () => bodies.filter(body => body.type === 'stream.frame'
      && body.capability === 'dsh.web'
      && body.stream === 'mux'
      && typeof body.payload === 'object'
      && body.payload !== null
      && !Array.isArray(body.payload)
      && body.payload.method === 'question/requested')
    const firstQuestion = Promise.withResolvers<void>()
    const replayedQuestion = Promise.withResolvers<void>()
    const waitForDelivery = async (delivery: Promise<void>) => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([delivery, new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Pending question was not delivered within the reconnect budget')), 3000)
        })])
      } finally { clearTimeout(timeout) }
    }
    const server = new HubConnectorServer(endpoint, secret, 'agent-boot-id-resync', {
      connected: () => { connections += 1 },
      body: (_runtimeId, body) => {
        bodies.push(body)
        const count = questionFrames().length
        if (count === 1) firstQuestion.resolve()
        if (count >= 2) replayedQuestion.resolve()
      },
      disconnected: () => undefined,
    })
    servers.push(server)
    await server.listen()
    const connector = new HubConnector(api, testGateway(), {
      ipcEndpoint: endpoint,
      secretFile,
      runtimeId: 'default',
      dshVersion: '0.1.0-rc.5',
      reconnectMaximumMs: 1_000,
    })
    const controller = new AbortController()
    const running = connector.run(controller.signal)

    try {
      await waitForDelivery(firstQuestion.promise)
      expect(questionFrames()).toHaveLength(1)
      expect(await server.send('default', {
        type: 'runtime.resync-required', runtimeId: 'default', reason: 'retention-exceeded',
      })).toBe(true)
      await waitForDelivery(replayedQuestion.promise)
      expect(connections).toBeGreaterThanOrEqual(2)
      expect(muxSubscriptions).toBeGreaterThanOrEqual(2)
      expect(questionFrames().length).toBeGreaterThanOrEqual(2)
      expect(questionFrames()[1]).toMatchObject({
        payload: { rpcId: 'question-rpc-resync-0001', method: 'question/requested' },
      })
    } finally {
      controller.abort(new Error('test complete'))
      await running.catch(error => { if (error !== controller.signal.reason) throw error })
    }
  })
})
