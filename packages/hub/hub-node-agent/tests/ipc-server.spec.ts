import { connect, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hubCapabilityContracts } from '@k1412/dsh-hub-capabilities'
import {
  createHubIpcProof, encodeHubIpcFrame, generateHubIpcSecret, HubIpcFrameDecoder,
  type HubIpcFrame,
} from '@k1412/dsh-hub-node-ipc'
import { HubConnectorServer } from '../src/ipc-server.ts'

const roots: string[] = []
const servers: HubConnectorServer[] = []
const sockets: Socket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  await Promise.allSettled(servers.splice(0).map(server => server.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function frameReader(socket: Socket) {
  const decoder = new HubIpcFrameDecoder()
  const waiting: Array<(frame: HubIpcFrame) => void> = []
  const frames: HubIpcFrame[] = []
  socket.on('data', (chunk) => {
    for (const frame of decoder.push(chunk)) {
      const resolve = waiting.shift()
      if (resolve === undefined) frames.push(frame)
      else resolve(frame)
    }
  })
  return () => frames.shift() ?? new Promise<HubIpcFrame>(resolve => waiting.push(resolve))
}

describe('Node Agent Connector IPC server', () => {
  it('authenticates, registers, forwards strict bodies, and removes a disconnected runtime', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'dsh-hub-node-ipc-'))
    roots.push(root)
    const endpoint = join(root, 'private', 'connector.sock')
    const secret = generateHubIpcSecret()
    const connected = vi.fn()
    const body = vi.fn()
    const disconnected = vi.fn()
    const server = new HubConnectorServer(endpoint, secret, 'agent-boot-000001', {
      connected,
      body,
      disconnected,
    })
    servers.push(server)
    await server.listen()
    const socket = connect(endpoint)
    sockets.push(socket)
    const nextFrame = frameReader(socket)
    const challenge = await nextFrame()
    expect(challenge.type).toBe('ipc.challenge')
    if (challenge.type !== 'ipc.challenge') throw new Error('unexpected challenge')
    const proof = {
      type: 'ipc.proof' as const,
      challenge: challenge.challenge,
      runtimeId: 'default-runtime',
      runtimeBootId: 'runtime-boot-00001',
      connectorVersion: '1.0.0',
      dshVersion: '0.1.0-rc.5',
      capabilities: hubCapabilityContracts.map(contract => contract.descriptor),
      proof: createHubIpcProof(
        secret, challenge.challenge, 'default-runtime', 'runtime-boot-00001', '1.0.0',
      ),
    }
    socket.write(encodeHubIpcFrame(proof))
    await expect(nextFrame()).resolves.toMatchObject({
      type: 'ipc.accepted', challenge: challenge.challenge, agentBootId: 'agent-boot-000001',
    })
    expect(connected).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: 'default-runtime' }))
    socket.write(encodeHubIpcFrame({
      type: 'ipc.hub-body',
      body: { type: 'runtime.resync-required', runtimeId: 'default-runtime', reason: 'operator-request' },
    }))
    await vi.waitFor(() =>{  expect(body).toHaveBeenCalledWith('default-runtime', expect.objectContaining({
      type: 'runtime.resync-required',
    })) })
    expect(server.baselines()).toHaveLength(1)
    socket.destroy()
    await vi.waitFor(() =>{  expect(disconnected).toHaveBeenCalledWith('default-runtime') })
  })
})
