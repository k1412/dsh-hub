# DSH Hub

English | [中文](README.zh.md)

DSH Hub is a self-hosted control plane for operating multiple [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) runtimes from one browser. Each node keeps its own DSH runtime, sessions, workspace files, credentials, and local clients. A Node Agent creates an outbound authenticated connection to the Hub, while an in-process Cordis Connector consumes the same transport-independent Host gateway reached by local Web and desktop clients.

## Capabilities

- Continue one session interchangeably from local Web, a desktop client, or Hub.
- Browse all enrolled nodes and sessions from a responsive single-user interface.
- Run session commands, workspace file operations, and interactive terminals under the Node Agent operating-system account.
- Pin, stage, inventory, and roll back DSH profile plugins by exact version and artifact hash.
- Create and restore node-local configuration, dependency, data, and fleet snapshots while excluding known secret-file classes and symbolic links.
- Recover outbound WSS connections through durable sequencing, acknowledgements, replay, idempotency, and connection-generation fencing.

## Architecture

Hub is a control plane, not a DSH runtime. It never runs agents or node plugins and has no local execution mode. Nodes remain authoritative for live sessions, workspaces, managed plugin artifacts, and snapshots; Hub persists control state, minimal session discovery, commands, audit records, and only objects explicitly imported into its content-addressed storage API.

Browser requests use REST for commands, SSE for live state, and a dedicated WebSocket for PTY traffic. Node Agents use outbound-only WSS and authenticate with a Cloudflare Access service token plus a pinned Ed25519 node identity. Human access uses Cloudflare Access and a Hub-side email allowlist.

See the [architecture reference](docs/hub/architecture.md) and [security reference](docs/hub/security.md).

## Run

This fork retains the complete upstream DSH runtime and development surface.

### Run from `npm`

Install Node.js, then run the upstream Web UI:

```sh
npx @deepseek-ai/dsh web
```

The Web UI listens on `http://127.0.0.1:3080` by default. See the [Web UI guide](docs/user/guide/index.md).

### Run from source

```sh
git clone https://github.com/k1412/dsh-hub.git
cd dsh-hub
pnpm install
pnpm run build
pnpm dsh web
```

## Deploy

The supported Hub deployment is the hardened [Docker Compose definition](deploy/hub/compose.yaml). Nodes install the release Node Agent and the DSH Connector bundle. The Connector joins an existing composition that provides the DSH Host gateway and does not install or proxy the DSH Web transport.

Follow the [deployment guide](docs/hub/deployment.md), then use the [operations guide](docs/hub/operations.md) for enrollment, backup, restore, upgrades, and revocation.

## Development

Hub packages live under [`packages/hub`](packages/hub), and the browser application lives under [`apps/hub-web`](apps/hub-web). Contributions follow [CONTRIBUTING.md](CONTRIBUTING.md) and the repository's existing package, documentation, testing, and bilingual-pairing rules.

## Upstream and license

This repository is a fork of DeepSeek Harness. Upstream DSH code, the Hub additions, and the complete repository are distributed under the [MIT License](LICENSE). Third-party notices remain in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). DSH Hub is an independent community project and does not use DeepSeek branding as its own product identity.
