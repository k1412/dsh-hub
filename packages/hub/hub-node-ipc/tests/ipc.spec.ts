import { describe, expect, it } from 'vitest'
import {
  createHubIpcProof, encodeHubIpcFrame, generateHubIpcSecret, HubIpcFrameDecoder,
  verifyHubIpcProof,
} from '../src/index.ts'

describe('Hub node IPC', () => {
  it('authenticates a challenge without transmitting the shared secret', () => {
    const secret = generateHubIpcSecret()
    const frame = {
      type: 'ipc.proof' as const,
      challenge: 'challenge-000000001',
      runtimeId: 'default-runtime',
      runtimeBootId: 'runtime-boot-00001',
      connectorVersion: '1.0.0',
      dshVersion: '0.1.0-rc.5',
      capabilities: [],
      proof: createHubIpcProof(
        secret, 'challenge-000000001', 'default-runtime', 'runtime-boot-00001', '1.0.0',
      ),
    }
    expect(verifyHubIpcProof(secret, frame)).toBe(true)
    expect(verifyHubIpcProof(generateHubIpcSecret(), frame)).toBe(false)
    expect(JSON.stringify(frame)).not.toContain(secret)
  })

  it('decodes fragmented and coalesced length-prefixed frames', () => {
    const first = encodeHubIpcFrame({ type: 'ipc.heartbeat', timestamp: 1 })
    const second = encodeHubIpcFrame({ type: 'ipc.heartbeat', timestamp: 2 })
    const decoder = new HubIpcFrameDecoder()
    expect(decoder.push(first.subarray(0, 3))).toEqual([])
    expect(decoder.push(Buffer.concat([first.subarray(3), second]))).toEqual([
      { type: 'ipc.heartbeat', timestamp: 1 },
      { type: 'ipc.heartbeat', timestamp: 2 },
    ])
  })

  it('rejects oversized declared lengths before buffering a payload', () => {
    const bytes = Buffer.alloc(4)
    bytes.writeUInt32BE(4 * 1024 * 1024 + 1)
    expect(() => new HubIpcFrameDecoder().push(bytes)).toThrow(/maximum/)
  })
})
