/** Package-owned invariant companion for the DSH Hub protocol. @module @k1412/dsh-hub-protocol/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { defineHubCapability, generateHubIdentity, HubMessageId, HubNodeId, signHubEnvelope, verifyHubEnvelope } from './index.ts'

const PACKAGE_NAME = '@k1412/dsh-hub-protocol'

/** Cordis companion plugin name. */
export const name = 'hub-protocol-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Verify a signed reference envelope and descriptor at invariant activation. */
const install: InvariantInstaller = (_ctx: Context, fail: InvariantFailure) => {
  const identity = generateHubIdentity()
  const now = Date.now()
  const envelope = signHubEnvelope({
    protocolVersion: 1,
    nodeId: HubNodeId('invariant-node'),
    bootId: HubMessageId('AAAAAAAAAAAAAAAA'),
    connectionGeneration: 1,
    messageId: HubMessageId('BBBBBBBBBBBBBBBB'),
    directionSequence: 1,
    cumulativeAck: 0,
    issuedAt: now,
    expiresAt: now + 1_000,
    body: { type: 'transport.ack' },
  }, identity.privateKey)
  if (!verifyHubEnvelope(envelope, identity.publicKey, now).ok) {
    fail('hub protocol invariant: reference signature did not verify')
  }
  defineHubCapability({ name: 'dsh.invariant', version: '1.0.0', operations: [], streams: [] })
}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
