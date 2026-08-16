import { describe, expect, it } from 'vitest'
import {
  canonicalHubJson, defineHubCapability, generateHubIdentity, hubCapabilityDescriptorSchema,
  hubSignedEnvelopeSchema, HubMessageId, HubNodeId, negotiateHubCapabilities,
  signHubEnvelope, verifyHubCapability, verifyHubEnvelope,
} from '../src/index.ts'

const NOW = 1_800_000_000_000

function signed() {
  const identity = generateHubIdentity()
  const envelope = signHubEnvelope({
    protocolVersion: 1,
    nodeId: HubNodeId('node-a'),
    bootId: HubMessageId('AAAAAAAAAAAAAAAA'),
    connectionGeneration: 4,
    messageId: HubMessageId('BBBBBBBBBBBBBBBB'),
    directionSequence: 7,
    cumulativeAck: 6,
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    body: { type: 'transport.ack' },
  }, identity.privateKey)
  return { identity, envelope }
}

describe('canonicalHubJson', () => {
  it('sorts record keys recursively and preserves array order', () => {
    expect(canonicalHubJson({ z: [3, { b: true, a: null }], a: 'x' }))
      .toBe('{"a":"x","z":[3,{"a":null,"b":true}]}')
  })

  it('rejects cyclic, sparse, and non-finite data', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(() => canonicalHubJson(cyclic as never)).toThrow(/cycles/)
    expect(() => canonicalHubJson(new Array(1) as never)).toThrow(/sparse/)
    expect(() => canonicalHubJson(Number.NaN)).toThrow(/finite/)
  })
})

describe('signed envelopes', () => {
  it('verifies the exact signed body and temporal window', () => {
    const { identity, envelope } = signed()
    expect(verifyHubEnvelope(envelope, identity.publicKey, NOW))
      .toEqual({ ok: true, envelope })
    expect(verifyHubEnvelope(envelope, identity.publicKey, NOW + 60_000))
      .toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects body tampering before signature dispatch', () => {
    const { identity, envelope } = signed()
    const tampered = { ...envelope, body: { type: 'runtime.resync-required', reason: 'operator-request' } }
    expect(verifyHubEnvelope(tampered, identity.publicKey, NOW))
      .toEqual({ ok: false, reason: 'body-hash' })
  })

  it('rejects a signature from another node identity', () => {
    const { envelope } = signed()
    const other = generateHubIdentity()
    expect(verifyHubEnvelope(envelope, other.publicKey, NOW))
      .toEqual({ ok: false, reason: 'signature' })
  })

  it('strictly rejects unknown wire fields', () => {
    const { envelope } = signed()
    expect(hubSignedEnvelopeSchema.safeParse({ ...envelope, unexpected: true }).success).toBe(false)
  })
})

describe('capability descriptors', () => {
  it('derives a stable descriptor hash independent of object construction order', () => {
    const first = defineHubCapability({
      name: 'dsh.session-control',
      version: '1.0.0',
      operations: [{
        name: 'session.list',
        idempotency: 'read',
        requestSchemaHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        responseSchemaHash: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      }],
      streams: [],
    })
    const second = defineHubCapability({
      streams: [],
      operations: [{
        responseSchemaHash: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        requestSchemaHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        idempotency: 'read',
        name: 'session.list',
      }],
      version: '1.0.0',
      name: 'dsh.session-control',
    })
    expect(first.descriptorHash).toBe(second.descriptorHash)
  })

  it('rejects duplicate operation names', () => {
    const operation = {
      name: 'session.list',
      idempotency: 'read' as const,
      requestSchemaHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      responseSchemaHash: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    }
    expect(hubCapabilityDescriptorSchema.safeParse({
      name: 'dsh.session-control',
      version: '1.0.0',
      descriptorHash: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      operations: [operation, operation],
      streams: [],
    }).success).toBe(false)
  })

  it('verifies descriptor hashes and negotiates exact required surfaces', () => {
    const capability = defineHubCapability({
      name: 'dsh.session-control',
      version: '1.0.0',
      operations: [{
        name: 'message.append',
        idempotency: 'reconcile',
        requestSchemaHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        responseSchemaHash: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      }],
      streams: [{
        name: 'events',
        frameSchemaHash: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
        reconstructible: true,
      }],
    })
    expect(verifyHubCapability(capability)).toEqual(capability)
    expect(() => verifyHubCapability({
      ...capability,
      descriptorHash: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
    })).toThrow(/hash mismatch/)
    expect(negotiateHubCapabilities([capability], [{
      name: 'dsh.session-control',
      supportedVersions: ['1.0.0'],
      requiredOperations: ['message.append'],
      requiredStreams: ['events'],
    }])).toEqual({ ok: true, accepted: [capability] })
    expect(negotiateHubCapabilities([capability], [{
      name: 'dsh.session-control',
      supportedVersions: ['2.0.0'],
    }])).toMatchObject({ ok: false, issues: [expect.stringMatching(/unsupported/)] })
  })
})
