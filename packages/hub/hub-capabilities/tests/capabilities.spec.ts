import { describe, expect, it } from 'vitest'
import { negotiateHubCapabilities } from '@k1412/dsh-hub-protocol'
import {
  hubCapabilityContracts, resolveHubOperation, resolveHubStream, sessionsCapability,
} from '../src/index.ts'

describe('Hub capability contracts', () => {
  it('has unique, self-consistent descriptors and exact negotiation', () => {
    const descriptors = hubCapabilityContracts.map(contract => contract.descriptor)
    expect(new Set(descriptors.map(descriptor => descriptor.name)).size).toBe(descriptors.length)
    expect(negotiateHubCapabilities(descriptors, descriptors.map(descriptor => ({
      name: descriptor.name,
      supportedVersions: [descriptor.version],
      requiredOperations: descriptor.operations.map(operation => operation.name),
      requiredStreams: descriptor.streams.map(stream => stream.name),
    })))).toEqual({ ok: true, accepted: descriptors })
  })

  it('strictly validates session mutation payloads and file bounds', () => {
    const append = resolveHubOperation('dsh.sessions', '1.0.0', 'message.append')
    expect(append?.request.safeParse({
      clientMutationId: 'mutation-1', sessionId: 'session-1', text: 'continue', attachments: [],
    }).success).toBe(true)
    expect(append?.request.safeParse({
      clientMutationId: 'mutation-1', sessionId: 'session-1', text: 'continue', unknown: true,
    }).success).toBe(false)
    expect(resolveHubOperation('dsh.files', '1.0.0', 'read')?.request.safeParse({
      path: '/workspace/file', maxBytes: 5_000_000,
    }).success).toBe(false)
    expect(resolveHubOperation('dsh.plugins', '2.0.0', 'apply')?.request.safeParse({
      clientMutationId: 'plugin-change-1', packageName: '../../escape', version: '1.0.0', expectedLockHash: 'b'.repeat(43),
    }).success).toBe(false)
    expect(resolveHubOperation('dsh.plugins', '2.0.0', 'apply')?.request.safeParse({
      clientMutationId: 'plugin-change-1', packageName: '@example/plugin', version: 'latest', expectedLockHash: 'b'.repeat(43),
    }).success).toBe(false)
  })

  it('marks session streams reconstructible and terminal output transient', () => {
    expect(resolveHubStream('dsh.sessions', '1.0.0', 'events')?.reconstructible).toBe(true)
    expect(resolveHubStream('dsh.terminals', '1.0.0', 'output')?.reconstructible).toBe(false)
    expect(sessionsCapability.descriptor.operations.find(operation => operation.name === 'message.append')?.idempotency)
      .toBe('reconcile')
  })
})
