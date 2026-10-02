# Runnable session-directory experiment

Chinese primary: [会话目录实验](session-directory-experiment.zh.md).

This branch contains a runnable extension of the minimal node gateway: an authenticated `/sessions` directory and exact-session navigation into each node's **complete official DSH Web client**. The initial node-only gateway remains the baseline. The experiment is disabled unless `DSH_GATEWAY_SESSION_DIRECTORY=1`; enabled instances show a short experiment link on the homepage. No deployment is performed by the tests.

The full-authority single-operator model, separate node origins, Tailscale/Tailcat access and node-initiated outbound connection boundary remain unchanged. No second Runtime or local Web listener is created. Hub retains authentication/pairing state and briefly caches directory metadata, not model credentials, conversation history or snapshots. There is no custom chat, permissions, model-selection UI or business-payload translation.

## Run and install

Use Node 22.19+ and the repository's pnpm 11.7.0. Build using `pnpm run build`; this produces `dist/gateway/server.mjs` and the installable `dist/gateway/downloads/gateway-node.tgz`, including the official-registry client navigation plugin. Start with the existing gateway authentication/network configuration and:

```sh
DSH_GATEWAY_SESSION_DIRECTORY=1 node dist/gateway/server.mjs
```

The feature defaults off. `/sessions` requires the same operator authorization as the node list. Experimental invitation manifests mark the node capability; the generated install command chooses a separate experiment state directory and `--instance gateway-node-experiment`. Reload the **existing** DSH Runtime after installation. The supported installed DSH version is exactly `0.1.7-rc.2`; version/capability mismatches produce an explicit unavailable node result.

For a same-Runtime, two-Hub setup:

1. Keep the primary Hub connection and its existing profile entry/configuration.
2. Run the experiment Hub's generated installation command as the same Runtime user, with the same `--profile`, a **different** `--state-directory`, and `--instance gateway-node-experiment`. Do not reuse the primary connection file, identity or network state directory.
3. The installer preserves the primary managed YAML block and adds a separate named Loader entry pointing at its own connection file. Both entries use the same installed compatible node package and the same Runtime services. The experiment package remains compatible with the node-only gateway.
4. Reload that Runtime once. Both outbound tunnels coexist; no second DSH process is needed. A named first installation disables the otherwise unconfigured default entry. Reinstalling the primary entry explicitly re-enables it.
5. To stop the experiment, disable/remove only its named profile entry, reload the same Runtime, and revoke its node at the experiment Hub. Do not remove the shared plugin package while the primary entry uses it.

The installer refuses to overwrite a state directory belonging to a different Hub. Existing raw profile YAML/JS expressions are preserved. Neither the installer nor the experiment starts a second Runtime. Network provisioning still uses the existing Tailscale/Tailcat implementation.

## Actual native listing

The server invokes the exact published rc.2 Typert Remote `session/list`, over the owning node's existing `GatewayTunnel.fetch`. The unchanged native HTTP carrier is `POST /api/session/list` with:

```json
{"type":"client-request","rpcId":"unique-request-id","method":"session/list","payload":{"args":{"_request":{}}}}
```

The response must be the matching `server-response`/`rpcId`, with successful `RemoteResult.value.items`. This matches the generated `@deepseek-ai/dsh-api-session-controller/lib/typert.host.js` parameter `_request`, its remote declarations, and its real Runtime implementation. Hub does not introduce an alternate session business API. Native listing does not resume an Agent.

Requests and replies are bound to explicit node ID, Runtime ID and a fresh random connection generation. Replacement/revocation/close invalidates directory cache entries and in-flight snapshots. A global limit admits at most **8 directory RPCs** across callers, without an unbounded waiting queue; each directory request also fans out to at most 8 nodes at a time. Timeout is 3 seconds per dispatched node. Responses are limited to **8 MiB before JSON decoding**, and cancellation cancels the tunnel response stream. Fixed per-node errors avoid displaying native exception details; healthy nodes remain visible during partial failures.

Only `sessionId`, optional `projections.values.title`, `updatedAt`, `running` and `agentAvailable` become directory rows. Unknown titles display IDs. Paths and all other projection hints are discarded immediately, not persisted or rendered. There is no model/configuration/history API call. Idle versus no-live-agent reflects native flags; the latter does not mean archived.

