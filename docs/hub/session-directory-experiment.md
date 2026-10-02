# Session directory experiment

Chinese primary: [会话目录实验](session-directory-experiment.zh.md).

This optional experiment adds a server-rendered metadata directory to the minimal node gateway. It keeps the full-authority single-operator model, Tailscale/Tailcat access, node-initiated outbound transport, and one existing Runtime per node. Each node's full official Web client stays on its separate gateway origin. No local DSH Web listener is exposed. There is no custom chat, permission, model, credential, or history UI, no prompt submission, and no durable session index or historical snapshot.

## Inspected native contract

The compatibility bound is **exactly `0.1.7-rc.2`**, plus explicit `sessionList` capability. Other versions fail closed until reviewed. This is an experimental compatibility claim, not a promise that the prerelease API is stable.

- `@deepseek-ai/dsh-api-session-controller` publishes Typert `session/list`, also exposed as `remote.session.list({}, signal)`. The remote returns `RemoteResult<SessionListValue>`; the gateway adapter unwraps success or throws a failure. `SessionListValue` contains `items`.
- `SessionListRequest.cursor` exists in the declarations, but the inspected implementation ignores its request and returns all visible sessions; there is **no response continuation cursor or effective native pagination**. Listing does not resume an Agent. Native `session/page` is conversation history paging and must not be used for the directory.
- Each item provides `sessionId`, `updatedAt`, `running`, and `agentAvailable`. Optional `projections.values.title` is a string or null. Missing titles remain unknown and display the session ID. Projection hints can be cached/stale; the directory does not fetch projections or history to fill gaps.
- Only those fields survive projection into directory metadata. Paths, other projections, prompts, credentials and full history are not retained. Running/idle/no-live-agent describe the supplied flags; no-live-agent does not imply archived.

Evidence was inspected in the published package's `lib/typert.remote-client.d.ts`, `lib/types/types.d.ts`, and `lib/index.js`; title types in `@deepseek-ai/dsh-session-title`; and the official Web bootstrap and client navigation sources. Sparse upstream source is supporting evidence, not the version authority.

## Exact navigation limitation

No native session URL route was found in the inspected published frontend and available official sources. The official client does expose `ctx.uiWorkspace.openSession(target: SessionTarget): void`, in `@deepseek-ai/dsh-client-ui-workspace`'s `lib/types/client/navigation.d.ts`. This is a client plugin service, **not an HTTP URL contract**. Layout's `selectPanel` is not a session route.

Consequently the default directory does not claim that clicking a session opens it. It displays “Native session link unavailable” and a clearly labeled “Open node” link; the operator must select the session in the native node page. No guessed hash/query path, hidden target redirect, fallback to another Runtime, or automatic creation is implemented. This limitation blocks the complete one-click-session experience.

An eventual small node-bundled official client plugin could validate a node/Runtime/session navigation intent after the correct Runtime connection is ready, then call `uiWorkspace.openSession`. It must test missing sessions, subagent addresses, superseded navigation, startup selection races, Runtime replacement and reconnects before advertising a pinned capability. This package does not ship that plugin. `Gateway.sessionUrl` is an optional integration seam, enabled only with an explicit verified `nativeNavigation` revision. Links to other origins or credential-bearing URLs are rejected; root must ensure the returned URL opens the exact target and survives its existing node authorization flow.

## Injected gateway integration

Implementation: [directory package](../../packages/hub/gateway-session-directory/src/index.ts). The package opens no listener and imports no gateway implementation or DSH runtime.

