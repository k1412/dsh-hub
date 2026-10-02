import { describe, expect, it } from 'vitest'
import { SessionDirectory, SUPPORTED_VERSION, directoryResponse, renderDirectory, type Gateway, type Target } from '../src/index.ts'
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
export const target = (nodeId: string): Target => ({ nodeId, runtimeId: `runtime-${nodeId}`, generation: '1', name: nodeId,
  origin: `https://${nodeId}.example.invalid`, version: SUPPORTED_VERSION, online: true, capabilities: { sessionList: true } })
export const row = (sessionId = 'same', title = 'Title', updatedAt = 1) => ({ sessionId, updatedAt, running: false,
  agentAvailable: true, cwd: 'must-not-retain', projections: { values: { title, secret: 'must-not-retain' } } })

describe('injected gateway + directory + SSR integration', () => {
  it('routes simultaneous equal IDs by explicit node, Runtime and generation; no native links fabricated', async () => {
    const targets = [target('alpha'), target('beta')]
    const seen: string[] = []
    const directory = new SessionDirectory({ targets: () => targets, list: async (t, request) => {
      expect(request).toEqual({}); seen.push(`${t.nodeId}/${t.runtimeId}/${t.generation}`)
      await wait(t.nodeId === 'alpha' ? 15 : 1)
      return { items: [row('same', t.nodeId)] }
    } })
    try {
      const page = await directory.page()
      expect(seen).toEqual(['alpha/runtime-alpha/1', 'beta/runtime-beta/1'])
      expect(page.entries.map(r => [r.nodeId, r.title, r.sessionUrl])).toEqual([['alpha', 'alpha', null], ['beta', 'beta', null]])
      expect(JSON.stringify(page)).not.toContain('must-not-retain')
      const response = directoryResponse(page)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.text()).toContain('Native session link unavailable')
    } finally { directory.dispose() }
  })
  it('returns healthy rows during offline, rejection and uncooperative timeout within a bound', async () => {
    const targets = ['healthy', 'offline', 'broken', 'hung'].map(target)
    targets[1]!.online = false
    let cancelled = false
    const directory = new SessionDirectory({ targets: () => targets, list: async (t, _request, signal) => {
      if (t.nodeId === 'broken') throw new Error('private credentials must not leak')
      if (t.nodeId === 'hung') { signal.addEventListener('abort', () => { cancelled = true }); return new Promise(() => {}) }
      expect(t.nodeId).toBe('healthy'); return { items: [row()] }
    } }, { timeoutMs: 30 })
    try {
      const start = performance.now(), page = await directory.page()
      expect(performance.now() - start).toBeLessThan(300)
      expect(page.entries).toHaveLength(1)
      expect(page.nodes.map(n => n.state).sort()).toEqual(['error', 'offline', 'ok', 'timeout'])
      expect(cancelled).toBe(true)
      expect(JSON.stringify(page)).not.toContain('credentials')
    } finally { directory.dispose() }
  })
  it('rejects cancelled requests, aborts active work and never caches late responses', async () => {
    const t = target('alpha'); let calls = 0, aborted = 0
    const directory = new SessionDirectory({ targets: () => [t], list: async (_t, _request, signal) => {
      calls++; signal.addEventListener('abort', () => aborted++)
      await wait(40); return { items: [row()] }
    } })
    try {
      const controller = new AbortController(), pending = directory.page({ signal: controller.signal })
      setTimeout(() => controller.abort(new Error('cancelled')), 5)
      await expect(pending).rejects.toThrow('cancelled')
      await wait(45)
      expect(aborted).toBe(1)
      await directory.page(); expect(calls).toBe(2)
      controller.abort(); await expect(directory.page({ signal: controller.signal })).rejects.toThrow('cancelled')
    } finally { directory.dispose() }
  })
  it('discards old-generation in-flight rows and refreshes after reconnect with the same IDs', async () => {
    let t = target('alpha'), release!: (value: unknown) => void
    const directory = new SessionDirectory({ targets: () => [t], list: async snapshot => {
      if (snapshot.generation === '1') return new Promise(resolve => { release = resolve })
      return { items: [row('same', 'new-generation')] }
    } })
    try {
      const first = directory.page(); await wait(0)
      t = { ...t, generation: '2' }; directory.invalidate(t.nodeId)
      const oldPage = await first
      expect(oldPage.entries).toEqual([]); expect(oldPage.nodes[0]!.state).toBe('changed')
      release({ items: [row('same', 'stale')] })
      const fresh = await directory.page()
      expect(fresh.entries[0]!.title).toBe('new-generation')
      expect((await directory.page()).nodes[0]!.cached).toBe(true)
    } finally { directory.dispose() }
  })
  it('rechecks completed nodes after slow peers; revocation and Runtime replacement cannot leak cached rows', async () => {
    let targets = [target('alpha'), target('beta')]
    const directory = new SessionDirectory({ targets: () => targets, list: async t => {
      if (t.nodeId === 'beta') await wait(25)
      return { items: [row('same', t.runtimeId)] }
    } })
    try {
      const pending = directory.page()
      await wait(5); targets = [targets[1]!]
      expect((await pending).entries.map(r => r.nodeId)).toEqual(['beta'])
      targets = [{ ...target('alpha'), runtimeId: 'replacement' }]
      expect((await directory.page()).entries[0]!.title).toBe('replacement')
      targets[0]!.online = false
      expect((await directory.page()).entries).toEqual([])
    } finally { directory.dispose() }
  })
  it('enforces version/capabilities, escapes titles and refuses links to other origins', async () => {
    const targets = [target('alpha'), { ...target('beta'), version: '0.1.7' }]
    targets[0]!.capabilities.nativeNavigation = 'fixture-only'
    const gateway: Gateway = { targets: () => targets, list: async () => ({ items: [row('same', '<script>bad</script>')] }),
      sessionUrl: () => 'https://elsewhere.example.invalid/' }
    const directory = new SessionDirectory(gateway)
    try {
      const page = await directory.page()
      expect(page.nodes[1]!.state).toBe('unsupported')
      expect(page.entries[0]!.sessionUrl).toBeNull()
      expect(renderDirectory(page)).toContain('&lt;script&gt;')
      gateway.sessionUrl = t => `${t.origin}/?verified-fixture=same`
      expect((await directory.page()).entries[0]!.sessionUrl).toContain('verified-fixture')
    } finally { directory.dispose() }
  })
  it('pages many sessions deterministically, reports truncation, and expires metadata', async () => {
    let calls = 0
    const directory = new SessionDirectory({ targets: () => [target('alpha'), target('beta')], list: async () => {
      calls++; return { items: Array.from({ length: 2000 }, (_, i) => row(String(i), 'Title', i)) }
    } }, { cacheMs: 30, maxSessionsPerNode: 1000 })
    try {
      const first = await directory.page({ limit: 100 })
      const next = await directory.page({ limit: 100, offset: first.nextOffset! })
      expect(first.total).toBe(2000); expect(first.nodes.every(n => n.truncated)).toBe(true)
      expect(new Set([...first.entries, ...next.entries].map(r => `${r.nodeId}/${r.sessionId}`)).size).toBe(200)
      expect(calls).toBe(2)
      await wait(35); await directory.page(); expect(calls).toBe(4)
    } finally { directory.dispose() }
  })
  it('bounds fan-out concurrency and rejects malformed native lists without exposing raw data', async () => {
    let active = 0, maximum = 0
    const directory = new SessionDirectory({ targets: () => Array.from({ length: 12 }, (_, i) => target(`n${i}`)),
      list: async () => { active++; maximum = Math.max(maximum, active); await wait(2); active--; return { items: [row(), row()] } },
    }, { concurrency: 3 })
    try {
      const page = await directory.page()
      expect(maximum).toBe(3); expect(page.entries).toEqual([]); expect(page.nodes.every(n => n.state === 'error')).toBe(true)
      await expect(directory.page({ limit: 0 })).rejects.toThrow()
    } finally { directory.dispose() }
    await expect(directory.page()).rejects.toThrow('disposed')
  })
})

it('keeps cancellation local to each caller and invalidates after native metadata changes', async () => {
  let title = 'before', calls = 0
  const directory = new SessionDirectory({ targets: () => [target('alpha')], list: async () => {
    calls++; await wait(15); return { items: [row('same', title)] }
  } })
  try {
    const controller = new AbortController()
    const cancelled = directory.page({ signal: controller.signal }), live = directory.page()
    controller.abort(new Error('caller left'))
    await expect(cancelled).rejects.toThrow('caller left')
    expect((await live).entries[0]!.title).toBe('before')
    title = 'after'; directory.invalidate('alpha')
    expect((await directory.page()).entries[0]!.title).toBe('after')
    expect(calls).toBeGreaterThanOrEqual(2)
  } finally { directory.dispose() }
})
it('fails closed when different nodes share an origin or authorization repeats an owner', async () => {
  let targets = [target('alpha'), { ...target('beta'), origin: target('alpha').origin }]
  const directory = new SessionDirectory({ targets: () => targets, list: async () => ({ items: [] }) })
  try {
    await expect(directory.page()).rejects.toThrow('origins')
    targets = [target('alpha'), target('alpha')]
    await expect(directory.page()).rejects.toThrow('ownership')
  } finally { directory.dispose() }
})