The cache TTL is 2 seconds (configurable maximum 5), with timer eviction; default retention is 10,000 rows per node and 64 targets. Membership, Runtime and generation are checked again before rendering. Native session changes become visible after the short TTL; connection/membership changes invalidate immediately. No additional history/control subscription is opened.

**Native rc.2 listing is not paged.** Its declared request cursor is ignored and the result has no next cursor. Display paging is therefore local over retained metadata, 50 rows by default/200 maximum. Truncation and per-node statuses are explicit. Activity changes may shift offset pages; there are no snapshot consistency guarantees. Network I/O and transient parsing still scale with the full native list until the byte limit. `session/page` is conversation history, not a directory paging API, and the directory never calls it.

## Exact native session click

Upstream has no identified session URL router. This experiment implements an **explicit plugin navigation route**, not a guessed upstream hash/query convention:

1. A row links to the owning node's `/_hub/open-session` with explicit Runtime/generation/session identity. Gateway forwards it through operator authorization and a one-use node authentication ticket, preserving the target.
2. The ticket references a bounded, memory-only intent. The authenticated node page receives an opaque `gatewayIntent` key; `/_hub/session-intent` returns it only for the same node and still-live Runtime/generation. Intent lifetime is 5 minutes, with at most 512 pending entries. Intent data never enters the database.
3. The additional node-bundled client module is registered through official `dsh.client` metadata and `window.__ModuleLoader__`. It waits for the public `sessions.list` and `workspaces.list` ready snapshots, refreshes the native list, verifies membership, and retains the exact session/address until its native history open completes.
4. It revalidates the intent and native connection generation, supersedes startup workspace navigation via `layout.beginNavigation()`, calls exported `ctx.uiWorkspace.openSession(target)`, and verifies that the target owns `mainView`. No private store, DOM-based session switching or upstream patch is used.
5. Success removes the temporary query parameter; reload restores the official client's saved selection. Missing sessions, expired tickets/intents, changed Runtime/generation, disconnects or failed opens display an explicit error. A navigation-only blocking notice prevents an unrelated startup conversation from appearing as a successful target; it is not a chat UI. The full native composer and history render after selection succeeds.

Host activation uses public `ctx.get()` for optional `appReady` and `webServer`; scoped Cordis contexts reject undeclared direct property access. Two named host plugin instances and one shared browser module were tested in the same Runtime.

## Validation and measurements

```sh
pnpm run check
pnpm run build
DSH_NATIVE_ROOT=/path/to/installed-rc2 DSH_NATIVE_BROWSER=chromium pnpm run gateway:session:native
DSH_NATIVE_ROOT=/path/to/installed-rc2 DSH_NATIVE_BROWSER=webkit pnpm run gateway:session:native
pnpm exec tsx packages/hub/gateway-session-directory/src/benchmark-cli.ts
```

Use a directory containing `node_modules/@deepseek-ai/dsh` at `0.1.7-rc.2` for the native gate. CI installs that exact published version, builds the release package, and runs the browser gate; `DSH_DIRECTORY_REPORT` optionally specifies a JSON report destination. No paid model calls occur.

The real gate reuses the complete Runtime setup from the native gateway smoke test. It boots two isolated published Runtimes, each with the full official browser roster, one experimental client module, **two real named Gateway plugin activations and separate connection files**, connected concurrently to baseline/experimental Hubs. Only overlay network dialing and inference are replaced by a loopback WebSocket carrier and model fixture. Actual Runtime services, native RPC, packaged client plugin, browser, permissions/model controls and durable history are real.

Coverage includes simultaneous duplicate session IDs, authenticated directory and ticket flows, wrong-target/stale intent rejection, bounded native reply/cancellation, explicit missing-session errors, full-access/model selection, fixture messages, repeated exact historical clicks and reloads, mobile layout, offline partial results and five reconnect cycles. The node-only and experimental variants are measured with the same Runtime pair, browser viewport and fixture history. The baseline is feature-disabled mode of the same candidate server/node package (including an inactive navigation module), not a benchmark of the deployed initial release. Unit/integration tests additionally check global admission limits, schema/correlation validation, installer coexistence, cache and transport isolation. The synthetic 40,000-session harness remains separately labeled; it is not real DSH latency.

