/**
 * Versioned DSH Hub wire vocabulary and Ed25519 envelope authentication.
 *
 * This package owns transport-neutral records. A WebSocket, local IPC stream,
 * durable queue, or test loopback may carry the same envelopes. Implementations
 * parse untrusted records and verify signatures before dispatching the body.
 *
 * @module @k1412/dsh-hub-protocol
 */

import {
  createHash, generateKeyPairSync, sign as cryptoSign, timingSafeEqual,
  verify as cryptoVerify,
} from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'

/** Current major wire version. A major mismatch is not negotiable. */
export const HUB_PROTOCOL_VERSION = 1 as const

/** Identifier of one enrolled physical or virtual node. */
export type HubNodeId = Branded<'HubNodeId'>
/** Identifier of one DSH runtime connected through a node. */
export type HubRuntimeId = Branded<'HubRuntimeId'>
/** Globally unique protocol-message identifier. */
export type HubMessageId = Branded<'HubMessageId'>
/** Stable command identifier used for deduplication and reconciliation. */
export type HubCommandId = Branded<'HubCommandId'>

const NODE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/
const PROTOCOL_ID = /^[A-Za-z0-9_-]{16,128}$/
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/
const SIGNATURE_BASE64URL = /^[A-Za-z0-9_-]{86}$/

/** Runtime validator for a node id. */
export const hubNodeIdSchema = z.string().min(1).max(64).regex(NODE_ID)
/** Runtime validator for a runtime id. */
export const hubRuntimeIdSchema = z.string().min(1).max(64).regex(NODE_ID)
/** Runtime validator for message- and command-like ids. */
export const protocolIdSchema = z.string().regex(PROTOCOL_ID)

/**
 * Brand a validated string as a node id.
 * @param value - untrusted candidate node identifier.
 * @returns validated branded node identifier.
 */
export function HubNodeId(value: string): HubNodeId {
  return hubNodeIdSchema.parse(value) as HubNodeId
}

/**
 * Brand a validated string as a runtime id.
 * @param value - untrusted candidate runtime identifier.
 * @returns validated branded runtime identifier.
 */
export function HubRuntimeId(value: string): HubRuntimeId {
  return hubRuntimeIdSchema.parse(value) as HubRuntimeId
}

/**
 * Brand a validated string as a message id.
 * @param value - untrusted candidate message identifier.
 * @returns validated branded message identifier.
 */
export function HubMessageId(value: string): HubMessageId {
  return protocolIdSchema.parse(value) as HubMessageId
}

/**
 * Brand a validated string as a command id.
 * @param value - untrusted candidate command identifier.
 * @returns validated branded command identifier.
 */
export function HubCommandId(value: string): HubCommandId {
  return protocolIdSchema.parse(value) as HubCommandId
}

/** JSON values admitted by signed envelopes. */
export type HubJson = null | boolean | number | string | HubJson[] | { [key: string]: HubJson }

/** Retry posture of one capability operation. */
export type HubIdempotency = 'read' | 'idempotent' | 'reconcile' | 'never-retry'

/** One callable operation advertised by a node capability. */
export interface HubCapabilityOperation {
  /** Operation name within the capability namespace. */
  name: string
  /** Delivery and crash-recovery posture. */
  idempotency: HubIdempotency
  /** SHA-256 of the canonical request schema. */
  requestSchemaHash: string
  /** SHA-256 of the canonical response schema. */
  responseSchemaHash: string
}

/** One stream advertised by a node capability. */
export interface HubCapabilityStream {
  /** Stream name within the capability namespace. */
  name: string
  /** SHA-256 of the canonical frame schema. */
  frameSchemaHash: string
  /** Whether reopen plus authoritative baseline reconstructs missed state. */
  reconstructible: boolean
}

/** Complete negotiated surface of one Connector capability. */
export interface HubCapabilityDescriptor {
  /** Globally namespaced capability id. */
  name: string
  /** Semantic version of the advertised contract. */
  version: string
  /** Hash over the canonical descriptor excluding this field. */
  descriptorHash: string
  /** Callable operations. */
  operations: HubCapabilityOperation[]
  /** Server-push streams. */
  streams: HubCapabilityStream[]
}

