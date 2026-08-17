import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webCapability } from '@k1412/dsh-hub-capabilities'
import { generateHubIdentity, HubCommandId, HubNodeId, HubRuntimeId } from '@k1412/dsh-hub-protocol'
import { HubStorage } from '@k1412/dsh-hub-storage'
import type { HubAccessVerifier } from '../src/server.ts'
import { HubOriginGuard } from '../src/auth.ts'
import { decodeFleetId } from '../src/fleet-web.ts'
import { HubServer } from '../src/server.ts'

const roots: string[] = []
const servers: HubServer[] = []
const originSecret = 'test-private-origin-secret-at-least-32-chars'

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map(server => server.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const access: HubAccessVerifier = {
  async verifyHuman(headers) {
    if (headers.authorization !== 'human') throw new Error('not a human')
    return { kind: 'human', email: 'operator@example.com', subject: 'subject', expiresAt: Math.floor(Date.now() / 1_000) + 60 }
  },
  async verifyService(headers) {
    if (headers.authorization !== 'service') throw new Error('not a service')
    return { kind: 'service', commonName: 'node-token.access', expiresAt: Math.floor(Date.now() / 1_000) + 60 }
  },
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hub-server-'))
  roots.push(root)
  const storage = await HubStorage.open(join(root, 'hub.db'))
  const server = new HubServer({
    storage,
    access,
    originGuard: new HubOriginGuard(originSecret),
    hubIdentity: generateHubIdentity(),
    publicOrigin: 'https://hub.example.com',
  })
  servers.push(server)
  const address = await server.listen('127.0.0.1', 0)
  return { storage, base: `http://127.0.0.1:${String(address.port)}` }
}

function requestHeaders(kind: 'human' | 'service', mutation = false): Record<string, string> {
  return {
    authorization: kind,
    'x-dsh-origin-secret': originSecret,
    ...(mutation ? { origin: 'https://hub.example.com', 'content-type': 'application/json' } : {}),
  }
}

describe('Hub HTTP server', () => {
  it('hides the origin without its proxy-held secret and serves an internal health check with it', async () => {
    const { base } = await fixture()
    expect((await fetch(`${base}/healthz`)).status).toBe(404)
    const response = await fetch(`${base}/healthz`, { headers: { 'x-dsh-origin-secret': originSecret } })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('separates service bootstrap from human operator routes', async () => {
    const { base } = await fixture()
    const bootstrap = await fetch(`${base}/hub/v1/bootstrap`, { headers: requestHeaders('service') })
    expect(bootstrap.status).toBe(200)
    const bootstrapBody = await bootstrap.json() as {
      protocolVersion?: unknown
      serviceIdentity?: unknown
      hubPublicKey?: unknown
    }
    expect(bootstrapBody).toMatchObject({
      protocolVersion: 1,
      serviceIdentity: 'node-token.access',
    })
    expect(bootstrapBody.hubPublicKey).toEqual(expect.stringContaining('PUBLIC KEY'))
    const me = await fetch(`${base}/hub/v1/me`, { headers: requestHeaders('human') })
    expect(me.status).toBe(200)
    await expect(me.json()).resolves.toMatchObject({ email: 'operator@example.com' })
  })

  it('routes an empty fleet to the authenticated enrollment gate', async () => {
    const { base } = await fixture()
    const response = await fetch(`${base}/`, {
      headers: requestHeaders('human'),
      redirect: 'manual',
    })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/setup.html')
  })

  it('requires exact same-origin JSON mutations and returns an enrollment secret only once', async () => {
    const { base, storage } = await fixture()
    const body = JSON.stringify({ nodeId: 'node-a', displayName: 'Node A', expiresInSeconds: 900 })
    const rejected = await fetch(`${base}/hub/v1/enrollments`, {
      method: 'POST',
      headers: { ...requestHeaders('human'), 'content-type': 'application/json' },
      body,
    })
    expect(rejected.status).toBe(403)

    const accepted = await fetch(`${base}/hub/v1/enrollments`, {
      method: 'POST',
      headers: requestHeaders('human', true),
      body,
    })
    expect(accepted.status).toBe(201)
    const grant = await accepted.json() as { code: string; nodeId: string }
    expect(grant.nodeId).toBe('node-a')
    expect(typeof grant.code).toBe('string')
    expect(storage.control.listNodes()).toEqual([])

    const pending = await fetch(`${base}/hub/v1/enrollments`, { headers: requestHeaders('human') })
    await expect(pending.json()).resolves.toMatchObject({
      enrollments: [{ nodeId: 'node-a', displayName: 'Node A' }],
    })

    const cancelled = await fetch(`${base}/hub/v1/enrollments/node-a/cancel`, {
      method: 'POST', headers: requestHeaders('human', true), body: '{}',
    })
    expect(cancelled.status).toBe(200)
    expect(storage.control.listPendingEnrollments()).toEqual([])

    const nodes = await fetch(`${base}/hub/v1/nodes`, { headers: requestHeaders('human') })
    await expect(nodes.json()).resolves.toEqual({ nodes: [], runtimes: [] })
  })

  it('returns project paths from the minimal session index without session content', async () => {
    const { base, storage } = await fixture()
    const grant = storage.control.createEnrollment(HubNodeId('node-project'), 'Project Node', Date.now() + 60_000)
    const node = storage.control.consumeEnrollment(grant.code, 'public-key', 'service-id')
    const runtimeId = HubRuntimeId('web')
    storage.control.upsertRuntime({
      nodeId: node.nodeId,
      runtimeId,
      bootId: 'runtime-boot-project',
      dshVersion: '0.1.0',
      connectorVersion: '0.1.0',
      capabilities: [],
      online: true,
      lastSeenAt: 1_000,
    })
    storage.control.upsertSessionIndex({
      hubSessionId: 'hub-project-session',
      nodeId: node.nodeId,
      runtimeId,
      sourceId: 'source-project-session',
      title: 'Indexed title',
      workspacePath: '/workspace/project',
      updatedAt: 1_001,
      running: false,
      stale: false,
    })

    const response = await fetch(`${base}/hub/v1/sessions`, { headers: requestHeaders('human') })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ sessions: [{
      hubSessionId: 'hub-project-session',
      nodeId: 'node-project',
      runtimeId: 'web',
      sourceId: 'source-project-session',
      title: 'Indexed title',
      workspacePath: '/workspace/project',
      updatedAt: 1_001,
      running: false,
      stale: false,
    }] })
  })

  it('keeps cached project groups and sessions visible while their node is offline', async () => {
    const { base, storage } = await fixture()
    const grant = storage.control.createEnrollment(HubNodeId('offline-node'), 'Home Mac', Date.now() + 60_000)
    const node = storage.control.consumeEnrollment(grant.code, 'offline-public-key', 'offline-service')
    const runtimeId = HubRuntimeId('default')
    storage.control.upsertRuntime({
      nodeId: node.nodeId,
      runtimeId,
      bootId: 'offline-runtime-boot',
      dshVersion: '0.1.0-rc.9',
      connectorVersion: '0.1.0-rc.9',
      capabilities: [webCapability.descriptor] as never,
      online: false,
      lastSeenAt: 1_000,
    })
    storage.control.upsertSessionIndex({
      hubSessionId: 'offline-hub-session',
      nodeId: node.nodeId,
      runtimeId,
      sourceId: 'offline-source-session',
      title: 'Preserved session',
      workspacePath: '/Users/wuyang/Code/project',
      updatedAt: 2_000,
      running: true,
      stale: true,
    })

    const sessionResponse = await fetch(`${base}/api/session.list`, {
      method: 'POST',
      headers: requestHeaders('human', true),
      body: JSON.stringify({
        type: 'client-request', rpcId: 'offline-sessions', method: 'session.list', payload: {},
      }),
    })
    expect(sessionResponse.status).toBe(200)
    const sessionBody = await sessionResponse.json() as {
      result: { value: { items: Array<{ sessionId: string; running: boolean; projections: unknown }> } }
    }
    expect(sessionBody.result.value.items).toMatchObject([{
      running: false,
      projections: { values: { title: 'Preserved session' } },
    }])
    expect(decodeFleetId(sessionBody.result.value.items[0]?.sessionId ?? '')).toMatchObject({
      nodeId: 'offline-node', runtimeId: 'default', sourceId: 'offline-source-session',
    })

    const workspaceResponse = await fetch(`${base}/api/workspace.list`, {
      method: 'POST',
      headers: requestHeaders('human', true),
      body: JSON.stringify({
        type: 'client-request', rpcId: 'offline-workspaces', method: 'workspace.list', payload: {},
      }),
    })
    expect(workspaceResponse.status).toBe(200)
    await expect(workspaceResponse.json()).resolves.toMatchObject({
      result: { value: { items: [{
        path: '/Users/wuyang/Code/project',
        title: 'project · Home Mac（离线）',
      }] } },
    })
  })

  it('aggregates official sessions across Runtimes and routes a selected session back to its owner', async () => {
    const { base, storage } = await fixture()
    const targets = [
      { nodeId: HubNodeId('desktop-node'), runtimeId: HubRuntimeId('web'), displayName: 'Desktop' },
      { nodeId: HubNodeId('nas-node'), runtimeId: HubRuntimeId('web'), displayName: 'NAS' },
    ]
    for (const [index, target] of targets.entries()) {
      const grant = storage.control.createEnrollment(target.nodeId, target.displayName, Date.now() + 60_000)
      storage.control.consumeEnrollment(grant.code, `public-key-${String(index)}`, `service-${String(index)}`)
      storage.control.upsertRuntime({
        nodeId: target.nodeId,
        runtimeId: target.runtimeId,
        bootId: `runtime-boot-${String(index)}`,
        dshVersion: '0.1.0-rc.5',
        connectorVersion: '0.1.0-rc.5',
        capabilities: [webCapability.descriptor] as never,
        online: true,
        lastSeenAt: Date.now(),
      })
    }

    const server = servers.at(-1)
    if (server === undefined) throw new Error('fixture server missing')
    vi.spyOn(server.agents, 'isOnline').mockReturnValue(true)
    const invocations: Array<{ nodeId: string; runtimeId: string; rpcMethod: string; payload: unknown }> = []
    let sequence = 0
    vi.spyOn(server.agents, 'invoke').mockImplementation(async (
      nodeId, runtimeId, capability, capabilityVersion, operation, payload,
    ) => {
      sequence += 1
      const request = payload as { body?: string }
      const rpc = JSON.parse(request.body ?? '{}') as { rpcId?: string; method?: string; payload?: unknown }
      invocations.push({ nodeId, runtimeId, rpcMethod: rpc.method ?? '', payload: rpc.payload })
      const sourceSessionId = nodeId === 'desktop-node' ? 'desktop-session' : 'nas-session'
      let value: unknown
      if (rpc.method === 'session.list') {
        value = { items: [{
          sessionId: sourceSessionId,
          cwd: nodeId === 'desktop-node' ? '/Users/wuyang/project' : '/mnt/user/project',
          updatedAt: nodeId === 'desktop-node' ? 1_000 : 2_000,
          running: false,
          blank: false,
        }] }
      } else if (rpc.method === 'session.search') {
        value = {
          items: [
            { sessionId: `${sourceSessionId}-match-one`, snippet: 'first match' },
            { sessionId: `${sourceSessionId}-match-two`, snippet: 'second match' },
          ],
          hasMore: false,
        }
      } else if (rpc.method === 'workspace.list') {
        value = {
          items: [{
            workspaceId: `${nodeId}-workspace`,
            path: nodeId === 'desktop-node' ? '/Users/wuyang/project' : '/mnt/user/project',
            title: 'Project',
            sessionIds: [sourceSessionId],
            updatedAt: new Date(1_000).toISOString(),
          }],
          archivedSessionIds: [`${nodeId}-archived`],
        }
      } else if (rpc.method === 'workspace.insertBefore') {
        value = { workspaceIds: [`${nodeId}-workspace`] }
      } else if (rpc.method === 'workspace.archiveSession') {
        value = { archivedSessionIds: [`${nodeId}-archived`, sourceSessionId] }
      } else {
        value = { events: [], hasMore: false, sessionId: sourceSessionId }
      }
      const command = storage.control.createCommand({
        commandId: HubCommandId(`fleet-command-${String(sequence).padStart(4, '0')}`),
        nodeId,
        runtimeId,
        capability,
        capabilityVersion,
        operation,
        idempotency: 'read',
        payload: payload as never,
        createdAt: Date.now(),
      })
      storage.control.transitionCommand(command.commandId, 'sent', undefined)
      storage.control.transitionCommand(command.commandId, 'ok', {
        status: 200,
        headers: [['content-type', 'application/json; charset=utf-8']],
        encoding: 'utf8',
        body: JSON.stringify({
          type: 'server-response',
          rpcId: rpc.rpcId,
          result: { ok: true, value },
        }),
      })
      return storage.control.getCommand(command.commandId) as typeof command
    })

    const listResponse = await fetch(`${base}/api/session.list`, {
      method: 'POST',
      headers: requestHeaders('human', true),
      body: JSON.stringify({
        type: 'client-request', rpcId: 'fleet-list', method: 'session.list', payload: {},
      }),
    })
    expect(listResponse.status).toBe(200)
    const listBody = await listResponse.json() as {
      result: { value: { items: Array<{ sessionId: string; updatedAt: number }> } }
    }
    expect(listBody.result.value.items).toHaveLength(2)
    expect(listBody.result.value.items.map(item => item.updatedAt)).toEqual([2_000, 1_000])
    expect(invocations.map(call => `${call.nodeId}/${call.runtimeId}`)).toEqual([
      'desktop-node/web', 'nas-node/web',
    ])

    const searchResponse = await fetch(`${base}/api/session.search`, {
      method: 'POST',
      headers: requestHeaders('human', true),
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'fleet-search',
        method: 'session.search',
        payload: { query: 'match' },
      }),
    })
    expect(searchResponse.status).toBe(200)
    const searchBody = await searchResponse.json() as {
      result: { value: { items: Array<{ sessionId: string }> } }
    }
    expect(searchBody.result.value.items.map(item => decodeFleetId(item.sessionId)?.nodeId)).toEqual([
      'desktop-node', 'nas-node', 'desktop-node', 'nas-node',
    ])

    const nasSessionId = listBody.result.value.items[0]?.sessionId
    if (nasSessionId === undefined) throw new Error('aggregated NAS session missing')
    expect(decodeFleetId(nasSessionId)).toEqual({
      kind: 'session', nodeId: 'nas-node', runtimeId: 'web', sourceId: 'nas-session',
    })
    invocations.length = 0
    const historyResponse = await fetch(`${base}/api/session.history`, {
      method: 'POST',
      headers: requestHeaders('human', true),
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'fleet-history',
        method: 'session.history',
        payload: { sessionId: nasSessionId },
      }),
    })
    expect(historyResponse.status).toBe(200)
    expect(invocations).toEqual([{
      nodeId: 'nas-node',
      runtimeId: 'web',
      rpcMethod: 'session.history',
      payload: { sessionId: 'nas-session' },
    }])

    invocations.length = 0
    const pauseGoalResponse = await fetch(`${base}/api/goals/pause`, {
      method: 'POST',
      headers: requestHeaders('human', true),
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'fleet-goal-pause',
        method: 'goals/pause',
        payload: { sessionId: nasSessionId },
      }),
    })
    expect(pauseGoalResponse.status).toBe(200)
    expect(invocations).toEqual([{
      nodeId: 'nas-node',
      runtimeId: 'web',
      rpcMethod: 'goals/pause',
      payload: { sessionId: 'nas-session' },
    }])

    const workspaceResponse = await fetch(`${base}/api/workspace.list`, {
      method: 'POST',
      headers: requestHeaders('human', true),
      body: JSON.stringify({
        type: 'client-request', rpcId: 'fleet-workspaces', method: 'workspace.list', payload: {},
      }),
    })
    expect(workspaceResponse.status).toBe(200)
    const workspaceBody = await workspaceResponse.json() as {
      result: { value: {
        items: Array<{ workspaceId: string; title: string }>
        archivedSessionIds: string[]
      } }
    }
    expect(workspaceBody.result.value.items.map(item => item.title)).toEqual([
      'Project · Desktop', 'Project · NAS',
    ])
    expect(workspaceBody.result.value.archivedSessionIds.map(id => decodeFleetId(id)?.sourceId)).toEqual([
      'desktop-node-archived', 'nas-node-archived',
    ])

    const nasWorkspaceId = workspaceBody.result.value.items.find(item =>
      decodeFleetId(item.workspaceId)?.nodeId === 'nas-node')?.workspaceId
    if (nasWorkspaceId === undefined) throw new Error('aggregated NAS workspace missing')
    const reorderResponse = await fetch(`${base}/api/workspace.insertBefore`, {
      method: 'POST',
      headers: requestHeaders('human', true),
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'fleet-workspace-order',
        method: 'workspace.insertBefore',
        payload: { workspaceId: nasWorkspaceId },
      }),
    })
    expect(reorderResponse.status).toBe(200)
    const reorderBody = await reorderResponse.json() as {
      result: { value: { workspaceIds: string[] } }
    }
    expect(reorderBody.result.value.workspaceIds.map(id => decodeFleetId(id)?.sourceId)).toEqual([
      'desktop-node-workspace', 'nas-node-workspace',
    ])

    const archiveResponse = await fetch(`${base}/api/workspace.archiveSession`, {
      method: 'POST',
      headers: requestHeaders('human', true),
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'fleet-archive',
        method: 'workspace.archiveSession',
        payload: { sessionId: nasSessionId },
      }),
    })
    expect(archiveResponse.status).toBe(200)
    const archiveBody = await archiveResponse.json() as {
      result: { value: { archivedSessionIds: string[] } }
    }
    expect(archiveBody.result.value.archivedSessionIds.map(id => decodeFleetId(id)?.sourceId)).toEqual([
      'desktop-node-archived', 'nas-node-archived', 'nas-session',
    ])
  })

  it('returns audit history and redacts a completed command after explicit acknowledgement', async () => {
    const { base, storage } = await fixture()
    const grant = storage.control.createEnrollment(
      HubNodeId('node-command'), 'Command Node', Date.now() + 60_000,
    )
    const node = storage.control.consumeEnrollment(grant.code, 'public-key', 'service-id')
    const command = storage.control.createCommand({
      commandId: 'command-sensitive-0001',
      nodeId: node.nodeId,
      capability: 'dsh.files',
      capabilityVersion: '1.0.0',
      operation: 'read',
      idempotency: 'read',
      payload: { path: '/private/workspace/file.txt' },
      createdAt: Date.now(),
    })
    storage.control.transitionCommand(command.commandId, 'error', { message: 'one-time result' })
    storage.control.appendAudit({
      occurredAt: Date.now(),
      actor: 'human:operator@example.com',
      action: 'command.created',
      nodeId: node.nodeId,
      resourceId: command.commandId,
      outcome: 'error',
      details: { capability: 'dsh.files', operation: 'read' },
    })

    const list = await fetch(`${base}/hub/v1/commands`, { headers: requestHeaders('human') })
    const listBody = await list.json() as { commands: Array<Record<string, unknown>> }
    expect(listBody.commands[0]).not.toHaveProperty('payload')
    expect(listBody.commands[0]).not.toHaveProperty('result')
    const audit = await fetch(`${base}/hub/v1/audit`, { headers: requestHeaders('human') })
    await expect(audit.json()).resolves.toMatchObject({ records: [{ action: 'command.created' }] })

    const result = await fetch(`${base}/hub/v1/commands/${command.commandId}`, {
      headers: requestHeaders('human'),
    })
    await expect(result.json()).resolves.toMatchObject({ command: { result: { message: 'one-time result' } } })
    expect(storage.control.getCommand(command.commandId)).toMatchObject({
      payload: { path: '/private/workspace/file.txt' }, result: { message: 'one-time result' },
    })
    const acknowledged = await fetch(`${base}/hub/v1/commands/${command.commandId}`, {
      method: 'POST', headers: requestHeaders('human', true), body: '{}',
    })
    expect(acknowledged.status).toBe(200)
    expect(storage.control.getCommand(command.commandId)).toMatchObject({ payload: null })
    expect(storage.control.getCommand(command.commandId)?.result).toBeUndefined()
  })
})
