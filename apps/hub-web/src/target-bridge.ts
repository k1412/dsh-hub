/**
 * Transport bridge for Web bundles that predate the Hub target carrier.
 *
 * The official Web app has changed its connection package layout several
 * times. Keeping this small adapter at the page boundary lets a reviewed
 * bundle use the same `?nodeId=...&runtimeId=...` contract without rebuilding
 * every upstream package whenever that layout changes.
 */

export interface HubTarget {
  nodeId: string
  runtimeId: string
}

const TARGET_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/iu

/** Read and validate the selected Runtime from a browser query string. */
export function readHubTarget(search: string): HubTarget | undefined {
  const query = new URLSearchParams(search)
  const nodeId = query.get('nodeId')
  const runtimeId = query.get('runtimeId')
  if (nodeId === null || runtimeId === null || !TARGET_ID.test(nodeId) || !TARGET_ID.test(runtimeId)) {
    return undefined
  }
  return { nodeId, runtimeId }
}

/** Add the selected Runtime to one DSH `/api` HTTP or WebSocket URL. */
export function withHubTarget(input: string | URL, search: string, base = 'http://dsh-hub.invalid'): URL {
  const url = new URL(input.toString(), base)
  const target = readHubTarget(search)
  if (target !== undefined && (url.pathname === '/api' || url.pathname.startsWith('/api/'))) {
    url.searchParams.set('nodeId', target.nodeId)
    url.searchParams.set('runtimeId', target.runtimeId)
  }
  return url
}

/** Install the bridge before the official Web module graph starts loading. */
export function installHubTargetBridge(): void {
  if (typeof globalThis.location === 'undefined') return
  const search = () => globalThis.location.search
  const base = () => globalThis.location.href

  const fetchImpl = globalThis.fetch.bind(globalThis)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request) {
      const url = withHubTarget(input.url, search(), base())
      return fetchImpl(new Request(url, input), init)
    }
    const url = withHubTarget(input instanceof URL ? input : String(input), search(), base())
    return fetchImpl(url, init)
  }) as typeof globalThis.fetch

  const NativeWebSocket = globalThis.WebSocket
  globalThis.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, argumentsList, newTarget) {
      const [input, protocols] = argumentsList as [string | URL, string | string[] | undefined]
      const url = withHubTarget(input, search(), base())
      return Reflect.construct(target, [url, protocols], newTarget)
    },
  })
}

installHubTargetBridge()