/** Hub-side requirement for one capability contract. */
export interface HubCapabilityRequirement {
  /** Required capability namespace. */
  name: string
  /** Exact contract versions implemented by the Hub, in preference order. */
  supportedVersions: string[]
  /** Operations the Hub requires before exposing this capability. */
  requiredOperations?: string[]
  /** Streams the Hub requires before exposing this capability. */
  requiredStreams?: string[]
}

/** Deterministic result of capability validation and exact-version negotiation. */
export type HubCapabilityNegotiation =
  | { ok: true; accepted: HubCapabilityDescriptor[] }
  | { ok: false; issues: string[] }

const hashSchema = z.string().regex(SHA256_BASE64URL)
const capabilityNameSchema = z.string().min(3).max(128).regex(/^[a-z][a-z0-9.-]*$/)
const memberNameSchema = z.string().min(1).max(128).regex(/^[a-z][A-Za-z0-9._/-]*$/)

/** Strict untrusted-input schema for one operation descriptor. */
export const hubCapabilityOperationSchema: z.ZodType<HubCapabilityOperation> = z.strictObject({
  name: memberNameSchema,
  idempotency: z.enum(['read', 'idempotent', 'reconcile', 'never-retry']),
  requestSchemaHash: hashSchema,
  responseSchemaHash: hashSchema,
})

/** Strict untrusted-input schema for one stream descriptor. */
export const hubCapabilityStreamSchema: z.ZodType<HubCapabilityStream> = z.strictObject({
  name: memberNameSchema,
  frameSchemaHash: hashSchema,
  reconstructible: z.boolean(),
})

/** Strict untrusted-input schema for one complete capability descriptor. */
export const hubCapabilityDescriptorSchema: z.ZodType<HubCapabilityDescriptor> = z.strictObject({
  name: capabilityNameSchema,
  version: z.string().regex(SEMVER),
  descriptorHash: hashSchema,
  operations: z.array(hubCapabilityOperationSchema).max(512),
  streams: z.array(hubCapabilityStreamSchema).max(128),
}).superRefine((descriptor, context) => {
  for (const field of ['operations', 'streams'] as const) {
    const names = new Set<string>()
    for (const member of descriptor[field]) {
      if (names.has(member.name)) {
        context.addIssue({
          code: 'custom',
          message: `duplicate ${field} member ${JSON.stringify(member.name)}`,
          path: [field],
        })
      }
      names.add(member.name)
    }
  }
})

/** Challenge generated by either peer before application authentication. */
export interface HubChallengeBody {
  type: 'auth.challenge'
  challenge: string
  audience: 'hub' | 'node'
}

/** Signed node authentication proof. */
export interface HubNodeAuthBody {
  type: 'auth.node-proof'
  publicKey: string
  challenge: string
  enrollmentCode?: string
  agentVersion: string
  protocolMin: number
  protocolMax: number
}

/** Signed Hub acceptance proof and connection assignment. */
export interface HubAcceptedBody {
  type: 'auth.accepted'
  challenge: string
  acceptedProtocol: number
  connectionGeneration: number
  hubPublicKey: string
  hubAck: number
}

/** Runtime and capability baseline sent after authentication. */
export interface HubRuntimeHelloBody {
  type: 'runtime.hello'
  runtimeId: string
  bootId: string
  dshVersion: string
  connectorVersion: string
  capabilities: HubCapabilityDescriptor[]
}

/** Runtime departure while the enclosing Node Agent remains connected. */
export interface HubRuntimeGoodbyeBody {
  type: 'runtime.goodbye'
  runtimeId: string
  reason: 'connector-stopped' | 'connector-replaced' | 'runtime-stopped'
}

/** Hub request to invoke one negotiated operation. */
export interface HubInvokeBody {
  type: 'capability.invoke'
  commandId: string
  runtimeId: string
  capability: string
  capabilityVersion: string
  operation: string
  idempotencyKey?: string
  payload: HubJson
}

