# Contributing to DSH Hub

[中文](CONTRIBUTING.md) | English

Focused, verifiable issues and pull requests are welcome. DSH Hub is an independent community project: this repository owns the multi-node control plane, while broadly applicable Harness changes should be proposed upstream.

## Product invariants

- Hub is a single-operator control plane with the enrolled node account's full authority; nodes add no second interactive approval layer.
- Hub is not a DSH Runtime and has no local execution mode or Hub-side plugin host.
- Nodes connect outbound; Connector never exposes or reverse-proxies the node's local Web port.
- Connector, local Web, and desktop clients share one existing DSH Runtime and session store.
- Node data remains authoritative; Hub does not transparently mirror full conversations or files.
- A node cannot inject temporary JavaScript into the Hub browser origin.

Maintain a separate fork if your product changes the full-authority model, adds per-node approval, or executes DSH inside Hub.

## Development flow

1. Link behavioral work to an issue and branch from current `master`.
2. Keep one concern per PR; avoid unrelated formatting or upstream syncs.
3. Never commit credentials, enrollment codes, tokens, private keys, personal email, live domains, addresses, or paths. Use examples such as `hub.example.com`.
4. Update the Chinese primary documentation and its complete English mirror for user-visible, deployment, and security changes.
5. Record outcome, test evidence, security impact, compatibility impact, and documentation changes in the PR.

The maintainer may currently move work forward directly. Once a second contributor exists, protocol, authentication, full-node-authority, deployment, and release workflow changes require one non-author review. Squash only after required CI passes; do not weaken a gate to bypass a disputed security invariant.

## Local validation

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
```

Protocol, authentication, storage, plugin transaction, snapshot, terminal, and recovery changes must cover malformed input and failure paths. Fleet routing or transport changes must also pass the simultaneous multi-node integration test: two independent identities and journals, concurrent requests, stalled-node isolation, and owner-only backlog recovery.

The reviewed official Web snapshot lives in `third_party/official-web`. An update must pin the upstream commit, include a reproducible source patch, refresh attribution, and pass production-CSP, desktop, and 390px mobile regressions. Do not hand-edit minified JavaScript.

## Releases

Stable tags use `hub-v<version>`. The release workflow repeats type-check, lint, unit and multi-node tests, Web regressions, and packed-install verification, then publishes checksum, SBOM, and provenance-bearing artifacts.
