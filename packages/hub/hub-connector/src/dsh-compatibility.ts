/** DSH release families understood by the current Connector adapter. */

export const DSH_HOST_API_FAMILY = '0.1.0-rc.7' as const

/**
 * The current Connector imports the legacy Host ApiProxy and Session APIs.
 * Keep this check explicit so an upstream upgrade is reported as a compatibility
 * problem instead of looking like a random failed command in the Hub UI.
 */
export function classifyDshCompatibility(version: string): {
  status: 'supported' | 'upgrade-required' | 'unknown'
  adapterFamily: string
  reason?: string
} {
  if (version === '' || version === 'unknown') {
    return { status: 'unknown', adapterFamily: DSH_HOST_API_FAMILY, reason: 'DSH version was not advertised' }
  }
  if (version === DSH_HOST_API_FAMILY) {
    return { status: 'supported', adapterFamily: DSH_HOST_API_FAMILY }
  }
  return {
    status: 'upgrade-required',
    adapterFamily: DSH_HOST_API_FAMILY,
    reason: `Connector adapter ${DSH_HOST_API_FAMILY} does not claim compatibility with DSH ${version}`,
  }
}