/** Successful or failed terminal command result. */
export interface HubResultBody {
  type: 'capability.result'
  commandId: string
  status: 'ok' | 'error' | 'outcome-unknown'
  value?: HubJson
  error?: { code: string; message: string; retryable: boolean; details?: HubJson }
}

/** One reconstructible or durable capability stream frame. */
export interface HubStreamFrameBody {
  type: 'stream.frame'
  runtimeId: string
  streamId: string
  capability: string
  stream: string
  frameSequence: number
  payload: HubJson
}

/** Control record announcing a required authoritative resynchronization. */
export interface HubResyncBody {
  type: 'runtime.resync-required'
  runtimeId?: string
  reason: 'sequence-gap' | 'baseline-changed' | 'retention-exceeded' | 'operator-request'
}

/** Cumulative acknowledgement without a business payload. */
export interface HubAckBody {
  type: 'transport.ack'
}

/** One stream class suppressed locally while reliable control delivery is under pressure. */
export interface HubDroppedStream {
  runtimeId: string
  capability: string
  stream: string
  frames: number
}

/** Node-side reliable queue health reported to the authenticated Hub operator. */
export interface HubTransportStatusBody {
  type: 'transport.status'
  observedAt: number
  pressure: 'normal' | 'warning' | 'critical'
  outboxRecords: number
  outboxBytes: number
  maxOutboxRecords: number
  maxOutboxBytes: number
  oldestPendingAt?: number
  droppedStreamFramesTotal: number
  droppedStreams: HubDroppedStream[]
}

/** Business payloads admitted by protocol version 1. */
export type HubEnvelopeBody =
  | HubChallengeBody
  | HubNodeAuthBody
  | HubAcceptedBody
  | HubRuntimeHelloBody
  | HubRuntimeGoodbyeBody
  | HubInvokeBody
  | HubResultBody
  | HubStreamFrameBody
  | HubResyncBody
  | HubTransportStatusBody
  | HubAckBody

const challengeSchema = z.string().regex(PROTOCOL_ID)
const pemSchema = z.string().min(80).max(4096)

const resultBodySchema = z.strictObject({
  type: z.literal('capability.result'),
  commandId: protocolIdSchema,
  status: z.enum(['ok', 'error', 'outcome-unknown']),
  value: z.json().optional(),
  error: z.strictObject({
    code: z.string().min(1).max(128),
    message: z.string().max(8192),
    retryable: z.boolean(),
    details: z.json().optional(),
  }).optional(),
})

