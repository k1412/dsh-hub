import { SessionDirectory, SUPPORTED_VERSION, renderDirectory, type Gateway, type Target } from './index.ts'
export interface ProbeOptions { iterations?: number; timeoutMs?: number; p95BudgetMs?: number }
export interface ProbeReport {
  name: string; iterations: number; succeeded: number; failed: number; p50Ms: number; p95Ms: number; maxMs: number
  p95BudgetMs: number; passed: boolean
}
/** Root can inject native page-load / reconnect probes; no prompts or LLM calls are required. */
export async function measureProbe(name: string, operation: (signal: AbortSignal, iteration: number) => Promise<void>,
  options: ProbeOptions = {}): Promise<ProbeReport> {
  const iterations = options.iterations ?? 30, timeoutMs = options.timeoutMs ?? 1000, p95BudgetMs = options.p95BudgetMs ?? 250
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100_000
    || !Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isFinite(p95BudgetMs) || p95BudgetMs <= 0) throw new RangeError('Invalid probe bounds')
  const times: number[] = []; let failed = 0
  for (let i = 0; i < iterations; i++) {
    const controller = new AbortController(), start = performance.now()
    let timer!: ReturnType<typeof setTimeout>
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Probe timed out')) }, timeoutMs)
    })
    try { await Promise.race([Promise.resolve().then(() => operation(controller.signal, i)), deadline]) }
    catch { failed++ }
    finally { clearTimeout(timer); controller.abort(); times.push(performance.now() - start) }
  }
  times.sort((a, b) => a - b)
  const percentile = (p: number): number => Number((times[Math.max(0, Math.ceil(times.length * p) - 1)] ?? 0).toFixed(3))
  const p95Ms = percentile(0.95)
  return { name, iterations, succeeded: iterations - failed, failed, p50Ms: percentile(0.5), p95Ms,
    maxMs: percentile(1), p95BudgetMs, passed: failed === 0 && p95Ms <= p95BudgetMs }
}
export interface BenchmarkOptions { nodes?: number; sessionsPerNode?: number; iterations?: number; cycles?: number; delayMs?: number }
export interface BenchmarkReport {
  schema: 'dsh-session-directory-benchmark/v1'; kind: 'synthetic-no-llm'; measuredAt: string
  configuration: Required<BenchmarkOptions>; probes: ProbeReport[]; passed: boolean
  limitations: string[]
}
function assert(condition: unknown): asserts condition { if (!condition) throw new Error('Benchmark invariant failed') }
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const abort = (): void => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}
/** Metadata and transport timing fixtures, not a claim about native DSH or the network. */
export async function runSyntheticBenchmark(options: BenchmarkOptions = {}): Promise<BenchmarkReport> {
  const config = { nodes: options.nodes ?? 8, sessionsPerNode: options.sessionsPerNode ?? 5000,
    iterations: options.iterations ?? 30, cycles: options.cycles ?? 100, delayMs: options.delayMs ?? 2 }
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < (key === 'delayMs' ? 0 : 1)) throw new RangeError('Invalid fixture bounds')
  }
  if (config.nodes < 2 || config.nodes > 64 || config.sessionsPerNode > 100_000 || config.cycles > 10_000 || config.delayMs > 100) throw new RangeError('Fixture too large')
  const targets: Target[] = Array.from({ length: config.nodes }, (_, i) => ({ nodeId: `node-${i}`, runtimeId: `runtime-${i}`,
    generation: '0', name: `Node ${i}`, origin: `https://node-${i}.example.invalid`, version: SUPPORTED_VERSION,
    online: true, capabilities: { sessionList: true } }))
  let mode: 'normal' | 'hung' = 'normal', nativeCalls = 0
  const gateway: Gateway = { targets: () => targets, list: async (t, _request, signal) => {
    nativeCalls++
    if (mode === 'hung' && t.nodeId === 'node-0') { await delay(10_000, signal) }
    await delay(config.delayMs, signal)
    return { archivedSessionIds: [], items: Array.from({ length: config.sessionsPerNode }, (_, i) => ({ sessionId: `session-${i}`,
      updatedAt: i, running: i % 7 === 0, agentAvailable: true, projections: { values: { title: `${t.nodeId}:${t.generation}:${i}` } } })) }
  } }
  const directory = new SessionDirectory(gateway, { timeoutMs: 150, maxSessionsPerNode: config.sessionsPerNode })
  const probes: ProbeReport[] = []
  try {
    probes.push(await measureProbe('node-only-index-fixture', async () => {
      const html = gateway.targets().map(t => `<a href="${t.origin}/">${t.name}</a>`).join('')
      assert(html.length > 0)
    }, { iterations: config.iterations, p95BudgetMs: 25 }))
    probes.push(await measureProbe('directory-cold-fanout-and-ssr', async signal => {
      directory.invalidate()
      const page = await directory.page({ signal, limit: 100 })
      assert(page.total === config.nodes * config.sessionsPerNode && page.nodes.every(n => n.state === 'ok'))
      assert(renderDirectory(page).includes('Session directory'))
      assert(new Set(page.entries.map(r => `${r.nodeId}/${r.runtimeId}/${r.sessionId}`)).size === page.entries.length)
    }, { iterations: config.iterations, p95BudgetMs: 500 }))
    probes.push(await measureProbe('directory-warm-and-ssr', async signal => {
      const page = await directory.page({ signal, limit: 100 })
      assert(page.total === config.nodes * config.sessionsPerNode)
      renderDirectory(page)
    }, { iterations: config.iterations, p95BudgetMs: 250 }))
    probes.push(await measureProbe('disconnect-reconnect-refresh', async (signal, i) => {
      const t = targets[0]
      assert(t)
      t.online = false; directory.invalidate(t.nodeId)
      const offline = await directory.page({ signal })
      assert(!offline.entries.some(r => r.nodeId === t.nodeId))
      t.online = true; t.generation = String(i + 1); directory.invalidate(t.nodeId)
      const before = nativeCalls, online = await directory.page({ signal, limit: 100 })
      assert(nativeCalls > before && online.nodes.every(n => n.state === 'ok'))
      const own = online.entries.filter(r => r.nodeId === t.nodeId)
      assert(own.length > 0 && own.every(r => r.title?.startsWith(`${t.nodeId}:${t.generation}:`)))
    }, { iterations: config.cycles, p95BudgetMs: 500 }))
    mode = 'hung'
    probes.push(await measureProbe('partial-timeout', async signal => {
      directory.invalidate()
      const page = await directory.page({ signal })
      assert(page.nodes.find(n => n.nodeId === 'node-0')?.state === 'timeout')
      assert(page.total === (config.nodes - 1) * config.sessionsPerNode)
    }, { iterations: 5, p95BudgetMs: 500 }))
    probes.push(await measureProbe('caller-cancellation', async () => {
      directory.invalidate()
      const controller = new AbortController()
      const pending = directory.page({ signal: controller.signal })
      const timer = setTimeout(() => controller.abort(new Error('cancelled')), 5)
      let rejected = false
      try { await pending } catch { rejected = controller.signal.aborted } finally { clearTimeout(timer) }
      assert(rejected)
    }, { iterations: 10, p95BudgetMs: 100 }))
  } finally { directory.dispose() }
  return { schema: 'dsh-session-directory-benchmark/v1', kind: 'synthetic-no-llm', measuredAt: new Date().toISOString(),
    configuration: config, probes, passed: probes.every(p => p.passed), limitations: [
      'Synthetic injected transport; does not measure live Tailscale/Tailcat, native Web load, or DSH persistence listing.',
      'Native session deep-link support was not found; no browser navigation success is claimed.',
      'Node-only index is an in-memory fixture baseline, not the root gateway performance result.',
      'Warm paging still sorts retained metadata; rc.2 native listing has no effective pagination.',
    ] }
}
