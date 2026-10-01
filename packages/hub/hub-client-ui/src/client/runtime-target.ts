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
  for (const storage of ['sessionStorage', 'localStorage'] as const) {
    try {
      const raw = globalThis[storage].getItem(STORAGE_KEY)
      if (raw === null) continue
      const value = JSON.parse(raw) as unknown
      if (validTarget(value)) return value
    } catch { /* Try the last-used choice when tab storage is unavailable. */ }
  }
  return undefined
}

function persistTarget(target: HubRuntimeTarget): void {
  try {
    globalThis.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(target))
  } catch {
    // The current picker still owns the in-memory selection.
  }
  try { globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(target)) } catch { /* Last-used choice is optional. */ }
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
 * Read a legacy bookmark hint, then the tab selection and last-used Runtime.
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
 * Persist a tab-local Runtime choice and keep the Hub page URL canonical without remounting Web.
 * @param target - selected node and Runtime.
 */
export function replaceRuntimeTarget(target: HubRuntimeTarget): void {
  if (!validTarget(target)) throw new Error('Runtime target is malformed')
  persistTarget({ nodeId: target.nodeId, runtimeId: target.runtimeId })
  const url = new URL(globalThis.location.href)
  url.searchParams.delete('nodeId')
  url.searchParams.delete('runtimeId')
  globalThis.history.replaceState(globalThis.history.state, '', url)
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
