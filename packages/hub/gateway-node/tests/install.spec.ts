import { describe, expect, it } from 'vitest'
import { enrollmentIdentity, gatewayProfilePatch, parseManifest } from '../src/install.ts'

describe('existing Runtime installer boundaries', () => {
  it('preserves upstream overrides and JS expressions while replacing only its managed config', () => {
    const original = '# Existing operator settings\n- id: model\n  config:\n    value: !!js process.env.MODEL\n'
    const first = gatewayProfilePatch(original, '/home/operator/.dsh-gateway/connection.json')
    expect(first.startsWith(original)).toBe(true)
    expect(first).toContain('connectionFile: "/home/operator/.dsh-gateway/connection.json"')
    const next = gatewayProfilePatch(first, '/home/operator/gateway/connection.json')
    expect(next.match(/- id: gateway-node/g)).toHaveLength(1)
    expect(next).not.toContain('.dsh-gateway/connection.json')
    expect(next).toContain('!!js process.env.MODEL')
  })
  it('converts an empty profile patch into a list and refuses a damaged managed block', () => {
    expect(gatewayProfilePatch('# Empty profile\n[]\n', '/state/connection.json')).not.toContain('[]')
    expect(() => gatewayProfilePatch('# BEGIN DSH GATEWAY NODE (managed by dsh-gateway-node)', '/state')).toThrow('Incomplete')
  })
  it('accepts only supported invitation modes and complete package checksums', () => {
    const valid = { protocol: 1, inviteToken: 'one-time', hubUrl: 'https://hub.example', mode: 'tailcat', endpoint: 'tailcat://opaque', expiresAt: Date.now() + 10000, package: { url: '/downloads/node.tgz', sha256: 'a'.repeat(64) } }
    expect(parseManifest(valid)).toEqual(valid)
    expect(() => parseManifest({ ...valid, mode: 'lan' })).toThrow('Invalid')
    expect(() => parseManifest({ ...valid, package: { ...valid.package, sha256: 'bad' } })).toThrow('Invalid')
    expect(() => parseManifest({ ...valid, hubUrl: 'file:///secret' })).toThrow('Invalid')
  })
  it('keeps failed-enrollment retries idempotent but rotates identity for a fresh invitation', () => {
    const first = enrollmentIdentity('first-invitation')
    expect(enrollmentIdentity('first-invitation', first)).toEqual(first)
    const replacement = enrollmentIdentity('new-invitation-after-revoke', first)
    expect(replacement.clientId).not.toBe(first.clientId)
    expect(replacement.credential).not.toBe(first.credential)
    expect(JSON.stringify(replacement)).not.toContain('new-invitation-after-revoke')
    expect(enrollmentIdentity('first-invitation', first, true)).toEqual(first)
    expect(() => enrollmentIdentity('first-invitation', undefined, true)).toThrow('already claimed')
    expect(() => enrollmentIdentity('first-invitation', replacement, true)).toThrow('already claimed')
  })
})

it('keeps the base Loader block while configuring an aliased named connection', () => {
  const base = gatewayProfilePatch('[]\n', '/state/base/connection.json')
  const named = gatewayProfilePatch(base, '/state/experiment/connection.json', 'gateway-node-control', '@k1412/dsh-gateway-node-control', true)
  expect(named.startsWith(base.trimEnd())).toBe(true)
  expect(named).toContain('name: "@k1412/dsh-gateway-node-control"')
  expect(named).toContain('/state/base/connection.json')
})
