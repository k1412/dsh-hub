# Deploy DSH Hub

English | [中文](deployment.zh.md)

This tutorial installs one Hub with Docker Compose, places it behind Cloudflare Access and a trusted reverse proxy, and enrolls one existing DSH profile. It uses generic names and paths; keep environment-specific hostnames, addresses, tokens, and email addresses outside the repository.

## Prerequisites

- A Linux Docker host with Docker Engine and Compose v2.
- An HTTPS hostname routed through Cloudflare Access to a trusted reverse proxy.
- A Cloudflare Access self-hosted application with one human policy and one Service Token policy.
- Node.js 22.19 or later, `pnpm`, and DSH on every node. The target DSH composition must provide the transport-independent `@deepseek-ai/dsh-host-apiproxy` service; the standard Web profile already provides it. Install the platform C/C++ build toolchain and Python required by `node-pty` before installing the Node Agent.
- A private route from the reverse proxy to the Hub origin, either loopback, a private network, or an authenticated overlay network.

## 1. Configure Cloudflare Access

Create one self-hosted Access application for the Hub hostname. Add an allow policy for the operator identity provider and an allow policy containing the Service Tokens issued to nodes. Record the application audience, team domain, and one distinct Service Token per node.

Use Cloudflare's current guidance for [self-hosted Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/), [validating Access JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), and [Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/). Keep the application audience and Service Token identity separate from the Hub's own enrollment and Ed25519 identities.

The Hub validates the Access JWT independently. Browser JWTs must carry an allowlisted email, and node JWTs must carry a Service Token `common_name`. A valid Cloudflare session does not bypass the Hub allowlist or node enrollment.

## 2. Configure the trusted origin path

Configure the reverse proxy to remove every client-supplied `X-DSH-Origin-Secret` header and add its own fixed random value. Forward HTTP upgrades and disable response buffering for SSE. Route the origin only over loopback or a private network and restrict its firewall to the proxy.

Direct requests to the Hub IP and port do not contain the proxy-held secret and receive a not-found response. The origin-secret check remains required even when a firewall or overlay network already limits reachability.

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

Use the Hub UI or the authenticated REST endpoint to create a short-lived enrollment grant. Choose a stable node ID and a descriptive display name. The one-time enrollment code is returned once and is stored by Hub only as a hash. An unattended deployment may stop Hub and run the offline administration command through the same Compose project. Never let the offline command and Hub Server write the state volume concurrently:

```bash
docker compose stop hub
docker compose run --rm hub node /app/hub-server.mjs create-enrollment \
  --node-id workstation-1 --display-name "Workstation 1" --expires-in 900
docker compose up -d hub
```

The output contains the one-time code. Write it directly to the target node's owner-only configuration; never place it in shell history, logs, tickets, or Git. Offline creation is recorded in the audit chain with the `local-admin` actor.

Create a separate Cloudflare Access Service Token for the node. Do not reuse a token across nodes: per-node tokens allow independent rotation and revocation, and the Hub permanently binds the Service Token identity to the enrolled Ed25519 node key.

## 5. Install the node packages

Download the Node Agent, Connector, and checksum manifest from the same release. Verify both artifacts before installation. The following example keeps secrets out of command arguments; enter both values at the hidden prompts.

```sh
VERSION=0.1.0-rc.7
RELEASE="https://github.com/k1412/dsh-hub/releases/download/hub-v${VERSION}"
curl --fail --location --remote-name "${RELEASE}/SHA256SUMS"
curl --fail --location --remote-name "${RELEASE}/k1412-dsh-hub-node-agent-${VERSION}.tgz"
curl --fail --location --remote-name "${RELEASE}/k1412-dsh-hub-connector-${VERSION}.tgz"
if command -v sha256sum >/dev/null; then
  sha256sum --check SHA256SUMS
else
  shasum -a 256 --check SHA256SUMS
fi
npm install --global "./k1412-dsh-hub-node-agent-${VERSION}.tgz"
read -rsp "Access Client Secret: " DSH_HUB_ACCESS_CLIENT_SECRET; echo
read -rsp "Enrollment Code: " DSH_HUB_ENROLLMENT_CODE; echo
export DSH_HUB_ACCESS_CLIENT_SECRET DSH_HUB_ENROLLMENT_CODE
dsh-hub-node init \
  --hub https://hub.example.com \
  --node workstation-1 \
  --access-client-id replace-with-service-token-client-id \
  --profile web \
  --runtime-id default \
  --profile-directory "${DSH_HOME:-$HOME/.dsh}/profiles/web" \
  --install-connector "$(pwd)/k1412-dsh-hub-connector-${VERSION}.tgz"
unset DSH_HUB_ACCESS_CLIENT_SECRET DSH_HUB_ENROLLMENT_CODE
```

`init` fetches and pins the Hub public key through the Service Token, writes an owner-only Node Agent configuration, creates a persistent node identity and Connector IPC secret, and optionally installs the Connector into the selected DSH profile. The Connector bundle contributes one Cordis row, consumes the existing Host gateway, and does not alter the Web listener or frontend bundle.

Run the Node Agent through the platform service manager under the same operating-system account as DSH. Use the printed configuration path as `dsh-hub-node --config <path>`. Configure automatic restart, a private home directory, and no privilege elevation. The [node service guide](node-services.md) provides Linux, macOS, and Windows examples.

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
