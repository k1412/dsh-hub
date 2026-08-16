/** Same-origin operator API used only by Hub settings extensions. */

import { navigateRuntimeTarget } from './runtime-target.ts'

/** Operator-visible identity and live state for one enrolled physical node. */
export interface HubNode {
  nodeId: string
  displayName: string
  status: 'active' | 'revoked'
  online: boolean
  lastSeenAt?: number
  createdAt: number
  revokedAt?: number
}

/** Version and operations advertised by one node Runtime capability. */
export interface HubCapabilityDescriptor {
  name: string
  version: string
  operations: Array<{ name: string }>
}

/** One connected or last-known DSH Runtime exposed by an enrolled node. */
export interface HubRuntime {
  nodeId: string
  runtimeId: string
  dshVersion: string
  connectorVersion: string
  online: boolean
  lastSeenAt: number
  capabilities: HubCapabilityDescriptor[]
}

/** One unconsumed enrollment reservation without its one-time secret. */
export interface PendingEnrollment {
  nodeId: string
  displayName: string
  expiresAt: number
  createdAt: number
}

/** Newly created enrollment reservation carrying its one-time code. */
export interface EnrollmentGrant extends PendingEnrollment {
  code: string
}

/** Node, Runtime, and pending-enrollment baseline rendered in Settings. */
export interface FleetSnapshot {
  nodes: HubNode[]
  runtimes: HubRuntime[]
  enrollments: PendingEnrollment[]
}

interface HubCommand {
  commandId: string
  status: 'pending' | 'sent' | 'running' | 'ok' | 'error' | 'outcome-unknown'
  result?: unknown
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const body = await response.json() as T & { error?: unknown }
  if (!response.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${String(response.status)}`)
  }
  return body
}

function mutation(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/**
 * Read enrolled nodes, runtimes, and outstanding enrollment reservations.
 * @returns the current operator-visible fleet baseline.
 */
export async function readFleet(): Promise<FleetSnapshot> {
  const [fleet, pending] = await Promise.all([
    requestJson<{ nodes: HubNode[]; runtimes: HubRuntime[] }>('/hub/v1/nodes'),
    requestJson<{ enrollments: PendingEnrollment[] }>('/hub/v1/enrollments'),
  ])
  return { ...fleet, enrollments: pending.enrollments }
}

/**
 * Reserve a node id and return its one-time enrollment code.
 * @param input - stable identity, display name, and grant lifetime.
 * @returns the reservation and one-time plaintext code.
 */
export function createEnrollment(input: {
  nodeId: string
  displayName: string
  expiresInSeconds: number
}): Promise<EnrollmentGrant> {
  return requestJson('/hub/v1/enrollments', mutation(input))
}

/**
 * Cancel an enrollment code that has not been consumed.
 * @param nodeId - reserved node identity.
 */
export async function cancelEnrollment(nodeId: string): Promise<void> {
  await requestJson(`/hub/v1/enrollments/${encodeURIComponent(nodeId)}/cancel`, mutation({}))
}

/**
 * Permanently revoke a node identity and fence its active connection.
 * @param nodeId - enrolled node identity.
 */
export async function revokeNode(nodeId: string): Promise<void> {
  await requestJson(`/hub/v1/nodes/${encodeURIComponent(nodeId)}/revoke`, mutation({}))
}

function operationOf(runtime: HubRuntime, capability: string, operation: string): HubCapabilityDescriptor {
  const descriptor = runtime.capabilities.find(candidate => candidate.name === capability)
  if (descriptor === undefined || !descriptor.operations.some(candidate => candidate.name === operation)) {
    throw new Error(`节点不支持 ${capability}.${operation}`)
  }
  return descriptor
}

/**
 * Invoke one runtime capability and return its validated terminal result.
 * @param runtime - exact target Runtime.
 * @param capability - advertised capability namespace.
 * @param operation - advertised operation name.
 * @param payload - operation-specific request body.
 * @returns the acknowledged node result.
 */
export async function invoke<T>(runtime: HubRuntime, capability: string, operation: string, payload: unknown): Promise<T> {
  const descriptor = operationOf(runtime, capability, operation)
  const created = await requestJson<{ command: HubCommand }>('/hub/v1/commands', mutation({
    nodeId: runtime.nodeId,
    runtimeId: runtime.runtimeId,
    capability,
    capabilityVersion: descriptor.version,
    operation,
    payload,
  }))
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const { command } = await requestJson<{ command: HubCommand }>(
      `/hub/v1/commands/${encodeURIComponent(created.command.commandId)}`,
    )
    if (command.status === 'ok') {
      await requestJson(`/hub/v1/commands/${encodeURIComponent(command.commandId)}`, mutation({}))
      return command.result as T
    }
    if (command.status === 'error' || command.status === 'outcome-unknown') {
      const message = typeof command.result === 'object' && command.result !== null
        && 'message' in command.result && typeof command.result.message === 'string'
        ? command.result.message
        : `节点操作失败：${command.status}`
      await requestJson(`/hub/v1/commands/${encodeURIComponent(command.commandId)}`, mutation({}))
      throw new Error(message)
    }
    await new Promise(resolve => globalThis.setTimeout(resolve, 250))
  }
  throw new Error('节点操作仍在执行，请稍后刷新')
}

/**
 * Switch the official Web UI to one runtime without changing local Web behavior.
 * @param runtime - target node and Runtime identity.
 */
export function switchRuntime(runtime: Pick<HubRuntime, 'nodeId' | 'runtimeId'>): void {
  navigateRuntimeTarget(runtime)
}
