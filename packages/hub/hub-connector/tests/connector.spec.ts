import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { generateHubIpcSecret } from '@k1412/dsh-hub-node-ipc'
import { HubConnectorServer } from '../../hub-node-agent/src/ipc-server.ts'
import type { HubEnvelopeBody } from '@k1412/dsh-hub-protocol'
import { detectDshVersion, HubConnector } from '../src/index.ts'
import * as HubConnectorPlugin from '../src/index.ts'

const roots: string[] = []
const servers: HubConnectorServer[] = []
const contexts: Context[] = []

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

describe('Hub Connector coexistence', () => {
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
        mux: (_request: unknown, signal: AbortSignal) => idle(signal),
        host: (_request: unknown, signal: AbortSignal) => idle(signal),
      },
      respond: async () => ({ accepted: true as const }),
    } as unknown as ApiProxy

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
    } as unknown as ApiProxy

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
    const connector = new HubConnector(api, {
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
    } as unknown as ApiProxy

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
    const connector = new HubConnector(api, {
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
})
