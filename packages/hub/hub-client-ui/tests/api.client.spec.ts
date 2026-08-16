// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelEnrollment,
  createEnrollment,
  invoke,
  readFleet,
  revokeNode,
  type HubRuntime,
} from '../src/client/api.ts'

const runtime: HubRuntime = {
  nodeId: 'nas-home',
  runtimeId: 'web',
  dshVersion: '0.1.0-rc.5',
  connectorVersion: '0.1.0-rc.5',
  online: true,
  lastSeenAt: 1_000,
  capabilities: [{
    name: 'dsh.plugins',
    version: '2.0.0',
    operations: [{ name: 'inventory' }],
  }],
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Hub settings operator API', () => {
  it('combines the node and pending-enrollment baselines', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ nodes: [{ nodeId: 'nas-home' }], runtimes: [runtime] }))
      .mockResolvedValueOnce(json({ enrollments: [{ nodeId: 'mac-home' }] }))

    await expect(readFleet()).resolves.toEqual({
      nodes: [{ nodeId: 'nas-home' }],
      runtimes: [runtime],
      enrollments: [{ nodeId: 'mac-home' }],
    })
    expect(fetch).toHaveBeenNthCalledWith(1, '/hub/v1/nodes', undefined)
    expect(fetch).toHaveBeenNthCalledWith(2, '/hub/v1/enrollments', undefined)
  })

  it('uses explicit same-origin mutation routes for enrollment cancellation and revocation', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ nodeId: 'work-pc', code: 'one-time-code' }))
      .mockResolvedValueOnce(json({ ok: true }))
      .mockResolvedValueOnce(json({ ok: true }))

    await expect(createEnrollment({
      nodeId: 'work-pc', displayName: 'Work PC', expiresInSeconds: 900,
    })).resolves.toMatchObject({ code: 'one-time-code' })
    await cancelEnrollment('mac/home')
    await revokeNode('nas home')

    expect(fetch).toHaveBeenNthCalledWith(1, '/hub/v1/enrollments', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ nodeId: 'work-pc', displayName: 'Work PC', expiresInSeconds: 900 }),
    }))
    expect(fetch).toHaveBeenNthCalledWith(2, '/hub/v1/enrollments/mac%2Fhome/cancel', expect.objectContaining({ method: 'POST' }))
    expect(fetch).toHaveBeenNthCalledWith(3, '/hub/v1/nodes/nas%20home/revoke', expect.objectContaining({ method: 'POST' }))
  })

  it('creates, polls, acknowledges, and returns a successful node command', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ command: { commandId: 'command-1', status: 'pending' } }))
      .mockResolvedValueOnce(json({ command: { commandId: 'command-1', status: 'ok', result: { plugins: [] } } }))
      .mockResolvedValueOnce(json({ ok: true }))

    await expect(invoke(runtime, 'dsh.plugins', 'inventory', {})).resolves.toEqual({ plugins: [] })
    expect(fetch).toHaveBeenNthCalledWith(1, '/hub/v1/commands', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        nodeId: 'nas-home', runtimeId: 'web', capability: 'dsh.plugins',
        capabilityVersion: '2.0.0', operation: 'inventory', payload: {},
      }),
    }))
    expect(fetch).toHaveBeenNthCalledWith(2, '/hub/v1/commands/command-1', undefined)
    expect(fetch).toHaveBeenNthCalledWith(3, '/hub/v1/commands/command-1', expect.objectContaining({ method: 'POST' }))
  })

  it('surfaces node errors, acknowledges them, and rejects unsupported operations before a request', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ command: { commandId: 'command-2', status: 'pending' } }))
      .mockResolvedValueOnce(json({ command: {
        commandId: 'command-2', status: 'error', result: { message: 'plugin transaction failed' },
      } }))
      .mockResolvedValueOnce(json({ ok: true }))

    await expect(invoke(runtime, 'dsh.plugins', 'inventory', {})).rejects.toThrow('plugin transaction failed')
    expect(fetch).toHaveBeenLastCalledWith('/hub/v1/commands/command-2', expect.objectContaining({ method: 'POST' }))

    vi.mocked(fetch).mockClear()
    await expect(invoke(runtime, 'dsh.plugins', 'rollback', {})).rejects.toThrow(
      '节点不支持 dsh.plugins.rollback',
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses the response status when an operator endpoint returns a non-string error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ error: { code: 'denied' } }, 403))
    await expect(createEnrollment({
      nodeId: 'work-pc', displayName: 'Work PC', expiresInSeconds: 900,
    })).rejects.toThrow('HTTP 403')
  })
})
