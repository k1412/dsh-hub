/** Cloudflare Access JWT and private-origin authorization. */

import { createHash, timingSafeEqual } from 'node:crypto'
import {
  createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey,
} from 'jose'

/** Header subset accepted from Node HTTP and WebSocket upgrade requests. */
export type HubRequestHeaders = Readonly<Record<string, string | string[] | undefined>>

/** Cloudflare Access verification configuration. */
export interface CloudflareAccessConfig {
  /** Team hostname, for example `team.cloudflareaccess.com`. */
  teamDomain: string
  /** Exact Access application audience tag. */
  audience: string
  /** Complete human-operator email allowlist. */
  operatorEmails: readonly string[]
  /** Injectable key resolver used by hermetic tests. */
  keyResolver?: JWTVerifyGetKey
}

/** Authenticated human operator. */
export interface HubHumanPrincipal {
  kind: 'human'
  email: string
  subject: string
  expiresAt: number
}

/** Authenticated Cloudflare service-token identity. */
export interface HubServicePrincipal {
  kind: 'service'
  commonName: string
  expiresAt: number
}

interface AccessPayload extends JWTPayload {
  type?: string
  email?: string
  common_name?: string
}

/** Classified authentication failure safe for an HTTP status mapping. */
export class HubAuthError extends Error {
  public constructor(public readonly code: 'missing' | 'invalid' | 'forbidden') {
    super(`Hub authentication ${code}`)
    this.name = 'HubAuthError'
  }
}

function singleHeader(headers: HubRequestHeaders, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function normalizeTeamDomain(value: string): string {
  const domain = value.trim().toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(domain)) {
    throw new Error('Cloudflare Access team domain must be a cloudflareaccess.com hostname')
  }
  return domain
}

/** Validates origin assertions with live-rotated Cloudflare signing keys. */
export class CloudflareAccessVerifier {
  private readonly issuer: string
  private readonly keyResolver: JWTVerifyGetKey
  private readonly operatorEmails: Set<string>

  public constructor(private readonly config: CloudflareAccessConfig) {
    const teamDomain = normalizeTeamDomain(config.teamDomain)
    if (config.audience.trim().length === 0 || config.audience.length > 512) throw new Error('invalid Access audience')
    this.issuer = `https://${teamDomain}`
    this.keyResolver = config.keyResolver
      ?? createRemoteJWKSet(new URL(`${this.issuer}/cdn-cgi/access/certs`), {
        cooldownDuration: 30_000,
        timeoutDuration: 5_000,
      })
    this.operatorEmails = new Set(config.operatorEmails.map(email => email.trim().toLowerCase()))
    if (this.operatorEmails.size === 0 || this.operatorEmails.has('')) {
      throw new Error('at least one valid operator email is required')
    }
  }

  /**
   * Verify a human Access application token and exact email allowlist membership.
   * @param headers - request headers containing the Access assertion.
   * @returns authenticated allowlisted human principal.
   */
  public async verifyHuman(headers: HubRequestHeaders): Promise<HubHumanPrincipal> {
    const payload = await this.verify(headers)
    const email = payload.email?.trim().toLowerCase()
    if (email === undefined || !this.operatorEmails.has(email) || typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new HubAuthError('forbidden')
    }
    return { kind: 'human', email, subject: payload.sub, expiresAt: payload.exp as number }
  }

  /**
   * Verify a service-token Access application token and return its Client ID claim.
   * @param headers - request headers containing the Access assertion.
   * @returns authenticated service-token principal.
   */
  public async verifyService(headers: HubRequestHeaders): Promise<HubServicePrincipal> {
    const payload = await this.verify(headers)
    const commonName = payload.common_name?.trim()
    if (commonName === undefined || commonName.length === 0 || payload.email !== undefined) {
      throw new HubAuthError('forbidden')
    }
    return { kind: 'service', commonName, expiresAt: payload.exp as number }
  }

  private async verify(headers: HubRequestHeaders): Promise<AccessPayload> {
    const token = singleHeader(headers, 'cf-access-jwt-assertion')
    if (token === undefined || token.length === 0) throw new HubAuthError('missing')
    try {
      const result = await jwtVerify<AccessPayload>(token, this.keyResolver, {
        algorithms: ['RS256'],
        issuer: this.issuer,
        audience: this.config.audience,
        clockTolerance: 5,
        requiredClaims: ['aud', 'exp', 'iat', 'iss', 'type'],
      })
      if (result.payload.type !== 'app' || typeof result.payload.exp !== 'number') throw new HubAuthError('invalid')
      return result.payload
    } catch (error) {
      if (error instanceof HubAuthError) throw error
      throw new HubAuthError('invalid')
    }
  }
}

/** Application-layer guard that rejects direct origin traffic missing a proxy-held secret. */
export class HubOriginGuard {
  private readonly expected: Buffer

  public constructor(secret: string, private readonly headerName = 'x-dsh-origin-secret') {
    if (secret.length < 32) throw new Error('Hub origin secret must contain at least 32 characters')
    this.expected = createHash('sha256').update(secret, 'utf8').digest()
  }

  /**
   * Return whether a request carries the configured secret without timing-leaky string comparison.
   * @param headers - origin request headers after trusted proxy normalization.
   * @returns whether the injected proxy secret matches.
   */
  public permits(headers: HubRequestHeaders): boolean {
    const candidate = singleHeader(headers, this.headerName)
    if (candidate === undefined) return false
    const actual = createHash('sha256').update(candidate, 'utf8').digest()
    return timingSafeEqual(this.expected, actual)
  }
}
