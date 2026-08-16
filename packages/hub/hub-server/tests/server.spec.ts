import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateHubIdentity, HubNodeId, HubRuntimeId } from '@k1412/dsh-hub-protocol'
import { HubStorage } from '@k1412/dsh-hub-storage'
import type { HubAccessVerifier } from '../src/server.ts'
import { HubOriginGuard } from '../src/auth.ts'
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
