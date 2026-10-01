import { describe, expect, it } from 'vitest'
import { legacyWebProjectionValues, needsLegacyPermissionCatalog } from '../src/web-projections.ts'

describe('current projections in pinned Web', () => {
  it('joins the separate permission catalog without changing the durable selection or source object', () => {
    const values = { permissions: { currentValue: 'custom' }, title: null, modelSelection: { next: null } }
    const options = [{ value: 'workspace-write', name: 'Workspace write' }]
    expect(needsLegacyPermissionCatalog(values)).toBe(true)
    expect(legacyWebProjectionValues(values, options)).toEqual({ ...values, permissions: { currentValue: 'custom', options } })
    expect(values.permissions).toEqual({ currentValue: 'custom' })
  })
  it('preserves a native legacy catalog and drops nullable absent controls', () => {
    const permissions = { currentValue: 'configured', options: [{ value: 'configured', name: 'Configured' }] }
    expect(needsLegacyPermissionCatalog({ permissions })).toBe(false)
    expect(legacyWebProjectionValues({ permissions, plan: null }, [])).toEqual({ permissions })
    expect(legacyWebProjectionValues({ permissions: null, title: null }, [])).toEqual({ title: null })
  })
})
