# DSH Hub Gateway

English | [中文](README.md)

[![Gateway branch CI](https://github.com/k1412/dsh-hub/actions/workflows/hub-ci.yml/badge.svg?branch=feat%2Fminimal-node-gateway)](https://github.com/k1412/dsh-hub/actions?query=branch%3Afeat%2Fminimal-node-gateway)
[![License](https://img.shields.io/github/license/k1412/dsh-hub)](LICENSE)

**One node list opens the DSH already running on each machine.**

Nodes on computers, NAS devices or servers connect outbound to Hub. Opening a node uses its installed official frontend, plugins and existing Runtime. No local Web port is exposed, and remote access starts no second DSH instance.

This branch provides the initial Gateway. Session aggregation, node operations management and node-to-node control belong to separate experiments, outside this version.

## Three layers of responsibility

| Layer | Responsibility | Data and authority |
| --- | --- | --- |
| Hub | Login, node list, invitations, revocation and network settings; authenticated forwarding | Stores identities, invitations and operator sessions, not model credentials, history or project indexes |
| Network | Tailscale or Tailcat carries outbound node connections | Both tools ship in the Hub image; overlay access does not replace Hub pairing authentication |
| Node | Official frontend, plugins, APIs, models, sessions and files | All use the same existing Runtime; each node has a separate browser origin |

For an individual or one trusted operator. Login grants the Runtime's full authority, including files and terminals; this is not a service with separate permissions for multiple users.

## Quick start

### 1. Deploy Hub

This Compose application **builds from source**. It does not depend on publicly published Gateway npm packages or container images.

Prepare configuration from the repository root:

```sh
cp deploy/gateway/.env.example deploy/gateway/.env
chmod 600 deploy/gateway/.env
```

Edit `deploy/gateway/.env`:

- Set `DSH_GATEWAY_PUBLIC_URL` and choose an unused browser port.
- Choose a standalone password of at least 16 characters or complete Cloudflare Access settings. Access mode has no password bypass.
- Configure the management hostname, per-node subdomains, HTTPS certificates and reverse proxy.
- If Access protects management, provide a `DSH_GATEWAY_DOWNLOAD_URL` reachable by command-line installers.

```sh
docker compose --env-file deploy/gateway/.env \
  -p dsh-gateway-v2 -f deploy/gateway/compose.yaml up -d --build
```

The browser port publishes only on host loopback by default. **Never publish private agent port `8081`.** Use a separate application and state volume, preserving existing services. See the [design](docs/hub/gateway-design.md) for deployment boundaries.

### 2. Invite a node

Prepare networking in Hub's Connection settings, then select Add node:

- **Tailscale:** suits an existing tailnet; Hub supports managed login configuration.
- **Tailcat:** pairs over an encrypted connection without an account, with relay fallback when direct connectivity is unavailable.

Run the invitation command as the existing DSH user. The installer verifies downloads, installs into the original profile and preserves pairing. Reinstallation does not start a conflicting process with the active Tailcat identity.

### 3. Open native DSH

Once the node is online, select Open DSH, choose a workspace and continue its native session. Models, history and files remain owned by that node's Runtime.

Initial installation has activated through HMR in testing. **Successful plugin installation does not mean running code has updated:** official rc2 updates can hit a nested HMR transaction limit, requiring a controlled reload of the existing Runtime after checking active work. Never start a second Runtime.

## Verified behavior and current limits

- Two real nodes are online through Tailscale/Tailcat; native workspace, Full access, model menus and Chromium/WebKit phone interaction passed.
- One real-model reply and refreshed history per node passed; 65,537-byte native upload/download SHA-256 integrity and cross-node ownership checks passed.
- Complete installed rc2, 63 official plugins, packaged installation, actual Tailcat reinstallation and plugin-event SSE have test evidence.
- JS/CSS uses streaming gzip. Only exact-version URLs declared immutable by their native owner permit private browser caching. APIs, history and files remain no-store; Hub has no shared cache.
- Earlier production cold loading reached about 94 seconds; functional success does not establish acceptable speed. See [staged acceptance evidence](docs/hub/gateway-design.md#10-current-implementation-and-acceptance-evidence) for final deployment, cold/warm cache and recovery measurements, without SLA claims.
- Open in App is a local desktop feature and is unsupported remotely; its 404 must not become a “zero network errors” claim.

## Versions and compatibility

| Component | This version's boundary |
| --- | --- |
| Gateway | `2.0.0-alpha.1`; use the source revision and matching evidence, not the shared version string, to identify verified changes |
| DSH | Installer admits `0.1.7-rc.2`; frontend and plugins come from that node's matching Runtime |
| Network tools | Tailscale `1.102.4`, Tailcat `0.7.0`; automatic installation covers Linux amd64/arm64, macOS requires the selected tool installed, and the shell does not support Windows |

## Documentation and legacy maintenance

- [Gateway architecture, endpoints, authentication, updates/rollback and acceptance](docs/hub/gateway-design.md)
- Separate experiments: [session directory](https://github.com/k1412/dsh-hub/tree/experiment/session-directory) aggregates entry points and opens sessions in native DSH; [node management and control](https://github.com/k1412/dsh-hub/tree/experiment/node-control) adds updates, plugin management and expiring directional task grants. Neither is enabled by default in this version.
- [Source-build configuration template](deploy/gateway/.env.example) · [Compose](deploy/gateway/compose.yaml) · [Security reporting](SECURITY.md)
- **Legacy v1 maintenance only:** [old documentation index](docs/hub/index.md), [old console](docs/hub/console.md), [old deployment](docs/hub/deployment.md), [old workbench screenshot](docs/assets/overview.png). Its aggregation and model sync are not features of this branch's Gateway.
