# Deploy DSH Hub

English | [中文](deployment.zh.md)

This tutorial installs one Hub with Docker Compose, places it behind Cloudflare Access and a trusted reverse proxy, and enrolls one existing DSH profile. It uses generic names and paths; keep environment-specific hostnames, addresses, tokens, and email addresses outside the repository.

## Choose a topology first

DSH Hub keeps the same identity model in all three supported topologies. Only the route from Cloudflare to the Hub Origin changes. An internal network or VPN does not replace Access, Hub's email allowlist, or the Origin Secret.

| Topology | Traffic path | Inbound host ports | Recommended use |
|---|---|---:|---|
| Single-host domain | Cloudflare → reverse proxy → loopback Hub | 443 | Cloud server with the fewest components |
| Cloudflare Tunnel | Cloudflare → outbound `cloudflared` → local reverse proxy → loopback Hub | 0 | NAS, home network, or no public IP |
| Separate ingress and Hub | Cloudflare → VPS reverse proxy → Tailscale/WireGuard → NAS Hub | VPS 443; NAS 0 | Thin VPS ingress with Hub and data on a NAS |

Tunnel and overlay networks solve Origin reachability only. Cloudflare documents Tunnel as an outbound connection that needs no inbound ports and recommends configuring Access before publishing the Tunnel route. Hub still validates the Application JWT and operator email itself. See [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/), [publishing a self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/), and the [Tunnel Access origin parameter](https://developers.cloudflare.com/tunnel/advanced/origin-parameters/#access-settings).

### Minimum secure configuration

These six controls are the production baseline, not optional enhancements:

1. Public requests pass through Cloudflare Access, whose human allow policy contains only intended accounts.
2. Hub has an exact operator email allowlist and independently validates JWT issuer, audience, signature, and time claims.
3. Origin binds only to loopback, a private network, or an overlay interface; its firewall allows only the trusted reverse proxy.
4. The reverse proxy removes any client Origin Secret header before injecting a server-only random value.
5. Every node has its own Service Token, Ed25519 identity, and short-lived one-time enrollment code.
6. Container images are pinned by digest, only the container UID can write state, and encrypted recoverable backups exist.

## Prerequisites

- A Linux Docker host with Docker Engine and Compose v2.
- An HTTPS hostname routed through Cloudflare Access to a trusted reverse proxy.
- A Cloudflare Access self-hosted application with one human policy and one Service Token policy.
- Node.js 22.19 or later, `npm`, and DSH on every node. The target DSH composition must provide the transport-independent `@deepseek-ai/dsh-host-apiproxy` service; the standard Web profile already provides it. Install the platform C/C++ build toolchain and Python required by `node-pty` before installing the Node Agent.
- A private route from the reverse proxy to the Hub origin, either loopback, a private network, or an authenticated overlay network.

## 1. Configure Cloudflare Access

Create one self-hosted Access application for the Hub hostname. Add an allow policy for the operator identity provider and an allow policy containing the Service Tokens issued to nodes. Record the application audience, team domain, and one distinct Service Token per node.

Use Cloudflare's current guidance for [self-hosted Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/), [validating Access JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), and [Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/). Keep the application audience and Service Token identity separate from the Hub's own enrollment and Ed25519 identities.

The Hub validates the Access JWT independently. Browser JWTs must carry an allowlisted email, and node JWTs must carry a Service Token `common_name`. A valid Cloudflare session does not bypass the Hub allowlist or node enrollment.

## 2. Configure the trusted origin path

Configure the reverse proxy to remove every client-supplied `X-DSH-Origin-Secret` header and add its own fixed random value. Forward HTTP upgrades and disable response buffering for SSE. Route the origin only over loopback or a private network and restrict its firewall to the proxy.

Direct requests to the Hub IP and port do not contain the proxy-held secret and receive a not-found response. The origin-secret check remains required even when a firewall or overlay network already limits reachability.

### Nginx example

Keep the real secret in a separate root-readable snippet instead of committing it in the site configuration:

```nginx
# /etc/nginx/snippets/dsh-hub-origin-secret.conf, chmod 600
proxy_set_header X-DSH-Origin-Secret "replace-with-random-secret";
```

The site only includes that protected snippet:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    include /etc/nginx/snippets/dsh-hub-origin-secret.conf;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

`proxy_set_header` overwrites a same-named client header with the protected fixed value. Review the complete server to ensure no other `location` bypasses the snippet. Some Nginx distributions require a separate `map` for `$connection_upgrade`; an equivalent fixed Upgrade configuration is also acceptable.

### Cloudflare Tunnel private-origin mode

Create a Tunnel in the Zero Trust Dashboard and map the published `hub.example.com` route to a local Nginx or Caddy listener such as `http://127.0.0.1:8443`, not directly to Hub on `8080`. The local reverse proxy injects the Origin Secret before forwarding to loopback Hub. Enable **Protect with Access** on the route with the exact Team Name and Application Audience; Hub continues to perform its own JWT validation.

`cloudflared`, the reverse proxy, and Hub may run on the same NAS. The host firewall can reject every Internet ingress while allowing the outbound DNS, HTTPS/QUIC, and artifact traffic that the services require. A Tunnel Token and the Origin Secret are different credentials and must not be reused. Configure remotely managed routes in the Dashboard; a locally managed ingress file must end with an `http_status:404` catch-all.

### VPS ingress with Hub on a NAS

The VPS reverse proxy reaches the NAS Hub through a Tailscale or WireGuard address. Bind the NAS port only to its overlay interface and restrict the host firewall to the VPS's exact overlay address. The Origin Secret exists only in the VPS proxy and NAS Hub environments. Do not expose the NAS address through public DNS or proxy diagnostics, and do not treat a Tailscale ACL as operator login.

## 3. Start the Hub

Copy [`deploy/hub/compose.yaml`](../../deploy/hub/compose.yaml) and [`.env.example`](../../deploy/hub/.env.example) into a deployment directory, rename `.env.example` to `.env`, and fill every required value. Generate the origin secret independently from all Cloudflare credentials.

```sh
chmod 600 .env
mkdir -p backups
chown 10001:10001 backups
docker compose pull
docker compose up -d
docker compose ps
```

The supplied Compose definition binds to loopback. When the reverse proxy runs on another trusted host, bind the published port to a private interface address and allow only the proxy address in the host firewall. Never publish the origin port as an unrestricted Internet service.

Verify the public hostname in a private browser window. Cloudflare Access must authenticate before the Hub UI loads. A request sent directly to the origin without the injected header must not expose `/healthz`, the UI, REST, SSE, or WebSocket upgrades.

## 4. Create a node enrollment

Open **Settings → Hub nodes**, enter a stable node ID and a descriptive display name, and create a short-lived enrollment grant. The one-time enrollment code is returned once and is stored by Hub only as a hash. The page immediately produces Linux/macOS and Windows one-command installers; select the target system and copy its command.

An unattended deployment may instead stop Hub and run the offline administration command through the same Compose project. Never let the offline command and Hub Server write the state volume concurrently:

```bash
docker compose stop hub
docker compose run --rm hub node /app/hub-server.mjs create-enrollment \
  --node-id workstation-1 --display-name "Workstation 1" --expires-in 900
docker compose up -d hub
```

The offline output contains the one-time code. Pass it directly to the target node; never place it in logs, tickets, or Git. The UI-generated one-command installer places this 15-minute, single-consumption code in shell history; remove that history entry according to the node's local policy after consumption. Offline creation is recorded in the audit chain with the `local-admin` actor.

Create a separate Cloudflare Access Service Token for the node. Do not reuse a token across nodes: per-node tokens allow independent rotation and revocation, and the Hub permanently binds the Service Token identity to the enrolled Ed25519 node key.

## 5. Run the one-command installer

Paste and run the single command from the Hub UI on the target computer under the same operating-system account that runs DSH. The installer performs these steps:

1. Downloads the Node Agent, Connector, and `SHA256SUMS` from one immutable GitHub Release and verifies both artifacts before installation.
2. Installs Node Agent under `~/.dsh-hub/runtime/<version>` without modifying the global npm directory or requesting root authority.
3. Uses `dsh-hub-node init` to fetch and pin the Hub public key and create an Ed25519 node identity, Connector IPC secret, and owner-only configuration.
4. Installs Connector into the existing `web` profile as a DSH bundle plugin; it contributes one Cordis row and does not alter the Web listener, frontend bundle, or session storage.
5. Installs and starts a systemd user service on Linux, a LaunchAgent on macOS, or a current-user logon task on Windows.

The installer prompts normally for the node's Cloudflare Access Client ID and reads the Client Secret through a hidden prompt. The long-lived Service Token secret is absent from the copied command, process arguments, and shell history. If DSH uses a profile other than `web`, append `--profile <name>` to the Linux/macOS command. Advanced installations or custom supervisors can use `--no-service` and follow the [node service guide](node-services.md).

Connector is already the client-installed DSH plugin. Node Agent deliberately remains a same-account sidecar: it retains the one node identity, WSS reconnect state, and durable command journal while a DSH profile restarts or stops, and lets multiple profiles on one machine share one node connection. It neither starts a second DSH runtime nor opens an inbound port.

## 6. Restart the existing DSH profile

Restart the existing DSH process once so Cordis loads the newly installed Connector bundle. Local Web and desktop clients remain attached to the same DSH services and persistence. The Connector connects only to the local Node Agent socket.

Set a distinct `DSH_HUB_RUNTIME_ID` for each independently running DSH process on the same machine. One process can serve several local client surfaces; it needs only one Connector instance.

When the Node Agent uses a non-default state directory or IPC endpoint, configure the same `DSH_HUB_STATE_DIRECTORY` or explicit Connector `ipcEndpoint` and `secretFile` in the DSH process. For a non-default Runtime ID, set `DSH_HUB_RUNTIME_ID` in that DSH process. The Connector Runtime ID and the corresponding `management.profiles[].runtimeId` must match exactly.

## 7. Verify coexistence

Create a session from the local Web UI, send a message, and confirm that the session appears under the node in Hub. Continue the same session from Hub and confirm that the local Web UI receives the event. Repeat with the desktop client. Disconnect Hub or stop the Node Agent and confirm that both local clients continue working.

Verify terminal, file, plugin, and snapshot controls only after the Node Agent profile-management directory matches the intended DSH profile. These operations run with the Node Agent account's full authority and do not request a second local approval.

## Multiple profiles and nodes

Repeat enrollment for each machine and issue a distinct Service Token. Do not enroll the same Node Agent again for an additional local profile. Install the Connector bundle in that profile, give its Connector a unique Runtime ID, and add a matching entry to the owner-only Node Agent configuration under `management.profiles` when Hub should expose file, terminal, plugin, and snapshot capabilities for it:

```json
{
  "management": {
    "profiles": [
      {
        "runtimeId": "default",
        "profileDirectory": "/absolute/path/to/profiles/web",
        "profileName": "web",
        "dshExecutable": "/absolute/path/to/dsh",
        "snapshotPaths": ["/absolute/path/to/approved/data"]
      }
    ]
  }
}
```

Several DSH profiles on one machine may share the Node Agent socket, but every independently running process needs a unique Runtime ID and profile directory. A Runtime without a matching management entry exposes only Connector capabilities. Never point two concurrent DSH processes at one session storage directory.

## Recommended hardening

These controls preserve the product model and can be added progressively:

- use a short Cloudflare Access session duration, mandatory MFA, Instant Auth, and Device Posture where devices are managed;
- use verified TLS or mTLS on non-loopback reverse-proxy-to-Origin links and never set `noTLSVerify`;
- encrypt Hub and node disks, copy encrypted backups to a different failure domain, and perform isolated restoration drills;
- restrict Hub container and Node Agent egress while allowing the required GitHub Release, npm, Cloudflare, and model-provider destinations;
- export Access, reverse-proxy, Hub audit, and node service logs to an independent system; alert on repeated authentication failures, revocation, frequent connection generations, reliable-queue pressure, and stale backups;
- isolate node workspaces at the operating-system level. Hub's full authority means every permission of the Node Agent account; that account need not be an administrator of the entire machine.

## Go-live checklist

- a private browser window reaches Cloudflare login first and a non-allowlisted account is rejected;
- direct Origin IP/port access reveals none of `/healthz`, the home page, REST, SSE, or WebSocket upgrades;
- removing the proxy-injected header breaks the public route, and restoring it recovers the route;
- two nodes use distinct Service Tokens, connect concurrently, and create their own sessions;
- stopping one Node Agent does not prevent chat or Settings operations on the other node;
- reconnecting the offline node replays only that node's backlog and both queue counts return close to zero;
- local Web, desktop, and Hub can continue one session interchangeably;
- backup permissions, manifest, SQLite integrity, and one isolated restoration have been verified.