1. `targets()` synchronously returns authorized, non-revoked descriptors: node ID, Runtime ID, connection generation, name, HTTPS origin, exact version, online state and capabilities. Every reconnect must change generation, including reconnects to the same Runtime. Each node uses a distinct origin.
2. `list(target, {}, signal)` calls the native list through the existing outbound gateway transport and the same Runtime's plugin connection. Validate the full node/Runtime/generation tuple at dispatch and response. Unwrap `RemoteResult`; propagate cancellation. Do not forward the directory request to a node-local Web listener or start another Runtime. The adapter must limit response bytes before decoding; native rc.2 sends the entire list.
3. Call `invalidate(nodeId)` on disconnect/reconnect, revocation and available native session change events. Call `dispose()` on shutdown/logout as appropriate. Invalidation conservatively invalidates in-flight page snapshots; a changed page can be refreshed. No control/history stream is opened by this package.
4. Mount `page({offset, limit, signal})` and `directoryResponse(page)` behind the gateway's existing operator authorization. Parse and bound query values; connect HTTP disconnect to cancellation. Response headers use `no-store`, no-referrer and a script-free CSP. Root must also enforce request admission/rate limits; concurrency is bounded per page, not globally across callers.
5. Root owns the transport adapter, authentication/tickets, lifecycle wiring and optional verified navigation plugin. None are silently patched into the initial node-only gateway. The current experiment is a tested injected service, not an end-to-end live deployment.

Default bounds: 64 targets, 8 concurrent node calls per page, 800 ms timeout per dispatched call, 2-second metadata cache (maximum 5 seconds), 10,000 retained rows per node, and 50 rows per display page (maximum 200). A whole all-hung page is bounded by approximately `ceil(nodes / concurrency) * timeout`, plus local processing and event-loop delay. Request cancellation rejects the page and aborts active calls, including when the injected promise ignores cancellation; the adapter remains responsible for actually closing remote resources. Timeout does not mean a node is permanently offline.

Cache identity includes node, Runtime, connection generation, version, origin, online state and capabilities. Cache entries expire and are removed by timers, not only on subsequent access. Membership is rechecked before returning rows, preventing revoked/replaced targets or completed old-generation responses from leaking into a later page. There is no disk write, title logging or historical snapshot. A disconnected node contributes a status, not stale session rows. Error text is reduced to fixed per-node states to avoid leaking sensitive exception details.

Paging sorts retained metadata by activity and explicit target/session identity. It is **display paging**, not reduced native network I/O. Per-node retention truncation is visible; totals count retained rows. Offset pages may shift after activity changes or cache expiry, and provide no snapshot consistency guarantee. Every cold response is validated before retention; parsing and transient allocation still scale with the full native result. All node failures remain visible alongside healthy rows.

## Maintenance and measurements

A durable Hub session index can be eliminated: fan out native listing on demand and briefly cache only the selected metadata. This avoids migrations, synchronization/reconciliation, tombstones and retained session content. Costs are full-list native I/O, fan-out tail latency, no offline catalog, no stable global cursor, and a small version-bound adapter plus optional navigation plugin. Browser-only fan-out could also avoid the server directory, but separate-origin authorization/CORS and lifecycle handling would move complexity into the browser. Keep the node-only gateway as the lower-maintenance baseline.

[Importable benchmark harness](../../packages/hub/gateway-session-directory/src/benchmark.ts) exports `runSyntheticBenchmark` and `measureProbe`. Root can inject native Web-load/reconnect probes into `measureProbe` without submitting prompts. Run from the repository root:

```sh
pnpm exec tsc -p packages/hub/gateway-session-directory/tsconfig.json --noEmit
pnpm exec vitest run packages/hub/gateway-session-directory/tests
pnpm exec tsx packages/hub/gateway-session-directory/src/benchmark-cli.ts
pnpm run check
pnpm run build
```

The synthetic harness compares a node-only index fixture, cold directory fan-out plus SSR, warm directory plus SSR, disconnect/reconnect refresh, partial timeout and cancellation. Its structured JSON reports sample counts, success/failure counts, p50/p95/max and explicit latency budgets; failures produce a failing CLI exit code. Tests also cover simultaneous equal IDs, ownership changes, revoked nodes, malformed responses, escaping, origin rejection, paging and TTL expiration. No real model call occurs.

**Executed synthetic measurements are kept in the private experiment report**, with environment and exact configuration, separately from this portable guide. Live gateway transport latency, real persisted-session listing latency, native browser load/use stability, Tailscale/Tailcat reconnect reliability and exact-session navigation are **not measured by this experiment**. Root must run those gates for both the node-only baseline and directory-enabled variant before deployment; synthetic results cannot establish them. No deployment or legacy modification is part of this package.
