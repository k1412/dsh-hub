# DSH Hub performance and concurrency

English | [中文](performance.zh.md)

This reference separates deterministic release correctness from deployment-specific performance. The automated gates run without model calls or Internet timing. They prove routing isolation and control responsiveness, while operators measure end-to-end latency on their own Hub and nodes.

## Concurrency model

Each enrolled node owns an independent signed WSS connection, delivery journal, connection generation, and Runtime set. Hub routes commands by encoded node and Runtime ownership; it does not put the fleet behind one global node queue.

Within a Runtime, Connector provides two interactive slots and four bulk slots. Responses, pending questions and approvals, Goal operations, session mutations, and Settings use the interactive lane. History, indexes, directory discovery, and other large reads use the bulk lane. Saturated bulk work therefore cannot consume the interactive reserve. Node Agent also reserves journal capacity for command results and control projections before suppressing reconstructible high-volume stream frames.

Fleet reads fan out to eligible online Runtimes and combine their official snapshots. Each node contribution has a 2.5-second budget. A node exceeding it uses temporarily-unavailable rows from the minimal index and cannot stall another node, receive another node's command, or replace another node's state.

## Automated release gates

The ordinary `hub:test` suite includes two simultaneously connected signed nodes with separate identities, journals, and Runtimes. It requires all of the following:

- concurrent chat reaches the exact owning node;
- one stalled node does not prevent the other node from completing control work;
- disconnecting one node leaves the other node healthy;
- an offline node's command never appears in another node's outbox;
- reconnect recovers only the disconnected node's durable backlog;
- audit completion remains attributable to the correct node and Runtime.

The Connector test fills all four bulk slots, submits Goal and Settings control concurrently, and requires both control results before any bulk slot is released. Browser release verification also checks the production CSP, official directory flow, desktop layout, and a 390 × 844 viewport with an overlay sidebar, bounded Runtime picker, full-screen Settings, and no horizontal overflow.

Run the deterministic checks with:

```bash
pnpm run hub:test
pnpm run hub:typecheck
pnpm run hub:lint
pnpm run build
pnpm run hub:web:csp:verify
pnpm run performance
```

## Reproducible control-plane benchmark

`pnpm run performance` starts the real Hub HTTP server, WAL SQLite, capability state, and minimal indexes for eight Runtimes. Node results wake waiters through `command.result` on the next event-loop turn. It makes no model call, performs no Internet access, and does not traverse real signed WSS, so it measures **Hub HTTP, routing, SQLite, event waiting, and fleet-merge overhead**, not phone-to-NAS end-to-end latency.

One clean run on 2026-08-18 using a Linux x64 development host and Node 22.22.1 produced:

| Scenario | Samples / concurrency | p50 | p95 | p99 | Throughput |
|---|---:|---:|---:|---:|---:|
| Direct control of one selected node | 200 / 16 | 18.38 ms | 39.26 ms | 75.76 ms | 787.37/s |
| Eight-node fleet read | 40 / 4 | 13.49 ms | 17.55 ms | 17.81 ms | 271.59/s |

The run completed 572 commands and process RSS moved from 149,123,072 to 177,987,584 bytes. CI retains the complete JSON artifact and applies broad regression budgets of 100 ms direct-control p95 and 400 ms fleet-read p95. These budgets detect order-of-magnitude regressions; they are not production latency promises. `DSH_HUB_BENCHMARK_*` environment variables can change node count, samples, and budgets.

## Observable indicators

Node health exposes command count waiting for a result, age of the oldest pending command, timeout count in the last 24 hours, and the most recent timed-out operation. A direct browser control wait exceeding 30 seconds returns HTTP 504; fleet aggregation uses a 2.5-second per-node read budget. Both create one payload-free timeout audit record, while the durable command remains pending for late completion and reconciliation. These are failure-containment bounds, not performance targets.

Treat delivery-journal utilization at 75% as a warning and 95% as critical. A separate early warning applies when queued reconstructible stream frames reach 500 records or 4 MiB; large command results such as session history remain visible in total bytes but do not by themselves trigger stream suppression. Investigate repeated timeouts, a growing oldest-pending age, reconnect churn, or sustained journal pressure before increasing limits: these signals commonly indicate an unhealthy Runtime, an unreachable node, oversized reads, or insufficient node resources. Browser event and rescue-terminal WebSockets receive a Ping every 20 seconds, so reconnect churn at a reverse proxy's idle timeout is a deployment fault rather than expected polling.

## Recommended deployment SLOs

These values are operator targets for an online, reachable node; they are not measurements claimed by this repository:

- simple control operations: p95 at or below 1 second when the node is online and not under pressure;
- fleet discovery refresh: p95 at or below 2.5 seconds for the operator's declared baseline fleet size;
- node recovery: p95 at or below 15 seconds after network reachability is restored;
- cross-node misrouting: exactly zero;
- mobile horizontal overflow in supported flows: exactly zero.

Record the fleet size, node-to-Hub round-trip time, history sizes, browser viewport, and observation window beside any latency number. Model generation time is a separate workload metric and must not be reported as Hub control-plane latency.

## Expected bottlenecks

Hub deliberately has no transparent workspace, transcript, or node-object cache. Session history and file data remain node-authoritative, so first-load latency includes node reachability, WSS transport, local DSH processing, and payload size. Large histories and indexes use the bulk lane to protect interaction, but they still consume node CPU, memory, bandwidth, and browser rendering time.

Adding nodes increases fan-out work for fleet discovery. It must not weaken routing isolation. A node exceeding the 2.5-second budget temporarily uses cached rows instead of letting the slowest node determine the page indefinitely. Operators should keep node clocks synchronized, avoid undersized NAS storage for journals and SQLite WAL, and monitor reverse-proxy and Cloudflare timeouts independently of Hub's command wait bound.

## Live two-node acceptance

After a release is deployed, validate with the NAS Runtime and `workstation-b` simultaneously online:

1. Open the fleet page and confirm projects from both nodes are grouped by workspace folder with their node labels.
2. Create one session on each node by choosing the node first and then a directory returned by that node; send messages to both without switching the fleet filter.
3. Continue one session from local DSH Web or desktop and confirm the same messages and Goal state appear in Hub, then continue from Hub and confirm the local client receives them.
4. Start a large history or directory read on one node and verify pending-question, Goal, and Settings controls on the other remain usable.
5. Disconnect one Node Agent, verify only that node becomes unavailable, enqueue an eligible durable operation, reconnect it, and verify only its own backlog resumes.
6. Test the creation dialog, project list, conversation scrolling, question response, Goal pause/resume, and Settings target switch at a phone-sized viewport.

Do not call acceptance complete if any response is routed to the wrong owner, any local client loses coexistence, the Settings owner is ambiguous, or a control error leaves the UI indefinitely pending.