/** Strict schema for every version-1 business body. */
export const hubEnvelopeBodySchema: z.ZodType<HubEnvelopeBody> = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('auth.challenge'),
    challenge: challengeSchema,
    audience: z.enum(['hub', 'node']),
  }),
  z.strictObject({
    type: z.literal('auth.node-proof'),
    publicKey: pemSchema,
    challenge: challengeSchema,
    enrollmentCode: z.string().min(24).max(512).optional(),
    agentVersion: z.string().regex(SEMVER),
    protocolMin: z.number().int().positive(),
    protocolMax: z.number().int().positive(),
  }),
  z.strictObject({
    type: z.literal('auth.accepted'),
    challenge: challengeSchema,
    acceptedProtocol: z.number().int().positive(),
    connectionGeneration: z.number().int().positive(),
    hubPublicKey: pemSchema,
    hubAck: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal('runtime.hello'),
    runtimeId: hubRuntimeIdSchema,
    bootId: protocolIdSchema,
    dshVersion: z.string().min(1).max(128),
    connectorVersion: z.string().regex(SEMVER),
    capabilities: z.array(hubCapabilityDescriptorSchema).max(512),
  }),
  z.strictObject({
    type: z.literal('runtime.goodbye'),
    runtimeId: hubRuntimeIdSchema,
    reason: z.enum(['connector-stopped', 'connector-replaced', 'runtime-stopped']),
  }),
  z.strictObject({
    type: z.literal('capability.invoke'),
    commandId: protocolIdSchema,
    runtimeId: hubRuntimeIdSchema,
    capability: capabilityNameSchema,
    capabilityVersion: z.string().regex(SEMVER),
    operation: memberNameSchema,
    idempotencyKey: protocolIdSchema.optional(),
    payload: z.json(),
  }),
  resultBodySchema,
  z.strictObject({
    type: z.literal('stream.frame'),
    runtimeId: hubRuntimeIdSchema,
    streamId: protocolIdSchema,
    capability: capabilityNameSchema,
    stream: memberNameSchema,
    frameSequence: z.number().int().positive(),
    payload: z.json(),
  }),
  z.strictObject({
    type: z.literal('runtime.resync-required'),
    runtimeId: hubRuntimeIdSchema.optional(),
    reason: z.enum(['sequence-gap', 'baseline-changed', 'retention-exceeded', 'operator-request']),
  }),
  z.strictObject({
    type: z.literal('transport.status'),
    observedAt: z.number().int().nonnegative(),
    pressure: z.enum(['normal', 'warning', 'critical']),
    outboxRecords: z.number().int().nonnegative(),
    outboxBytes: z.number().int().nonnegative(),
    maxOutboxRecords: z.number().int().positive(),
    maxOutboxBytes: z.number().int().positive(),
    oldestPendingAt: z.number().int().positive().optional(),
    droppedStreamFramesTotal: z.number().int().nonnegative(),
    droppedStreams: z.array(z.strictObject({
      runtimeId: hubRuntimeIdSchema,
      capability: capabilityNameSchema,
      stream: memberNameSchema,
      frames: z.number().int().positive(),
    })).max(128),
  }),
  z.strictObject({ type: z.literal('transport.ack') }),
]).superRefine((body, context) => {
  if (body.type !== 'capability.result') return
  if (body.status === 'ok' && body.error !== undefined) {
    context.addIssue({ code: 'custom', message: 'an ok result cannot carry error', path: ['error'] })
  }
  if (body.status !== 'ok' && body.error === undefined) {
    context.addIssue({ code: 'custom', message: 'a non-ok result requires error', path: ['error'] })
  }
}) as z.ZodType<HubEnvelopeBody>

/** Fields covered by the peer signature plus the separately hashed body. */
export interface HubSignedEnvelope {
  protocolVersion: 1
  nodeId: string
  bootId: string
  connectionGeneration: number
  messageId: string
  directionSequence: number
  cumulativeAck: number
  issuedAt: number
  expiresAt: number
  bodyHash: string
  body: HubEnvelopeBody
  signature: string
}

const hubEnvelopeWithoutSignatureSchema = z.strictObject({
  protocolVersion: z.literal(HUB_PROTOCOL_VERSION),
  nodeId: hubNodeIdSchema,
  bootId: protocolIdSchema,
  connectionGeneration: z.number().int().nonnegative(),
  messageId: protocolIdSchema,
  directionSequence: z.number().int().positive(),
  cumulativeAck: z.number().int().nonnegative(),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  bodyHash: hashSchema,
  body: hubEnvelopeBodySchema,
})

/** Strict schema for an untrusted signed envelope. */
export const hubSignedEnvelopeSchema: z.ZodType<HubSignedEnvelope> = hubEnvelopeWithoutSignatureSchema.extend({
  signature: z.string().regex(SIGNATURE_BASE64URL),
})

/** Envelope fields supplied before body hashing and signing. */
export type HubUnsignedEnvelope = Omit<HubSignedEnvelope, 'bodyHash' | 'signature'>

/** Public/private PEM pair for one protocol peer. */
export interface HubIdentityKeyPair {
  publicKey: string
  privateKey: string
}

/** Result of temporal and cryptographic envelope verification. */
export type HubEnvelopeVerification =
  | { ok: true; envelope: HubSignedEnvelope }
  | { ok: false; reason: 'malformed' | 'body-hash' | 'signature' | 'expired' | 'issued-in-future' }

/**
 * Generate an Ed25519 identity in portable PKCS8/SPKI PEM forms.
 * @returns newly generated public and private key pair.
 */
export function generateHubIdentity(): HubIdentityKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

/**
 * Canonicalize one JSON value for descriptor hashes and signature inputs.
 * @param value - strict JSON value.
 * @returns deterministic JSON without insignificant whitespace.
 */