Private handoff evidence records exact timings, sample counts, checks and environment. These are **real local Runtime/browser measurements over loopback**, not production Tailscale/Tailcat or NAS measurements. Initial browser and history sample counts are small; results are observations, not a production SLO. Real overlay stability, production data scale and deployment acceptance remain root's follow-up gates.

## Maintenance tradeoff

A durable Hub session index is unnecessary: on-demand native listing plus short-lived metadata eliminates index migrations, reconciliation, tombstones and history retention. Costs are full-list reads, fan-out tail latency, no offline catalog/stable global cursor, the small pinned native carrier adapter and the official-client navigation plugin. Browser-only fan-out would move separate-origin authorization/CORS/lifecycle complexity into the browser. Keep this explicitly labeled experiment separate from the lower-maintenance node-only baseline.

## Base synchronization and current limits

The experiment incorporates base gateway `fd110b2fe4`: streaming installer downloads with bounded timeouts and checksum checks, runtime-image CA certificates, installed native Chromium/WebKit CI, gzip for eligible static code and private immutable caching only for native versioned assets. Named-instance installation, session intents and directory authorization remain active. The CI runs both baseline native-browser tests and experimental dual-Runtime tests on Chromium and WebKit.

The dual-instance fixture now rejects duplicate client graph IDs and requires exactly one experimental navigation module. Neither named Gateway activation registers an HMR service. The fixture disables official `client-hmr` host watching. Base fix `4720972a83` supplies `/plugins/events` directly from the shared public `clientModules.graph/onGraphChanged/onRebuilt` registry. Each SSE stream owns its subscriptions, bounded queue and cleanup; there is no new host watcher or Web listener. The published rc.2 `PluginsEventFrame` type is a development dependency with a pinned lockfile.

WebKit preserves the same mobile-width, exact-session, zero-browser-error and five-cycle reconnect assertions as Chromium. Its optional directory screenshot is replaced with HTML evidence because Playwright's WebKit screenshot preparation injects an inline stylesheet rejected by the directory CSP. The product CSP is unchanged. Measured local results and the distinction from real overlay/deployment performance remain in the private handoff report.

Local revalidation after base synchronization: both browser gates passed with zero browser errors and 5/5 reconnect cycles; each uses two real rc.2 Runtimes and two named connections per Runtime. Full check passed 284 tests (3 optional tests skipped), and build passed. Values below are loopback p95 milliseconds, with fixture inference; small samples and concurrent local gate load preclude production or speedup claims.

| 指标 / Metric | n | Chromium p95 ms | WebKit p95 ms |
|---|---:|---:|---:|
| 目录页面 / Directory page | 15 | 23.00 | 24.77 |
| 双节点并发 listing / Two-node concurrent listing | 15 | 3.93 | 8.02 |
| 关闭功能的历史打开 / Feature-disabled history open | 6 | 222.22 | 475.58 |
| 指定历史点击 / Exact history click | 6 | 355.66 | 555.66 |
| 重连后历史点击 / History click after reconnect | 5 | 401.27 | 570.99 |

The SSE gate uses both real Runtimes and both concurrent Hub tunnels. It checks equal initial graphs, actual temporary artifact rebuild notifications, cancellation/disconnection isolation, and a full current graph after reconnection. A separate real-carrier test exercises the production HTTP deadline path with a shortened 150 ms value: expiration disposes only that stream, and reopening sends a graph. Production retains the 120-second HTTP deadline; native EventSource reconnects and receives the latest complete graph, with no event replay buffer. The local gate does not wait 120 seconds or claim native browser automatic reconnect timing was measured. End-to-end file watching remains the existing Runtime's responsibility.

SSE synchronization revalidation passed in Chromium and WebKit: both reports record `sseIsolationPassed=true`, zero browser errors, and five directory reconnect cycles. The two-Runtime/two-Hub SSE isolation scenario took 49.33 ms (chromium) / 78.47 ms (webkit). These are one-sample local scenario durations, not per-event latency or production overlay measurements.
