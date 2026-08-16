/** Browser-side selection and fleet-identity helpers for the Hub Runtime picker. */

/** Address of one DSH Runtime connected to Hub. */
export interface HubRuntimeTarget {
  nodeId: string
  runtimeId: string
}

interface CapabilityCarrier extends HubRuntimeTarget {
  capabilities: Array<{ name: string; operations: Array<{ name: string }> }>
}

const TARGET_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i
const FLEET_WORKSPACE_ID = /^hub-workspace-([A-Za-z0-9_-]+)$/
const STORAGE_KEY = 'dsh.hub.runtime-target'

function validTarget(value: unknown): value is HubRuntimeTarget {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.nodeId === 'string' && TARGET_ID.test(record.nodeId)
    && typeof record.runtimeId === 'string' && TARGET_ID.test(record.runtimeId)
}

function storedTarget(): HubRuntimeTarget | undefined {
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return undefined
    const value = JSON.parse(raw) as unknown
    return validTarget(value) ? value : undefined
  } catch {
    return undefined
  }
}

function persistTarget(target: HubRuntimeTarget): void {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(target))
  } catch {
    // URL state remains authoritative when browser storage is unavailable.
  }
}

/**
 * Build a collision-free key for one Runtime address.
 * @param target - node and Runtime identity.
 * @returns the stable in-memory key.
 */
export function runtimeKey(target: HubRuntimeTarget): string {
  return `${target.nodeId}\u0000${target.runtimeId}`
}

/**
 * Determine whether a Runtime can serve official DSH Web traffic.
 * @param runtime - advertised Runtime capability roster.
 * @returns true when the Connector exposes dsh.web.fetch.
 */
export function supportsOfficialWeb(runtime: CapabilityCarrier): boolean {
  return runtime.capabilities.some(capability => capability.name === 'dsh.web'
    && capability.operations.some(operation => operation.name === 'fetch'))
}

/**
 * Read the explicit URL target, falling back to the most recently selected Runtime.
 * @returns a validated target or undefined when neither source contains one.
 */
export function readRuntimeTarget(): HubRuntimeTarget | undefined {
  const query = new URL(globalThis.location.href).searchParams
  const candidate = { nodeId: query.get('nodeId'), runtimeId: query.get('runtimeId') }
  if (typeof candidate.nodeId === 'string' && typeof candidate.runtimeId === 'string'
    && validTarget(candidate)) return candidate
  return storedTarget()
}

/**
 * Persist a Runtime choice and update the current URL without remounting official Web.
 * @param target - selected node and Runtime.
 */
export function replaceRuntimeTarget(target: HubRuntimeTarget): void {
  if (!validTarget(target)) throw new Error('Runtime target is malformed')
  persistTarget(target)
  const url = new URL(globalThis.location.href)
  url.searchParams.set('nodeId', target.nodeId)
  url.searchParams.set('runtimeId', target.runtimeId)
  globalThis.history.replaceState(globalThis.history.state, '', url)
}

/**
 * Persist a Runtime choice and reload official Web on that target.
 * @param target - selected node and Runtime.
 */
export function navigateRuntimeTarget(target: HubRuntimeTarget): void {
  if (!validTarget(target)) throw new Error('Runtime target is malformed')
  persistTarget(target)
  const url = new URL(globalThis.location.href)
  url.searchParams.set('nodeId', target.nodeId)
  url.searchParams.set('runtimeId', target.runtimeId)
  globalThis.location.assign(url)
}

function decodeBase64url(value: string): string | undefined {
  if (value.length % 4 === 1) return undefined
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
      .padEnd(value.length + ((4 - value.length % 4) % 4), '=')
    const binary = globalThis.atob(padded)
    let canonical = globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
    if (canonical !== value) return undefined
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    canonical = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return canonical
  } catch {
    return undefined
  }
}

/**
 * Recover the owning Runtime from a Hub-minted Workspace id.
 * @param workspaceId - opaque browser-visible Workspace identity.
 * @returns its validated owner, or undefined for local or malformed ids.
 */
export function runtimeTargetOfWorkspace(workspaceId: string): HubRuntimeTarget | undefined {
  const match = FLEET_WORKSPACE_ID.exec(workspaceId)
  if (match === null) return undefined
  const source = decodeBase64url(match[1] as string)
  if (source === undefined) return undefined
  try {
    const value = JSON.parse(source) as unknown
    if (!Array.isArray(value) || value.length !== 3 || value.some(item => typeof item !== 'string')) {
      return undefined
    }
    const [nodeId, runtimeId, sourceId] = value as [string, string, string]
    const target = { nodeId, runtimeId }
    return validTarget(target) && sourceId.length > 0 && sourceId.length <= 65_536 ? target : undefined
  } catch {
    return undefined
  }
}
