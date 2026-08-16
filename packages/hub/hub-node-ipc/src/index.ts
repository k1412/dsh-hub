/** Length-prefixed, authenticated local IPC shared by Connector and Node Agent. */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { hubCapabilityDescriptorSchema, hubEnvelopeBodySchema, type HubCapabilityDescriptor, type HubEnvelopeBody } from '@k1412/dsh-hub-protocol'
import { z } from 'zod'

/** Maximum decoded local frame size. */
export const HUB_IPC_MAX_FRAME_BYTES = 256 * 1024 * 1024

/** Fresh Agent challenge. */
export interface HubIpcChallenge {
  type: 'ipc.challenge'
  challenge: string
}

/** Connector identity proof and runtime baseline. */
export interface HubIpcProof {
  type: 'ipc.proof'
  challenge: string
  runtimeId: string
  runtimeBootId: string
  connectorVersion: string
  dshVersion: string
  capabilities: HubCapabilityDescriptor[]
  proof: string
}

/** Agent proof acceptance. */
export interface HubIpcAccepted {
  type: 'ipc.accepted'
  challenge: string
  agentBootId: string
}

/** Authenticated local carriage of one Hub protocol body. */
export interface HubIpcBody {
  type: 'ipc.hub-body'
  body: HubEnvelopeBody
}

/** Liveness record that carries no business state. */
export interface HubIpcHeartbeat {
  type: 'ipc.heartbeat'
  timestamp: number
}

/** Complete local IPC frame union. */
export type HubIpcFrame = HubIpcChallenge | HubIpcProof | HubIpcAccepted | HubIpcBody | HubIpcHeartbeat

const protocolId = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/)
const semver = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)

/** Strict runtime schema for local IPC frames. */
export const hubIpcFrameSchema: z.ZodType<HubIpcFrame> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ipc.challenge'), challenge: protocolId }),
  z.strictObject({
    type: z.literal('ipc.proof'),
    challenge: protocolId,
    runtimeId: z.string().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/),
    runtimeBootId: protocolId,
    connectorVersion: semver,
    dshVersion: z.string().min(1).max(128),
    capabilities: z.array(hubCapabilityDescriptorSchema).max(512),
    proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }),
  z.strictObject({ type: z.literal('ipc.accepted'), challenge: protocolId, agentBootId: protocolId }),
  z.strictObject({ type: z.literal('ipc.hub-body'), body: hubEnvelopeBodySchema }),
  z.strictObject({ type: z.literal('ipc.heartbeat'), timestamp: z.number().int().nonnegative() }),
])

/**
 * Generate a 256-bit local IPC shared secret.
 * @returns unpadded base64url secret.
 */
export function generateHubIpcSecret(): string {
  return randomBytes(32).toString('base64url')
}

function proofInput(challenge: string, runtimeId: string, runtimeBootId: string, connectorVersion: string): string {
  return `${challenge}\0${runtimeId}\0${runtimeBootId}\0${connectorVersion}`
}

/**
 * Derive a Connector proof without sending the shared secret on the socket.
 * @param secret - 256-bit shared IPC secret.
 * @param challenge - Node Agent challenge.
 * @param runtimeId - Connector runtime identifier.
 * @param runtimeBootId - per-process Connector boot identifier.
 * @param connectorVersion - Connector package version.
 * @returns base64url HMAC proof bound to the challenge and runtime.
 */
export function createHubIpcProof(
  secret: string,
  challenge: string,
  runtimeId: string,
  runtimeBootId: string,
  connectorVersion: string,
): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('IPC secret must be 256-bit base64url')
  return createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(proofInput(challenge, runtimeId, runtimeBootId, connectorVersion), 'utf8')
    .digest('base64url')
}

/**
 * Verify a Connector proof using constant-time digest comparison.
 * @param secret - expected shared IPC secret.
 * @param frame - proof frame received from a Connector.
 * @returns whether the proof matches all bound fields.
 */
export function verifyHubIpcProof(secret: string, frame: HubIpcProof): boolean {
  const expected = Buffer.from(createHubIpcProof(
    secret, frame.challenge, frame.runtimeId, frame.runtimeBootId, frame.connectorVersion,
  ), 'base64url')
  const actual = Buffer.from(frame.proof, 'base64url')
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual)
}

/**
 * Encode one strict frame with a four-byte big-endian length prefix.
 * @param frameInput - frame to validate and encode.
 * @returns length-prefixed bytes ready for the local stream.
 */
export function encodeHubIpcFrame(frameInput: HubIpcFrame): Buffer {
  const frame = hubIpcFrameSchema.parse(frameInput)
  const body = Buffer.from(JSON.stringify(frame), 'utf8')
  if (body.byteLength > HUB_IPC_MAX_FRAME_BYTES) throw new Error('IPC frame exceeds maximum size')
  const output = Buffer.allocUnsafe(4 + body.byteLength)
  output.writeUInt32BE(body.byteLength, 0)
  body.copy(output, 4)
  return output
}

/** Incremental decoder for fragmented and coalesced stream chunks. */
export class HubIpcFrameDecoder {
  private buffered = Buffer.alloc(0)

  /**
   * Append one stream chunk and return every complete strict frame.
   * @param chunk - next bytes received from the local stream.
   * @returns all complete frames decoded from buffered bytes.
   */
  public push(chunk: Uint8Array): HubIpcFrame[] {
    this.buffered = Buffer.concat([this.buffered, chunk])
    const frames: HubIpcFrame[] = []
    for (;;) {
      if (this.buffered.byteLength < 4) break
      const length = this.buffered.readUInt32BE(0)
      if (length > HUB_IPC_MAX_FRAME_BYTES) throw new Error('IPC frame length exceeds maximum size')
      if (this.buffered.byteLength < 4 + length) break
      const bytes = this.buffered.subarray(4, 4 + length)
      this.buffered = this.buffered.subarray(4 + length)
      let input: unknown
      try {
        input = JSON.parse(bytes.toString('utf8')) as unknown
      } catch {
        throw new Error('IPC frame is not valid JSON')
      }
      frames.push(hubIpcFrameSchema.parse(input))
    }
    return frames
  }
}
