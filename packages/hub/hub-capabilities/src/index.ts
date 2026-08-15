/** Stable Hub-to-Connector capability contracts independent of the DSH Web plugin. */

import { defineHubCapability, hubJsonHash, type HubCapabilityDescriptor, type HubIdempotency, type HubJson } from '@k1412/dsh-hub-protocol'
import { z } from 'zod'

/** Runtime contract for one callable capability operation. */
export interface HubOperationContract {
  name: string
  idempotency: HubIdempotency
  request: z.ZodType
  response: z.ZodType
}

/** Runtime contract for one reconstructible or transient stream. */
export interface HubStreamContract {
  name: string
  frame: z.ZodType
  reconstructible: boolean
}

/** Complete runtime-validated capability contract. */
export interface HubCapabilityContract {
  descriptor: HubCapabilityDescriptor
  operations: ReadonlyMap<string, HubOperationContract>
  streams: ReadonlyMap<string, HubStreamContract>
}

const id = z.string().min(1).max(256)
const path = z.string().min(1).max(16_384)
const hash = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const version = z.string().max(128).regex(
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
)
const packageName = z.string().max(214).regex(
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/,
)
const empty = z.strictObject({})
const ok = z.strictObject({ ok: z.literal(true) })

const sessionSummary = z.strictObject({
  sessionId: id,
  title: z.string().max(1_024).optional(),
  workspacePath: path.optional(),
  updatedAt: z.number().int().nonnegative(),
  running: z.boolean(),
  eventSequence: z.number().int().nonnegative(),
})

const terminalOutput = z.strictObject({
  terminalId: id,
  sequence: z.number().int().positive(),
  encoding: z.enum(['utf8', 'base64']),
  data: z.string().max(1_048_576),
  eof: z.boolean(),
  exitCode: z.number().int().nullable().optional(),
})

function schemaHash(schema: z.ZodType): string {
  return hubJsonHash(z.toJSONSchema(schema) as unknown as HubJson)
}

function capability(
  name: string,
  operations: readonly HubOperationContract[],
  streams: readonly HubStreamContract[],
): HubCapabilityContract {
  const operationMap = new Map(operations.map(operation => [operation.name, operation]))
  const streamMap = new Map(streams.map(stream => [stream.name, stream]))
  if (operationMap.size !== operations.length || streamMap.size !== streams.length) {
    throw new Error(`duplicate member in capability ${name}`)
  }
  return {
    descriptor: defineHubCapability({
      name,
      version: '1.0.0',
      operations: operations.map(operation => ({
        name: operation.name,
        idempotency: operation.idempotency,
        requestSchemaHash: schemaHash(operation.request),
        responseSchemaHash: schemaHash(operation.response),
      })),
      streams: streams.map(stream => ({
        name: stream.name,
        frameSchemaHash: schemaHash(stream.frame),
        reconstructible: stream.reconstructible,
      })),
    }),
    operations: operationMap,
    streams: streamMap,
  }
}

/** Shared sessions continue across local Web, desktop, and Hub surfaces. */
export const sessionsCapability = capability('dsh.sessions', [
  {
    name: 'list',
    idempotency: 'read',
    request: z.strictObject({ cursor: z.string().max(512).optional(), limit: z.number().int().min(1).max(500).default(100) }),
    response: z.strictObject({ sessions: z.array(sessionSummary).max(500), nextCursor: z.string().max(512).optional() }),
  },
  {
    name: 'read',
    idempotency: 'read',
    request: z.strictObject({
      sessionId: id,
      afterSequence: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(2_000).default(500),
    }),
    response: z.strictObject({ session: sessionSummary, events: z.array(z.json()).max(2_000), hasMore: z.boolean() }),
  },
  {
    name: 'create',
    idempotency: 'idempotent',
    request: z.strictObject({
      clientMutationId: id,
      workspacePath: path.optional(),
      title: z.string().max(1_024).optional(),
      initialMessage: z.string().max(1_048_576).optional(),
      model: z.string().max(256).optional(),
      preset: z.string().max(256).optional(),
    }),
    response: sessionSummary,
  },
  {
    name: 'message.append',
    idempotency: 'reconcile',
    request: z.strictObject({
      clientMutationId: id,
      sessionId: id,
      text: z.string().max(1_048_576),
      attachments: z.array(z.json()).max(64).default([]),
    }),
    response: z.strictObject({ accepted: z.boolean(), eventSequence: z.number().int().nonnegative() }),
  },
  {
    name: 'message.steer',
    idempotency: 'reconcile',
    request: z.strictObject({ clientMutationId: id, sessionId: id, text: z.string().min(1).max(1_048_576) }),
    response: ok,
  },
  {
    name: 'cancel',
    idempotency: 'idempotent',
    request: z.strictObject({ sessionId: id }),
    response: ok,
  },
  {
    name: 'interaction.respond',
    idempotency: 'idempotent',
    request: z.strictObject({ sessionId: id, requestId: id, response: z.json() }),
    response: ok,
  },
], [
  {
    name: 'index',
    reconstructible: true,
    frame: z.strictObject({ revision: z.number().int().nonnegative(), sessions: z.array(sessionSummary).max(10_000) }),
  },
  {
    name: 'events',
    reconstructible: true,
    frame: z.strictObject({ sessionId: id, fromSequence: z.number().int().nonnegative(), events: z.array(z.json()).max(2_000) }),
  },
])

