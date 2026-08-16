/** Optional DSH Hub target carried by a tab's URL without affecting local Web deployments. */

const TARGET_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/

/**
 * Add the tab-local Hub target to an API or stream URL when both identifiers are present.
 * @param input - target URL built by the ordinary Web carrier.
 * @returns the same URL with Hub routing parameters, or unchanged outside Hub mode.
 */
export function withHubTarget(input: URL): URL {
  const location = (globalThis as { location?: { search?: string } }).location
  if (location?.search === undefined) return input
  const source = new URLSearchParams(location.search)
  const nodeId = source.get('nodeId')
  const runtimeId = source.get('runtimeId')
  if (nodeId === null || runtimeId === null || !TARGET_ID.test(nodeId) || !TARGET_ID.test(runtimeId)) return input
  input.searchParams.set('nodeId', nodeId)
  input.searchParams.set('runtimeId', runtimeId)
  return input
}
