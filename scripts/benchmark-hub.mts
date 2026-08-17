#!/usr/bin/env node

import { performance } from 'node:perf_hooks'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { webCapability } from '@k1412/dsh-hub-capabilities'
import { generateHubIdentity, HubCommandId, HubNodeId, HubRuntimeId } from '@k1412/dsh-hub-protocol'
import { HubStorage, type HubCommandRecord } from '@k1412/dsh-hub-storage'
import { HubOriginGuard } from '../packages/hub/hub-server/src/auth.ts'
import { HubServer, type HubAccessVerifier } from '../packages/hub/hub-server/src/server.ts'

const NODE_COUNT = Number(process.env.DSH_HUB_BENCHMARK_NODES ?? '8')
const DIRECT_SAMPLES = Number(process.env.DSH_HUB_BENCHMARK_DIRECT_SAMPLES ?? '200')
const FLEET_SAMPLES = Number(process.env.DSH_HUB_BENCHMARK_FLEET_SAMPLES ?? '40')
const DIRECT_P95_BUDGET_MS = Number(process.env.DSH_HUB_BENCHMARK_DIRECT_P95_MS ?? '100')
const FLEET_P95_BUDGET_MS = Number(process.env.DSH_HUB_BENCHMARK_FLEET_P95_MS ?? '400')
const originSecret = 'benchmark-private-origin-secret-at-least-32-chars'

interface Metrics {
  samples: number
  concurrency: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  throughputPerSecond: number
}

function percentile(sorted: number[], quantile: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0
}

function summarize(samples: number[], concurrency: number, wallMs: number): Metrics {
  const sorted = [...samples].sort((left, right) => left - right)
  return {
    samples: samples.length,
    concurrency,
    p50Ms: Number(percentile(sorted, 0.5).toFixed(2)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(2)),
    p99Ms: Number(percentile(sorted, 0.99).toFixed(2)),
    throughputPerSecond: Number((samples.length / (wallMs / 1_000)).toFixed(2)),
  }
}

async function measure(total: number, concurrency: number, operation: (index: number) => Promise<void>): Promise<Metrics> {
  const samples = new Array<number>(total)
  let next = 0
  const wallStartedAt = performance.now()
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = next++
      if (index >= total) return
      const startedAt = performance.now()
      await operation(index)
      samples[index] = performance.now() - startedAt
    }
  }))
  return summarize(samples, concurrency, performance.now() - wallStartedAt)
}

