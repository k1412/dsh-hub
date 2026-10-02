import { expect, it } from 'vitest'
import { measureProbe, runSyntheticBenchmark } from '../src/benchmark.ts'
it('executes bounded stability fixtures and produces structured, explicitly synthetic metrics', async () => {
  const report = await runSyntheticBenchmark({ nodes: 2, sessionsPerNode: 120, iterations: 2, cycles: 3, delayMs: 1 })
  expect(report.passed).toBe(true)
  expect(report.kind).toBe('synthetic-no-llm')
  expect(report.probes.find(p => p.name === 'disconnect-reconnect-refresh')?.succeeded).toBe(3)
})
it('reports failed and uncooperative probes instead of presenting successes', async () => {
  const report = await measureProbe('stuck', async () => new Promise(() => {}), { iterations: 2, timeoutMs: 5 })
  expect(report.failed).toBe(2); expect(report.passed).toBe(false)
})