/** Interactive terminal sessions are explicitly opened and bounded. */
export const terminalsCapability = capability('dsh.terminals', [
  {
    name: 'open',
    idempotency: 'idempotent',
    request: z.strictObject({
      clientMutationId: id,
      cwd: path.optional(),
      shell: z.string().max(512).optional(),
      columns: z.number().int().min(20).max(1_000),
      rows: z.number().int().min(5).max(1_000),
    }),
    response: z.strictObject({ terminalId: id }),
  },
  {
    name: 'write',
    idempotency: 'never-retry',
    request: z.strictObject({ terminalId: id, encoding: z.enum(['utf8', 'base64']), data: z.string().max(1_048_576) }),
    response: ok,
  },
  {
    name: 'resize',
    idempotency: 'idempotent',
    request: z.strictObject({ terminalId: id, columns: z.number().int().min(20).max(1_000), rows: z.number().int().min(5).max(1_000) }),
    response: ok,
  },
  {
    name: 'close',
    idempotency: 'idempotent',
    request: z.strictObject({ terminalId: id }),
    response: ok,
  },
], [{ name: 'output', reconstructible: false, frame: terminalOutput }])

const pluginRecord = z.strictObject({
  packageName,
  version,
  artifactHash: hash.optional(),
  enabled: z.boolean(),
  healthy: z.boolean(),
})

/** Node Agent stages and rolls back plugins outside the DSH process. */
export const pluginsCapability = capability('dsh.plugins', [
  { name: 'inventory', idempotency: 'read', request: empty, response: z.strictObject({ plugins: z.array(pluginRecord).max(10_000), lockHash: hash }) },
  {
    name: 'apply',
    idempotency: 'reconcile',
    request: z.strictObject({
      packageName,
      version,
      artifactHash: hash,
      expectedLockHash: hash,
    }),
    response: z.strictObject({ plugin: pluginRecord, previousLockHash: hash, lockHash: hash }),
  },
  { name: 'rollback', idempotency: 'reconcile', request: z.strictObject({ packageName, targetLockHash: hash }), response: z.strictObject({ plugins: z.array(pluginRecord).max(10_000), lockHash: hash }) },
], [{ name: 'inventory', reconstructible: true, frame: z.strictObject({ plugins: z.array(pluginRecord).max(10_000), lockHash: hash }) }])

const snapshotType = z.enum(['configuration', 'dependency', 'data', 'fleet'])

/** Explicit snapshots reject secret opt-in and filter known secret-file classes. */
export const snapshotsCapability = capability('dsh.snapshots', [
  { name: 'create', idempotency: 'idempotent', request: z.strictObject({ clientMutationId: id, type: snapshotType, includeSecretValues: z.literal(false).default(false) }), response: z.strictObject({ snapshotId: id, type: snapshotType, artifactHash: hash, createdAt: z.number().int().nonnegative(), manifest: z.json() }) },
  { name: 'list', idempotency: 'read', request: empty, response: z.strictObject({ snapshots: z.array(z.strictObject({ snapshotId: id, type: snapshotType, artifactHash: hash, createdAt: z.number().int().nonnegative() })).max(10_000) }) },
  { name: 'restore', idempotency: 'reconcile', request: z.strictObject({ snapshotId: id, expectedCurrentHash: hash.optional() }), response: z.strictObject({ restored: z.boolean(), currentHash: hash }) },
], [])

