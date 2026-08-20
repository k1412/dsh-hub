/** Bounded, process-local latency telemetry for node-backed requests. */

export type HubRequestOutcome = 'ok' | 'node-error' | 'timeout' | 'offline' | 'error'

/** One completed node request before aggregation. */
export interface HubRequestPerformanceSample {
  occurredAt: number
  nodeId: string
  runtimeId: string
  method: string
  outcome: HubRequestOutcome
  durationMs: number
  dispatchMs: number
  waitMs: number
  responseBytes: number
}

/** Percentile and failure counters for one bounded sample group. */
export interface HubRequestPerformanceMetrics {
  requests: number
  errors: number
  timeouts: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  dispatchP95Ms: number
  waitP95Ms: number
  responseBytes: number
  maxResponseBytes: number
}

/** Operator-facing rolling snapshot; no request payload or session identity is retained. */
export interface HubPerformanceSnapshot {
  generatedAt: number
  windowStartedAt?: number
  sampleLimit: number
  summary: HubRequestPerformanceMetrics
  targets: Array<HubRequestPerformanceMetrics & {
    nodeId: string
    runtimeId: string
    methods: Array<HubRequestPerformanceMetrics & { method: string }>
  }>
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0
}

function rounded(value: number): number {
  return Number(value.toFixed(2))
}

function metrics(samples: readonly HubRequestPerformanceSample[]): HubRequestPerformanceMetrics {
  return {
    requests: samples.length,
    errors: samples.filter(sample => sample.outcome !== 'ok').length,
    timeouts: samples.filter(sample => sample.outcome === 'timeout').length,
    p50Ms: rounded(percentile(samples.map(sample => sample.durationMs), 0.5)),
    p95Ms: rounded(percentile(samples.map(sample => sample.durationMs), 0.95)),
    maxMs: rounded(Math.max(0, ...samples.map(sample => sample.durationMs))),
    dispatchP95Ms: rounded(percentile(samples.map(sample => sample.dispatchMs), 0.95)),
    waitP95Ms: rounded(percentile(samples.map(sample => sample.waitMs), 0.95)),
    responseBytes: samples.reduce((total, sample) => total + sample.responseBytes, 0),
    maxResponseBytes: Math.max(0, ...samples.map(sample => sample.responseBytes)),
  }
}

function targetKey(sample: Pick<HubRequestPerformanceSample, 'nodeId' | 'runtimeId'>): string {
  return `${sample.nodeId}\u0000${sample.runtimeId}`
}

/** In-memory ring used for live diagnosis without creating another durable telemetry store. */
export class HubPerformanceTracker {
  private readonly samples: HubRequestPerformanceSample[] = []

  public constructor(private readonly sampleLimit = 2_048) {
    if (!Number.isSafeInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > 100_000) {
      throw new Error('performance sample limit must be an integer from 1 through 100000')
    }
  }

  /** Record one sanitized terminal request sample. */
  public record(sample: HubRequestPerformanceSample): void {
    if (!Number.isFinite(sample.durationMs) || sample.durationMs < 0
      || !Number.isFinite(sample.dispatchMs) || sample.dispatchMs < 0
      || !Number.isFinite(sample.waitMs) || sample.waitMs < 0
      || !Number.isSafeInteger(sample.responseBytes) || sample.responseBytes < 0) {
      throw new Error('performance sample values are invalid')
    }
    this.samples.push({
      ...sample,
      nodeId: sample.nodeId.slice(0, 64),
      runtimeId: sample.runtimeId.slice(0, 64),
      method: sample.method.slice(0, 128),
    })
    if (this.samples.length > this.sampleLimit) this.samples.splice(0, this.samples.length - this.sampleLimit)
  }

  /** Return bounded aggregate percentiles for the authenticated operator. */
  public snapshot(now = Date.now()): HubPerformanceSnapshot {
    const groups = new Map<string, HubRequestPerformanceSample[]>()
    for (const sample of this.samples) {
      const key = targetKey(sample)
      const rows = groups.get(key) ?? []
      rows.push(sample)
      groups.set(key, rows)
    }
    const targets = [...groups.values()].map((samples) => {
      const first = samples[0] as HubRequestPerformanceSample
      const methods = new Map<string, HubRequestPerformanceSample[]>()
      for (const sample of samples) {
        const rows = methods.get(sample.method) ?? []
        rows.push(sample)
        methods.set(sample.method, rows)
      }
      return {
        nodeId: first.nodeId,
        runtimeId: first.runtimeId,
        ...metrics(samples),
        methods: [...methods].map(([method, rows]) => ({ method, ...metrics(rows) }))
          .sort((left, right) => right.p95Ms - left.p95Ms || right.requests - left.requests),
      }
    }).sort((left, right) => right.p95Ms - left.p95Ms || left.nodeId.localeCompare(right.nodeId))
    return {
      generatedAt: now,
      ...(this.samples[0] === undefined ? {} : { windowStartedAt: this.samples[0].occurredAt }),
      sampleLimit: this.sampleLimit,
      summary: metrics(this.samples),
      targets,
    }
  }
}
