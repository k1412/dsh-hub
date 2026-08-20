// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelEnrollment,
  createEnrollment,
  invoke,
  readFleet,
  readPerformance,
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
    version: '3.0.0',
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

  it('reads the bounded same-origin performance window', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({
      generatedAt: 2_000,
      sampleLimit: 2_048,
      summary: { requests: 1, errors: 0, timeouts: 0, p50Ms: 12, p95Ms: 12, maxMs: 12,
        dispatchP95Ms: 2, waitP95Ms: 10, responseBytes: 64, maxResponseBytes: 64 },
      targets: [],
    }))

    await expect(readPerformance()).resolves.toMatchObject({ sampleLimit: 2_048 })
    expect(fetch).toHaveBeenCalledWith('/hub/v1/performance', undefined)
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
        capabilityVersion: '3.0.0', operation: 'inventory', payload: {},
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

  it('uses the response status when an operator endpoint returns JSON null', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(null, 502))
    await expect(createEnrollment({
      nodeId: 'work-pc', displayName: 'Work PC', expiresInSeconds: 900,
    })).rejects.toThrow('HTTP 502')
  })

  it('does not expose an HTML edge response as a JSON parser exception', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('<!DOCTYPE html><title>Access denied</title>', {
      status: 403,
      headers: { 'Content-Type': 'text/html' },
    }))
    await expect(createEnrollment({
      nodeId: 'work-pc', displayName: 'Work PC', expiresInSeconds: 900,
    })).rejects.toThrow('请求在抵达 Hub 前失败（HTTP 403，返回内容不是 JSON）')
  })

  it('returns the authoritative command result even when best-effort redaction acknowledgement fails', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ command: { commandId: 'command-3', status: 'pending' } }))
      .mockResolvedValueOnce(json({ command: { commandId: 'command-3', status: 'ok', result: { plugins: [] } } }))
      .mockRejectedValueOnce(new TypeError('network changed'))

    await expect(invoke(runtime, 'dsh.plugins', 'inventory', {})).resolves.toEqual({ plugins: [] })
  })
})