/** Runtime health and controlled restart stay separate from Hub execution. */
export const runtimeCapability = capability('dsh.runtime', [
  { name: 'health', idempotency: 'read', request: empty, response: z.strictObject({ status: z.enum(['healthy', 'degraded', 'unhealthy']), startedAt: z.number().int().nonnegative(), dshVersion: version, connectorVersion: version, details: z.json() }) },
], [{ name: 'health', reconstructible: true, frame: z.strictObject({ status: z.enum(['healthy', 'degraded', 'unhealthy']), details: z.json() }) }])

/** Settings expose schema and revision checks without exporting credential values. */
export const settingsCapability = capability('dsh.settings', [
  { name: 'read', idempotency: 'read', request: empty, response: z.strictObject({ revision: hash, schema: z.json(), values: z.json(), redactedPaths: z.array(path).max(10_000) }) },
  { name: 'update', idempotency: 'reconcile', request: z.strictObject({ expectedRevision: hash, patch: z.json() }), response: z.strictObject({ revision: hash, restartRequired: z.boolean() }) },
], [{ name: 'changed', reconstructible: true, frame: z.strictObject({ revision: hash }) }])

/** Workspace file access is node-authoritative and never mirrored by the Hub. */
export const filesCapability = capability('dsh.files', [
  { name: 'list', idempotency: 'read', request: z.strictObject({ path, cursor: z.string().max(512).optional(), limit: z.number().int().min(1).max(2_000).default(500) }), response: z.strictObject({ entries: z.array(z.strictObject({ path, kind: z.enum(['file', 'directory', 'symlink']), size: z.number().int().nonnegative().optional(), modifiedAt: z.number().int().nonnegative().optional() })).max(2_000), nextCursor: z.string().max(512).optional() }) },
  { name: 'read', idempotency: 'read', request: z.strictObject({ path, offset: z.number().int().nonnegative().default(0), maxBytes: z.number().int().min(1).max(4_194_304).default(1_048_576) }), response: z.strictObject({ encoding: z.enum(['utf8', 'base64']), data: z.string().max(5_592_408), eof: z.boolean(), contentHash: hash }) },
  { name: 'write', idempotency: 'reconcile', request: z.strictObject({ path, expectedHash: hash.nullable(), encoding: z.enum(['utf8', 'base64']), data: z.string().max(5_592_408) }), response: z.strictObject({ contentHash: hash, size: z.number().int().nonnegative() }) },
  { name: 'remove', idempotency: 'reconcile', request: z.strictObject({ path, expectedHash: hash.nullable(), recursive: z.boolean().default(false) }), response: ok },
], [])

/** All contracts implemented by the complete Connector profile. */
export const hubCapabilityContracts: readonly HubCapabilityContract[] = [
  sessionsCapability,
  terminalsCapability,
  pluginsCapability,
  snapshotsCapability,
  runtimeCapability,
  settingsCapability,
  filesCapability,
]

/**
 * Resolve one exact capability version and operation.
 * @param capabilityName - capability namespace advertised by a runtime.
 * @param capabilityVersion - exact capability contract version.
 * @param operationName - operation name within the capability.
 * @returns the matching operation contract, or `undefined` when unsupported.
 */
export function resolveHubOperation(
  capabilityName: string,
  capabilityVersion: string,
  operationName: string,
): HubOperationContract | undefined {
  const contract = hubCapabilityContracts.find(candidate =>
    candidate.descriptor.name === capabilityName && candidate.descriptor.version === capabilityVersion)
  return contract?.operations.get(operationName)
}

/**
 * Resolve one exact capability version and stream.
 * @param capabilityName - capability namespace advertised by a runtime.
 * @param capabilityVersion - exact capability contract version.
 * @param streamName - stream name within the capability.
 * @returns the matching stream contract, or `undefined` when unsupported.
 */
export function resolveHubStream(capabilityName: string, capabilityVersion: string, streamName: string): HubStreamContract | undefined {
  const contract = hubCapabilityContracts.find(candidate =>
    candidate.descriptor.name === capabilityName && candidate.descriptor.version === capabilityVersion)
  return contract?.streams.get(streamName)
}
