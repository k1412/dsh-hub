import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateHubIdentity, HubMessageId, type HubEnvelopeBody } from '@k1412/dsh-hub-protocol'
import { HubNodeAgent } from '../src/agent.ts'
import { HubNodeAgentState, loadHubNodeAgentConfig } from '../src/state.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Node Agent private state', () => {
  it('creates owner-only identity, IPC secret, journal, and clears enrollment material', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hub-node-state-'))
    roots.push(root)
    const configPath = join(root, 'node-agent.json')
    const stateDirectory = join(root, 'state')
    const config = {
      hubUrl: 'https://hub.example.com',
      nodeId: 'node-a',
      accessClientId: 'node-token.access',
      accessClientSecret: 'service-token-secret-with-at-least-32-characters',
      enrollmentCode: 'enrollment-code-with-at-least-24-chars',
      hubPublicKey: generateHubIdentity().publicKey,
      stateDirectory,
      ipcEndpoint: join(stateDirectory, 'connector.sock'),
    }
    await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 })
    const state = await HubNodeAgentState.open(configPath)
    expect(state.identity.publicKey).toContain('PUBLIC KEY')
    expect(state.ipcSecret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect((await stat(join(stateDirectory, 'identity.json'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(stateDirectory, 'connector.secret'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(stateDirectory, 'agent.db'))).mode & 0o777).toBe(0o600)
    await state.clearEnrollmentCode()
    expect(JSON.parse(await readFile(configPath, 'utf8'))).not.toHaveProperty('enrollmentCode')
    state.close()
  })

  it('rejects a group-readable secret-bearing configuration', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'dsh-hub-node-state-'))
    roots.push(root)
    const configPath = join(root, 'node-agent.json')
    await writeFile(configPath, '{}\n', { mode: 0o640 })
    await expect(HubNodeAgentState.open(configPath)).rejects.toThrow(/owner-only/)
  })

  it('normalizes multiple managed profiles and rejects duplicate runtime or profile ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hub-node-profiles-'))
    roots.push(root)
    const configPath = join(root, 'node-agent.json')
    const stateDirectory = join(root, 'state')
    const base = {
      hubUrl: 'https://hub.example.com',
      nodeId: 'node-a',
      accessClientId: 'node-token.access',
      accessClientSecret: 'service-token-secret-with-at-least-32-characters',
      hubPublicKey: generateHubIdentity().publicKey,
      stateDirectory,
      ipcEndpoint: join(stateDirectory, 'connector.sock'),
    }
    const profiles = [
      {
        runtimeId: 'web', profileDirectory: join(root, 'profile-web'), profileName: 'web',
        dshExecutable: 'dsh', snapshotPaths: [join(root, 'sessions-web')],
      },
      {
        runtimeId: 'desktop', profileDirectory: join(root, 'profile-desktop'), profileName: 'desktop',
        dshExecutable: 'dsh', snapshotPaths: [],
      },
    ]
    await writeFile(configPath, `${JSON.stringify({ ...base, management: { profiles } })}\n`, { mode: 0o600 })
    const loaded = await loadHubNodeAgentConfig(configPath)
    expect(loaded.management?.profiles.map(profile => profile.runtimeId)).toEqual(['web', 'desktop'])
    expect(loaded.management?.profiles[0]?.profileDirectory).toBe(join(root, 'profile-web'))

    await writeFile(configPath, `${JSON.stringify({
      ...base,
      management: { profiles: [profiles[0], { ...profiles[1], runtimeId: 'web' }] },
    })}\n`, { mode: 0o600 })
    await expect(loadHubNodeAgentConfig(configPath)).rejects.toThrow(/runtime IDs must be unique/)

    await writeFile(configPath, `${JSON.stringify({
      ...base,
      management: { profiles: [profiles[0], { ...profiles[1], profileDirectory: profiles[0]?.profileDirectory }] },
    })}\n`, { mode: 0o600 })
    await expect(loadHubNodeAgentConfig(configPath)).rejects.toThrow(/profile directories must be unique/)
  })

  it('contains Connector callbacks at an exactly full durable outbox and retries runtime state after acknowledgement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-hub-node-pressure-'))
    roots.push(root)
    const configPath = join(root, 'node-agent.json')
    const stateDirectory = join(root, 'state')
    await writeFile(configPath, `${JSON.stringify({
      hubUrl: 'https://hub.example.com',
      nodeId: 'node-pressure',
      accessClientId: 'node-token.access',
      accessClientSecret: 'service-token-secret-with-at-least-32-characters',
      hubPublicKey: generateHubIdentity().publicKey,
      stateDirectory,
      ipcEndpoint: join(stateDirectory, 'connector.sock'),
    })}\n`, { mode: 0o600 })
    const state = await HubNodeAgentState.open(configPath)
    for (let index = 1; index <= 10_000; index += 1) {
      state.journal.enqueue(
        { type: 'transport.ack' },
        1_000 + index,
        HubMessageId(`node-pressure-${String(index).padStart(8, '0')}`),
      )
    }
    const agent = new HubNodeAgent({ state })
    const internal = agent as unknown as {
      connectorBody(body: HubEnvelopeBody): void
      connectorDisconnected(runtimeId: string): void
      drainDeferredConnectorBodies(): void
      drainPendingRuntimeStates(): void
    }
    expect(() => {
      internal.connectorBody({
        type: 'stream.frame',
        runtimeId: 'default',
        streamId: 'pressure-stream-0001',
        capability: 'dsh.sessions',
        stream: 'events',
        frameSequence: 1,
        payload: {},
      })
    }).not.toThrow()
    expect(() => {
      internal.connectorBody({
        type: 'stream.frame',
        runtimeId: 'default',
        streamId: 'interaction-stream-0001',
        capability: 'dsh.web',
        stream: 'mux',
        frameSequence: 2,
        payload: {
          type: 'server-request',
          rpcId: 'question-rpc-0001',
          method: 'question/requested',
          payload: {
            type: 'question/requested', sessionId: 'session-one',
            questions: [{ id: 'choice', question: 'Continue?' }],
          },
        },
      })
    }).not.toThrow()
    expect(() => { internal.connectorDisconnected('default') }).not.toThrow()
    expect(state.journal.outboundUsage().records).toBe(10_000)

    state.journal.acknowledgeOutbound(1)
    internal.drainDeferredConnectorBodies()
    expect(state.journal.pendingOutbound(10_000).at(-1)?.body).toMatchObject({
      type: 'stream.frame', capability: 'dsh.web', stream: 'mux',
      payload: { method: 'question/requested' },
    })

    state.journal.acknowledgeOutbound(2)
    internal.drainPendingRuntimeStates()
    expect(state.journal.pendingOutbound(10_000).at(-1)?.body).toEqual({
      type: 'runtime.goodbye', runtimeId: 'default', reason: 'connector-stopped',
    })
    state.close()
  }, 30_000)
})
