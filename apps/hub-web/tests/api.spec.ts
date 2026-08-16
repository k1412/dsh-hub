import { afterEach, describe, expect, it, vi } from 'vitest'
import { conversation, invoke } from '../src/api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Hub conversation projection', () => {
  it('keeps user and assistant messages while ignoring operational records', () => {
    expect(conversation([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant/message', seq: 2, time: 3, data: { content: [{ type: 'text', text: 'world' }] } },
    ])).toEqual([
      { id: '1', role: 'user', text: 'hello', time: 2 },
      { id: '2', role: 'assistant', text: 'world', time: 3 },
    ])
  })
})

describe('Hub browser capability client', () => {
  it('routes a directory listing through the advertised node capability and acknowledges the result', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      requests.push({ path, ...(init === undefined ? {} : { init }) })
      if (path === '/hub/v1/nodes') return Response.json({
        nodes: [{ nodeId: 'work', displayName: 'Work', status: 'active', online: true }],
        runtimes: [{
          nodeId: 'work', runtimeId: 'web', dshVersion: '0.1.0', connectorVersion: '0.1.0', online: true,
          capabilities: [{ name: 'dsh.files', version: '1.0.0', operations: [{ name: 'list' }] }],
        }],
      })
      if (path === '/hub/v1/sessions') return Response.json({ sessions: [] })
      if (path === '/hub/v1/commands' && init?.method === 'POST') {
        return Response.json({ command: { commandId: 'command-directory', status: 'pending' } }, { status: 201 })
      }
      if (path === '/hub/v1/commands/command-directory' && init?.method !== 'POST') {
        return Response.json({ command: {
          commandId: 'command-directory', status: 'ok',
          result: { entries: [{ path: '/workspace/project', kind: 'directory' }] },
        } })
      }
      if (path === '/hub/v1/commands/command-directory' && init?.method === 'POST') {
        return Response.json({ acknowledged: true })
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 })
    }))

    await expect(invoke({
      nodeId: 'work', runtimeId: 'web', capability: 'dsh.files', operation: 'list',
      payload: { path: '/workspace', limit: 500 },
    })).resolves.toMatchObject({
      status: 'ok', result: { entries: [{ path: '/workspace/project', kind: 'directory' }] },
    })
    const create = requests.find(request => request.path === '/hub/v1/commands')?.init
    if (typeof create?.body !== 'string') throw new Error('command request body was not JSON text')
    expect(JSON.parse(create.body)).toEqual({
      nodeId: 'work', runtimeId: 'web', capability: 'dsh.files', operation: 'list',
      capabilityVersion: '1.0.0', payload: { path: '/workspace', limit: 500 },
    })
    expect(requests.at(-1)).toMatchObject({ path: '/hub/v1/commands/command-directory', init: { method: 'POST' } })
  })
})
