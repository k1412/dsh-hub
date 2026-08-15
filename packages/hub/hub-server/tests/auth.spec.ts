import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { CloudflareAccessVerifier, HubAuthError, HubOriginGuard } from '../src/auth.ts'

const issuer = 'https://example.cloudflareaccess.com'
const audience = 'application-audience'
let keyResolver: ReturnType<typeof createLocalJWKSet>
let privateKey: CryptoKey

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })
  privateKey = pair.privateKey
  const publicJwk = await exportJWK(pair.publicKey)
  keyResolver = createLocalJWKSet({ keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] })
})

async function token(claims: Record<string, unknown>, overrides: { issuer?: string; audience?: string } = {}) {
  const now = Math.floor(Date.now() / 1_000)
  return new SignJWT({ type: 'app', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })
    .setIssuedAt(now)
    .setNotBefore(now - 1)
    .setExpirationTime(now + 60)
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .sign(privateKey)
}

function verifier() {
  return new CloudflareAccessVerifier({
    teamDomain: 'example.cloudflareaccess.com',
    audience,
    operatorEmails: ['operator@example.com'],
    keyResolver,
  })
}

describe('Cloudflare Access verifier', () => {
  it('accepts an exact human email and service-token common name', async () => {
    const human = await token({ email: 'Operator@Example.com', sub: 'human-subject' })
    await expect(verifier().verifyHuman({ 'cf-access-jwt-assertion': human })).resolves.toMatchObject({
      kind: 'human', email: 'operator@example.com', subject: 'human-subject',
    })
    const service = await token({ common_name: 'node-token.access', sub: '' })
    await expect(verifier().verifyService({ 'cf-access-jwt-assertion': service })).resolves.toMatchObject({
      kind: 'service', commonName: 'node-token.access',
    })
  })

  it('rejects missing, wrong-audience, and non-allowlisted human tokens', async () => {
    await expect(verifier().verifyHuman({})).rejects.toEqual(expect.objectContaining<Partial<HubAuthError>>({ code: 'missing' }))
    const wrongAudience = await token({ email: 'operator@example.com', sub: 'subject' }, { audience: 'other' })
    await expect(verifier().verifyHuman({ 'cf-access-jwt-assertion': wrongAudience })).rejects.toEqual(
      expect.objectContaining<Partial<HubAuthError>>({ code: 'invalid' }),
    )
    const other = await token({ email: 'other@example.com', sub: 'subject' })
    await expect(verifier().verifyHuman({ 'cf-access-jwt-assertion': other })).rejects.toEqual(
      expect.objectContaining<Partial<HubAuthError>>({ code: 'forbidden' }),
    )
  })

  it('does not accept human claims as a service identity or vice versa', async () => {
    const human = await token({ email: 'operator@example.com', sub: 'subject' })
    await expect(verifier().verifyService({ 'cf-access-jwt-assertion': human })).rejects.toThrow(HubAuthError)
    const service = await token({ common_name: 'node-token.access', sub: '' })
    await expect(verifier().verifyHuman({ 'cf-access-jwt-assertion': service })).rejects.toThrow(HubAuthError)
  })
})

describe('private origin guard', () => {
  it('requires the proxy-held secret on every protected origin request', () => {
    const secret = 'correct-origin-secret-with-32-characters'
    const guard = new HubOriginGuard(secret)
    expect(guard.permits({})).toBe(false)
    expect(guard.permits({ 'x-dsh-origin-secret': 'incorrect-origin-secret-with-32-chars' })).toBe(false)
    expect(guard.permits({ 'x-dsh-origin-secret': secret })).toBe(true)
  })
})
