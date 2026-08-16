/** Fleet-wide identity translation for the official DSH Web protocol. */

/** One DSH Runtime address owned by the Hub. */
export interface FleetWebTarget {
  nodeId: string
  runtimeId: string
  displayName?: string
}

/** A decoded browser-visible identity and its owning Runtime. */
export interface DecodedFleetId extends FleetWebTarget {
  kind: 'session' | 'workspace'
  sourceId: string
}

interface DecodedFleetPayload {
  value: unknown
  targets: FleetWebTarget[]
}

const PREFIX = 'hub'
const ENCODED_ID = /^hub-(session|workspace)-([A-Za-z0-9_-]+)$/
const TARGET_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i

function canonicalBase64url(value: string): string | undefined {
  try {
    const bytes = Buffer.from(value, 'base64url')
    return bytes.toString('base64url') === value ? bytes.toString('utf8') : undefined
  } catch {
    return undefined
  }
}

function targetKey(target: FleetWebTarget): string {
  return `${target.nodeId}\u0000${target.runtimeId}`
}

/**
 * Encode one node-local id for collision-free use in the fleet Web client.
 *
 * @param kind - The DSH resource kind represented by the id.
 * @param target - The Runtime that owns the node-local resource.
 * @param sourceId - The id used inside the owning Runtime.
 * @returns An opaque browser-visible id that preserves Runtime ownership.
 */
export function encodeFleetId(
  kind: DecodedFleetId['kind'],
  target: FleetWebTarget,
  sourceId: string,
): string {
  const payload = Buffer.from(JSON.stringify([target.nodeId, target.runtimeId, sourceId]), 'utf8')
    .toString('base64url')
  return `${PREFIX}-${kind}-${payload}`
}

/**
 * Decode a browser-visible fleet id, returning undefined for ordinary node-local ids.
 *
 * @param value - The id received from the browser.
 * @returns The decoded ownership record, or undefined for an unencoded id.
 */
export function decodeFleetId(value: string): DecodedFleetId | undefined {
  const match = ENCODED_ID.exec(value)
  if (match === null) return undefined
  const source = canonicalBase64url(match[2] as string)
  if (source === undefined) throw new Error('fleet identity is malformed')
  let decoded: unknown
  try {
    decoded = JSON.parse(source) as unknown
  } catch {
    throw new Error('fleet identity is malformed')
  }
  if (!Array.isArray(decoded) || decoded.length !== 3
    || decoded.some(item => typeof item !== 'string')) {
    throw new Error('fleet identity is malformed')
  }
  const [nodeId, runtimeId, sourceId] = decoded as [string, string, string]
  if (!TARGET_ID.test(nodeId) || !TARGET_ID.test(runtimeId) || sourceId.length === 0 || sourceId.length > 65_536) {
    throw new Error('fleet identity is malformed')
  }
  return {
    kind: match[1] as DecodedFleetId['kind'],
    nodeId,
    runtimeId,
    sourceId,
  }
}

/**
 * Replace identity fields in a browser request and collect their owning Runtime.
 *
 * @param input - The request value to inspect without interpreting user-authored text.
 * @param rootKey - The protocol field name when the request value is a scalar.
 * @returns The node-local request value and every Runtime referenced by encoded ids.
 */
export function decodeFleetPayload(input: unknown, rootKey = ''): DecodedFleetPayload {
  const targets = new Map<string, FleetWebTarget>()
  const visit = (value: unknown, key: string): unknown => {
    if (typeof value === 'string') {
      // An opaque fleet id can also be ordinary user text. Decode it only in
      // protocol fields whose contract says the value is an identity.
      if (!sessionIdentityField(key) && !workspaceIdentityField(key)) return value
      const decoded = decodeFleetId(value)
      if (decoded === undefined) return value
      const expectedKind = sessionIdentityField(key) ? 'session' : 'workspace'
      if (decoded.kind !== expectedKind) throw new Error('fleet identity kind does not match its protocol field')
      const target = { nodeId: decoded.nodeId, runtimeId: decoded.runtimeId }
      targets.set(targetKey(target), target)
      return decoded.sourceId
    }
    if (Array.isArray(value)) {
      const elementKey = key.endsWith('Ids') ? key.slice(0, -1) : key
      return value.map(child => visit(child, elementKey))
    }
    if (typeof value !== 'object' || value === null) return value
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, visit(child, childKey)]),
    )
  }
  return { value: visit(input, rootKey), targets: [...targets.values()] }
}

function sessionIdentityField(key: string): boolean {
  return key === 'agentId' || key === 'agentIds'
    || key.endsWith('SessionId') || key.endsWith('SessionIds')
    || key === 'sessionId' || key === 'sessionIds'
}

function workspaceIdentityField(key: string): boolean {
  return key.endsWith('WorkspaceId') || key.endsWith('WorkspaceIds')
    || key === 'workspaceId' || key === 'workspaceIds'
}

function isWorkspaceView(value: Record<string, unknown>): boolean {
  return typeof value.workspaceId === 'string'
    && typeof value.path === 'string'
    && typeof value.title === 'string'
    && Array.isArray(value.sessionIds)
}

/**
 * Namespace node-local ids in a response or event before it reaches the fleet browser.
 *
 * @param input - A response or event emitted by one Runtime.
 * @param target - The Runtime that emitted the value.
 * @returns A browser-visible value whose protocol identity fields preserve ownership.
 */
export function encodeFleetPayload(input: unknown, target: FleetWebTarget): unknown {
  const visit = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') {
      if (sessionIdentityField(key)) return encodeFleetId('session', target, value)
      if (workspaceIdentityField(key)) return encodeFleetId('workspace', target, value)
      return value
    }
    if (Array.isArray(value)) {
      const elementKey = key.endsWith('Ids') ? key.slice(0, -1) : key
      return value.map(child => visit(child, elementKey))
    }
    if (typeof value !== 'object' || value === null) return value
    const record = value as Record<string, unknown>
    const rewritten = Object.fromEntries(
      Object.entries(record).map(([childKey, child]) => [childKey, visit(child, childKey)]),
    )
    if (target.displayName !== undefined && isWorkspaceView(record)) {
      // The official sidebar groups sessions by Workspace. Keep the folder as
      // the primary label and attach the node only to disambiguate equal paths.
      rewritten.title = `${String(record.title)} · ${target.displayName}`
    }
    return rewritten
  }
  return visit(input)
}

/**
 * Require every encoded identity in one request to belong to the same Runtime.
 *
 * @param targets - Runtime addresses collected from one browser request.
 * @returns The sole owning Runtime, or undefined when the request has no encoded identity.
 */
export function singleFleetTarget(targets: readonly FleetWebTarget[]): FleetWebTarget | undefined {
  if (targets.length === 0) return undefined
  if (targets.length > 1) throw new Error('one request cannot address multiple DSH Runtimes')
  return targets[0]
}