export function canonicalHubJson(value: HubJson): string {
  const ancestors = new Set<object>()
  const encode = (item: HubJson): string => {
    if (item === null) return 'null'
    switch (typeof item) {
      case 'boolean': return item ? 'true' : 'false'
      case 'number': {
        if (!Number.isFinite(item)) throw new TypeError('Hub JSON numbers must be finite')
        return JSON.stringify(item)
      }
      case 'string': return JSON.stringify(item)
      case 'object': {
        if (ancestors.has(item)) throw new TypeError('Hub JSON cannot contain cycles')
        ancestors.add(item)
        try {
          if (Array.isArray(item)) {
            for (let index = 0; index < item.length; index++) {
              if (!(index in item)) throw new TypeError('Hub JSON arrays cannot be sparse')
            }
            return `[${item.map(entry => encode(entry)).join(',')}]`
          }
          const prototype = Object.getPrototypeOf(item) as object | null
          if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError('Hub JSON objects must be plain records')
          }
          const fields = Object.keys(item).sort().map((key) => {
            const entry = item[key]
            if (entry === undefined) throw new TypeError('Hub JSON objects cannot contain undefined')
            return `${JSON.stringify(key)}:${encode(entry)}`
          })
          return `{${fields.join(',')}}`
        } finally {
          ancestors.delete(item)
        }
      }
      default: throw new TypeError('Hub JSON contains an unsupported value')
    }
  }
  return encode(value)
}

/**
 * Compute the protocol SHA-256 representation of one JSON value.
 * @param value - strict JSON value to hash canonically.
 * @returns unpadded base64url SHA-256 digest.
 */
export function hubJsonHash(value: HubJson): string {
  return createHash('sha256').update(canonicalHubJson(value)).digest('base64url')
}

function signatureRecord(envelope: Omit<HubSignedEnvelope, 'body' | 'signature'>): HubJson {
  return {
    protocolVersion: envelope.protocolVersion,
    nodeId: envelope.nodeId,
    bootId: envelope.bootId,
    connectionGeneration: envelope.connectionGeneration,
    messageId: envelope.messageId,
    directionSequence: envelope.directionSequence,
    cumulativeAck: envelope.cumulativeAck,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    bodyHash: envelope.bodyHash,
  }
}

/**
 * Sign a complete envelope after validating its body and unsigned fields.
 * @param unsigned - complete unsigned envelope.
 * @param privateKey - signing peer's Ed25519 private key.
 * @returns strict signed envelope with canonical body hash.
 */
export function signHubEnvelope(unsigned: HubUnsignedEnvelope, privateKey: string | KeyObject): HubSignedEnvelope {
  const body = hubEnvelopeBodySchema.parse(unsigned.body)
  const bodyHash = hubJsonHash(body as unknown as HubJson)
  const parsed = hubEnvelopeWithoutSignatureSchema.parse({ ...unsigned, body, bodyHash })
  const signature = cryptoSign(
    null,
    Buffer.from(canonicalHubJson(signatureRecord(parsed)), 'utf8'),
    privateKey,
  ).toString('base64url')
  return hubSignedEnvelopeSchema.parse({ ...parsed, signature })
}

/**
 * Parse, time-check, hash-check, and authenticate an untrusted envelope.
 * @param input - untrusted decoded JSON.
 * @param publicKey - expected peer Ed25519 public key.
 * @param now - verification clock in Unix milliseconds.
 * @param futureSkewMs - tolerated positive clock skew for `issuedAt`.
 * @returns authenticated envelope or a stable rejection reason.
 */
export function verifyHubEnvelope(
  input: unknown,
  publicKey: string | KeyObject,
  now = Date.now(),
  futureSkewMs = 30_000,
): HubEnvelopeVerification {
  const parsed = hubSignedEnvelopeSchema.safeParse(input)
  if (!parsed.success) return { ok: false, reason: 'malformed' }
  const envelope = parsed.data
  if (envelope.expiresAt <= now) return { ok: false, reason: 'expired' }
  if (envelope.issuedAt > now + futureSkewMs) return { ok: false, reason: 'issued-in-future' }
  const calculatedHash = hubJsonHash(envelope.body as unknown as HubJson)
  const expected = Buffer.from(envelope.bodyHash, 'base64url')
  const actual = Buffer.from(calculatedHash, 'base64url')
  if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'body-hash' }
  }
  const valid = cryptoVerify(
    null,
    Buffer.from(canonicalHubJson(signatureRecord(envelope)), 'utf8'),
    publicKey,
    Buffer.from(envelope.signature, 'base64url'),
  )
  if (!valid) return { ok: false, reason: 'signature' }
  return { ok: true, envelope }
}

