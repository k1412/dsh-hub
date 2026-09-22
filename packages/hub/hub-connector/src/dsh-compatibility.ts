/** DSH release families understood by the current Connector adapter. */

export const DSH_HOST_API_FAMILY = '0.1.0-rc.7' as const

/** DSH releases whose Host/Remote contracts are covered by this Connector. */
export const DSH_SUPPORTED_VERSIONS = [
  DSH_HOST_API_FAMILY,
  '0.1.5-rc.2',
  '0.1.5-rc.3',
  '0.1.6-alpha.2',
  '0.1.7-alpha.1',
] as const

/**
 * Keep this check explicit so an upstream upgrade is reported as a compatibility
 * problem instead of looking like a random failed command in the Hub UI. The
 * adapter family remains the legacy family for diagnostics; current releases
 * use the structural Typert Remote fallback while older nodes use ApiProxy.
 */
export function classifyDshCompatibility(version: string): {
  status: 'supported' | 'upgrade-required' | 'unknown'
  adapterFamily: string
  reason?: string
} {
  if (version === '' || version === 'unknown') {
    return { status: 'unknown', adapterFamily: DSH_HOST_API_FAMILY, reason: 'DSH version was not advertised' }
  }
  if ((DSH_SUPPORTED_VERSIONS as readonly string[]).includes(version)) {
    return { status: 'supported', adapterFamily: DSH_HOST_API_FAMILY }
  }
  return {
    status: 'upgrade-required',
    adapterFamily: DSH_HOST_API_FAMILY,
    reason: `Connector adapter ${DSH_HOST_API_FAMILY} does not claim compatibility with DSH ${version}`,
  }
}
