import { describe, expect, it } from 'vitest'
import { classifyDshCompatibility, DSH_HOST_API_FAMILY, DSH_SUPPORTED_VERSIONS } from '../src/dsh-compatibility.ts'

describe('DSH compatibility reporting', () => {
  it('marks the pinned Host API family as supported', () => {
    expect(classifyDshCompatibility(DSH_HOST_API_FAMILY)).toEqual({
      status: 'supported', adapterFamily: DSH_HOST_API_FAMILY,
    })
  })

  it('marks every tested current Remote release as supported', () => {
    for (const version of DSH_SUPPORTED_VERSIONS.filter(version => version !== DSH_HOST_API_FAMILY)) {
      expect(classifyDshCompatibility(version)).toEqual({
        status: 'supported', adapterFamily: DSH_HOST_API_FAMILY,
      })
    }
  })

  it('reports an untested upstream release as requiring an adapter upgrade', () => {
    const result = classifyDshCompatibility('0.1.8-alpha.1')
    expect(result.status).toBe('upgrade-required')
    expect(result.reason).toContain('0.1.8-alpha.1')
  })

  it('does not hide a missing runtime version', () => {
    expect(classifyDshCompatibility('')).toMatchObject({ status: 'unknown' })
  })
})