const access: HubAccessVerifier = {
  async verifyHuman() {
    return {
      kind: 'human', email: 'benchmark@example.com', subject: 'benchmark',
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    }
  },
  async verifyService() {
    return {
      kind: 'service', commonName: 'benchmark.access',
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    }
  },
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hub-benchmark-'))
  let server: HubServer | undefined
  try {
    const storage = await HubStorage.open(join(root, 'hub.db'))
    server = new HubServer({
      storage,
      access,
      originGuard: new HubOriginGuard(originSecret),
      hubIdentity: generateHubIdentity(),
      publicOrigin: 'https://hub.example.com',
    })
    const address = await server.listen('127.0.0.1', 0)
    const base = `http://127.0.0.1:${String(address.port)}`
    const targets = Array.from({ length: NODE_COUNT }, (_, index) => ({
      nodeId: HubNodeId(`benchmark-node-${String(index).padStart(2, '0')}`),
      runtimeId: HubRuntimeId('web'),
    }))
    for (const [index, target] of targets.entries()) {
      const grant = storage.control.createEnrollment(target.nodeId, `Benchmark ${String(index)}`, Date.now() + 60_000)
      storage.control.consumeEnrollment(grant.code, `benchmark-key-${String(index)}`, `benchmark-service-${String(index)}`)
      storage.control.upsertRuntime({
        ...target,
        bootId: `benchmark-runtime-${String(index)}`,
        dshVersion: 'benchmark',
        connectorVersion: 'benchmark',
        capabilities: [webCapability.descriptor] as never,
        online: true,
        lastSeenAt: Date.now(),
      })
    }

    const events = (server as unknown as {
      events: { publish(type: string, data: never): void }
    }).events
    const registry = server.agents as unknown as {
      isOnline(nodeId: string): boolean
      invoke(
        nodeId: ReturnType<typeof HubNodeId>,
        runtimeId: ReturnType<typeof HubRuntimeId>,
        capability: string,
        capabilityVersion: string,
        operation: string,
        payload: unknown,
      ): Promise<HubCommandRecord>
    }
    registry.isOnline = () => true
    let commandSequence = 0
    registry.invoke = async (nodeId, runtimeId, capability, capabilityVersion, operation, payload) => {
      commandSequence += 1
      const request = JSON.parse(String((payload as { body?: unknown }).body)) as {
        rpcId: string
        method: string
      }
      const command = storage.control.createCommand({
        commandId: HubCommandId(`benchmark-command-${String(commandSequence).padStart(10, '0')}`),
        nodeId,
        runtimeId,
        capability,
        capabilityVersion,
        operation,
        idempotency: 'read',
        payload: payload as never,
        createdAt: Date.now(),
      })
      storage.control.transitionCommand(command.commandId, 'sent', undefined)
      setImmediate(() => {
        const value = request.method === 'session.list'
          ? { items: [{
              sessionId: `session-${nodeId}`,
              cwd: `/workspace/${nodeId}`,
              updatedAt: Date.now(),
              running: false,
              blank: false,
            }] }
          : { version: 'benchmark', cwd: `/workspace/${nodeId}`, attachedSessions: 1, canOpenPath: true }
        storage.control.transitionCommand(command.commandId, 'ok', {
          status: 200,
          headers: [['content-type', 'application/json; charset=utf-8']],
          encoding: 'utf8',
          body: JSON.stringify({
            type: 'server-response', rpcId: request.rpcId, result: { ok: true, value },
          }),
        })
        events.publish('command.result', {
          commandId: command.commandId, nodeId, status: 'ok', result: {},
        } as never)
      })
      return storage.control.getCommand(command.commandId) as HubCommandRecord
    }

    const headers = {
      origin: 'https://hub.example.com',
      'content-type': 'application/json',
      'x-dsh-origin-secret': originSecret,
    }
    let rpcSequence = 0
    const direct = async (index: number): Promise<void> => {
      rpcSequence += 1
      const target = targets[index % targets.length]!
      const response = await fetch(
        `${base}/api/host.describe?nodeId=${target.nodeId}&runtimeId=${target.runtimeId}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            type: 'client-request', rpcId: `direct-${String(rpcSequence)}`,
            method: 'host.describe', payload: {},
          }),
        },
      )
      if (!response.ok || (await response.json() as { result?: { ok?: unknown } }).result?.ok !== true) {
        throw new Error(`direct benchmark request failed with HTTP ${String(response.status)}`)
      }
    }
    const fleet = async (): Promise<void> => {
      rpcSequence += 1
      const response = await fetch(`${base}/api/session.list`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'client-request', rpcId: `fleet-${String(rpcSequence)}`,
          method: 'session.list', payload: {},
        }),
      })
      const body = await response.json() as { result?: { ok?: unknown; value?: { items?: unknown[] } } }
      if (!response.ok || body.result?.ok !== true || body.result.value?.items?.length !== NODE_COUNT) {
        throw new Error(`Fleet benchmark request failed with HTTP ${String(response.status)}`)
      }
    }

    await measure(20, 4, direct)
    await measure(4, 1, fleet)
    const rssBefore = process.memoryUsage().rss
    const directMetrics = await measure(DIRECT_SAMPLES, 16, direct)
    const fleetMetrics = await measure(FLEET_SAMPLES, 4, fleet)
    const result = {
      schemaVersion: 1,
      environment: {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        nodes: NODE_COUNT,
        sqlite: 'WAL',
        transport: 'loopback HTTP; signed-node transport excluded',
      },
      directControl: directMetrics,
      fleetRead: fleetMetrics,
      process: {
        rssBeforeBytes: rssBefore,
        rssAfterBytes: process.memoryUsage().rss,
        commands: commandSequence,
      },
      budgets: {
        directP95Ms: DIRECT_P95_BUDGET_MS,
        fleetP95Ms: FLEET_P95_BUDGET_MS,
      },
    }
    const output = `${JSON.stringify(result, null, 2)}\n`
    process.stdout.write(output)
    const outputPath = process.env.DSH_HUB_BENCHMARK_JSON
    if (outputPath !== undefined && outputPath !== '') {
      const target = resolve(outputPath)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, output)
    }
    if (directMetrics.p95Ms > DIRECT_P95_BUDGET_MS) {
      throw new Error(`direct p95 ${String(directMetrics.p95Ms)} ms exceeds ${String(DIRECT_P95_BUDGET_MS)} ms`)
    }
    if (fleetMetrics.p95Ms > FLEET_P95_BUDGET_MS) {
      throw new Error(`Fleet p95 ${String(fleetMetrics.p95Ms)} ms exceeds ${String(FLEET_P95_BUDGET_MS)} ms`)
    }
  } finally {
    await server?.close()
    await rm(root, { recursive: true, force: true })
  }
}

await main()
