import { describe, expect, it } from 'vitest'
import { classifyDshCompatibility, DSH_HOST_API_FAMILY } from '../src/dsh-compatibility.ts'

describe('DSH compatibility reporting', () => {
  it('marks the pinned Host API family as supported', () => {
    expect(classifyDshCompatibility(DSH_HOST_API_FAMILY)).toEqual({
      status: 'supported', adapterFamily: DSH_HOST_API_FAMILY,
    })
  })

  it('reports newer upstream releases as requiring an adapter upgrade', () => {
    const result = classifyDshCompatibility('0.1.6-alpha.2')
    expect(result.status).toBe('upgrade-required')
    expect(result.reason).toContain('0.1.6-alpha.2')
  })

  it('does not hide a missing runtime version', () => {
    expect(classifyDshCompatibility('')).toMatchObject({ status: 'unknown' })
  })
})
