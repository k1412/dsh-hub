/** Translate current projection values for the pinned Web's presentation contract. */
export interface LegacyPermissionOption {
  value: string
  name: string
  description?: string
}

/** Preserve durable values, adding only the catalog older Web expects inline. */
export function legacyWebProjectionValues(values: Record<string, unknown>, options: LegacyPermissionOption[]): Record<string, unknown> {
  const result = { ...values }
  if (result.plan === null) delete result.plan
  if (result.permissions === null) delete result.permissions
  const permission = result.permissions
  if (typeof permission === 'object' && permission !== null && !Array.isArray(permission)) {
    const selection = permission as Record<string, unknown>
    if (typeof selection.currentValue === 'string' && !Array.isArray(selection.options)) {
      result.permissions = { ...selection, options }
    }
  }
  return result
}

/** Only current-value-only permission snapshots need a separate native catalog. */
export function needsLegacyPermissionCatalog(values: Record<string, unknown>): boolean {
  const permission = values.permissions
  if (typeof permission !== 'object' || permission === null || Array.isArray(permission)) return false
  const selection = permission as Record<string, unknown>
  return typeof selection.currentValue === 'string' && !Array.isArray(selection.options)
}
