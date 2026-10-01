/** Route ownerless node operations from tab state while keeping one fleet-wide Hub page. */

export interface HubTarget {
  nodeId: string
  runtimeId: string
}

const STORAGE_KEY = 'dsh.hub.runtime-target'
const FLEET_PATH = /^\/api\/(?:session[./](?:list|search)|workspace[./]list|events[./](?:mux|host)|remote[./]mux)$/u

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
export function withHubTarget(input: string | URL, search: string, base = 'http://dsh-hub.invalid', selected = readHubTarget(search)): URL {
  const url = new URL(input.toString(), base)
  if (FLEET_PATH.test(url.pathname)) {
    url.searchParams.delete('nodeId'); url.searchParams.delete('runtimeId'); return url
  }
  const target = selected
  if (target !== undefined && (url.pathname === '/api' || url.pathname.startsWith('/api/'))) {
    url.searchParams.set('nodeId', target.nodeId)
    url.searchParams.set('runtimeId', target.runtimeId)
  }
  return url
}

/** Import old node bookmarks as a creation/settings hint, preserving other URL state. */
export function adoptLegacyHubTarget(): void {
  const url = new URL(globalThis.location.href)
  const target = readHubTarget(url.search)
  if (target !== undefined) {
    for (const storage of ['sessionStorage', 'localStorage'] as const) {
      try { globalThis[storage].setItem(STORAGE_KEY, JSON.stringify(target)) } catch { /* Storage may be disabled. */ }
    }
  }
  if (url.searchParams.has('nodeId') || url.searchParams.has('runtimeId')) {
    url.searchParams.delete('nodeId'); url.searchParams.delete('runtimeId')
    globalThis.history.replaceState(globalThis.history.state, '', url)
  }
}

function selectedTarget(): HubTarget | undefined {
  for (const storage of ['sessionStorage', 'localStorage'] as const) {
    try {
      const raw = globalThis[storage].getItem(STORAGE_KEY)
      const target = raw === null ? undefined : JSON.parse(raw) as Partial<HubTarget>
      if (typeof target?.nodeId === 'string' && typeof target.runtimeId === 'string'
        && TARGET_ID.test(target.nodeId) && TARGET_ID.test(target.runtimeId)) return target as HubTarget
    } catch { /* A malformed or unavailable saved choice is ignored. */ }
  }
  return undefined
}

const ONBOARDING_NAMESPACE = 'ui-onboarding'
const ONBOARDING_FIELD = 'welcomeNoticeVersion'
const onboardingFallbacks = new Set<string>()

function onboardingView(key: string): Record<string, unknown> {
  let version: string | null = null
  try { version = globalThis.sessionStorage.getItem(`dsh.hub.welcome.${key}`) } catch { /* Optional tab acknowledgement. */ }
  return { ns: ONBOARDING_NAMESPACE, schema: {}, value: version === null ? {} : { [ONBOARDING_FIELD]: version },
    applies: 'live', secrets: [], revision: 0 }
}

function jsonResponse(response: Response, body: unknown): Response {
  const headers = new Headers(response.headers)
  headers.delete('content-length'); headers.delete('content-encoding')
  return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers })
}

/**
 * Older Web displays a blocking notice whose native settings namespace no longer exists.
 * Use tab-local acknowledgement only when a successful native description proves it absent.
 * Native namespaces and failed requests keep their original responses and persistence.
 */
export async function fetchWithHubCompatibility(url: URL, input: RequestInfo | URL, init: RequestInit | undefined,
  fetchImpl: typeof globalThis.fetch): Promise<Response> {
  const key = `${url.searchParams.get('nodeId') ?? ''}/${url.searchParams.get('runtimeId') ?? ''}`
  if (url.pathname === '/api/settings.mutate' && onboardingFallbacks.has(key)) {
    const raw = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : undefined
    if (raw !== undefined) {
      const message = JSON.parse(raw) as { rpcId?: string; payload?: { ns?: string; ops?: Array<{ op: string; path: string[]; value: unknown }> } }
      const ops = message.payload?.ops
      if (message.payload?.ns === ONBOARDING_NAMESPACE && ops?.length === 1 && ops[0]?.op === 'set'
        && ops[0].path.length === 1 && ops[0].path[0] === ONBOARDING_FIELD
        && typeof ops[0].value === 'string' && ops[0].value.length <= 256) {
        try { globalThis.sessionStorage.setItem(`dsh.hub.welcome.${key}`, ops[0].value) } catch { /* Memory acknowledgement still advances this page. */ }
        return Response.json({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: onboardingView(key) } })
      }
    }
  }
  const response = await fetchImpl(input, init)
  if (url.pathname !== '/api/settings.describe' || !response.ok) return response
  const body = await response.clone().json() as { result?: { ok: boolean; value?: { namespaces?: Array<{ ns?: string }> } } }
  const namespaces = body.result?.value?.namespaces
  if (body.result?.ok && Array.isArray(namespaces) && !namespaces.some(row => row.ns === ONBOARDING_NAMESPACE)) {
    onboardingFallbacks.add(key)
    namespaces.push(onboardingView(key))
    return jsonResponse(response, body)
  }
  onboardingFallbacks.delete(key)
  return response
}

/** Install the bridge before the official Web module graph starts loading. */
export function installHubTargetBridge(): void {
  if (typeof globalThis.location === 'undefined') return
  adoptLegacyHubTarget()
  const search = () => globalThis.location.search
  const base = () => globalThis.location.href

  const fetchImpl = globalThis.fetch.bind(globalThis)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request) {
      const url = withHubTarget(input.url, search(), base(), selectedTarget())
      return fetchWithHubCompatibility(url, new Request(url, input), init, fetchImpl)
    }
    const url = withHubTarget(input instanceof URL ? input : String(input), search(), base(), selectedTarget())
    return fetchWithHubCompatibility(url, url, init, fetchImpl)
  }) as typeof globalThis.fetch

  const NativeWebSocket = globalThis.WebSocket
  globalThis.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, argumentsList, newTarget) {
      const [input, protocols] = argumentsList as [string | URL, string | string[] | undefined]
      const url = withHubTarget(input, search(), base(), selectedTarget())
      return Reflect.construct(target, [url, protocols], newTarget)
    },
  })
}

installHubTargetBridge()