/**
 * Validate and hash a capability descriptor whose descriptor hash is omitted.
 * @param descriptor - descriptor fields owned by a capability provider.
 * @returns strict descriptor carrying its canonical hash.
 */
export function defineHubCapability(
  descriptor: Omit<HubCapabilityDescriptor, 'descriptorHash'>,
): HubCapabilityDescriptor {
  const base = {
    name: descriptor.name,
    version: descriptor.version,
    operations: descriptor.operations,
    streams: descriptor.streams,
  }
  const descriptorHash = hubJsonHash(base as unknown as HubJson)
  return hubCapabilityDescriptorSchema.parse({ ...base, descriptorHash })
}

/**
 * Verify a descriptor's self-hash after strict schema validation.
 * @param descriptorInput - untrusted capability descriptor.
 * @returns strict descriptor carrying a valid canonical hash.
 */
export function verifyHubCapability(descriptorInput: unknown): HubCapabilityDescriptor {
  const descriptor = hubCapabilityDescriptorSchema.parse(descriptorInput)
  const expected = defineHubCapability({
    name: descriptor.name,
    version: descriptor.version,
    operations: descriptor.operations,
    streams: descriptor.streams,
  })
  if (expected.descriptorHash !== descriptor.descriptorHash) {
    throw new Error(`capability descriptor hash mismatch for ${descriptor.name}@${descriptor.version}`)
  }
  return descriptor
}

/**
 * Validate advertised descriptors and negotiate exact contracts required by a Hub.
 * @param advertisedInput - untrusted descriptors advertised by a runtime.
 * @param requirements - exact versions and members required by Hub.
 * @returns accepted descriptors and any negotiation issues.
 */
export function negotiateHubCapabilities(
  advertisedInput: readonly unknown[],
  requirements: readonly HubCapabilityRequirement[],
): HubCapabilityNegotiation {
  const issues: string[] = []
  const advertised = new Map<string, HubCapabilityDescriptor>()
  for (const input of advertisedInput) {
    try {
      const descriptor = verifyHubCapability(input)
      if (advertised.has(descriptor.name)) issues.push(`duplicate advertised capability ${descriptor.name}`)
      else advertised.set(descriptor.name, descriptor)
    } catch (error) {
      issues.push(error instanceof Error ? error.message : 'invalid capability descriptor')
    }
  }
  const requiredNames = new Set<string>()
  const accepted: HubCapabilityDescriptor[] = []
  for (const requirement of requirements) {
    if (requiredNames.has(requirement.name)) {
      issues.push(`duplicate capability requirement ${requirement.name}`)
      continue
    }
    requiredNames.add(requirement.name)
    const descriptor = advertised.get(requirement.name)
    if (descriptor === undefined) {
      issues.push(`required capability ${requirement.name} is unavailable`)
      continue
    }
    if (!requirement.supportedVersions.includes(descriptor.version)) {
      issues.push(`unsupported capability version ${descriptor.name}@${descriptor.version}`)
      continue
    }
    const operations = new Set(descriptor.operations.map(operation => operation.name))
    const streams = new Set(descriptor.streams.map(stream => stream.name))
    for (const operation of requirement.requiredOperations ?? []) {
      if (!operations.has(operation)) issues.push(`capability ${descriptor.name} lacks operation ${operation}`)
    }
    for (const stream of requirement.requiredStreams ?? []) {
      if (!streams.has(stream)) issues.push(`capability ${descriptor.name} lacks stream ${stream}`)
    }
    accepted.push(descriptor)
  }
  return issues.length === 0 ? { ok: true, accepted } : { ok: false, issues }
}
