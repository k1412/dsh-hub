# Choosing access: Tailcat pairing and browser login

English | [中文](access-options.zh.md)

Separate **how the browser reaches Hub** from **how Hub authorizes the operator**. Tailcat and Tailscale can provide connectivity. Hub's complete login implementation currently uses Cloudflare Access JWTs, an exact email allowlist, and the trusted proxy's Origin Secret.

## Choose by how you work

| What you need | Recommendation | Repository readiness |
|---|---|---|
| One or two personal computers paired with a private Hub | **Tailcat device pairing: our featured lightweight direction** | Pairing/forwarding scripts exist; device-only Hub login remains to be implemented |
| A domain you can open on a phone or any browser | **Cloudflare Access + reverse proxy** | Complete production path; see [deployment](deployment.md) |
| A NAS without a public IP or inbound ports | Add Cloudflare Tunnel to that path | Documented deployment with existing login retained |
| Several devices already using Tailscale | Connect the proxy and Hub over the Tailnet; Serve can provide a private entry point | Private transport works; Hub does not yet accept Serve identity headers as operator login |
| A device network control plane you operate yourself | Evaluate Headscale, then retain supported Hub authentication | External networking option, without a bundled one-command integration |

**Deploying a usable service today? Follow the Cloudflare Access guide. Evaluating personal device access without an account system? Start with the Tailcat scripts below.** Port forwarding alone is not a reason to remove Hub's authentication configuration.

## Why Tailcat is a featured direction

For a few fixed devices, pairing can be simple: the device keeps its private key and the Hub host records only its public `nodekey`. Later connections reuse the saved identity. You do not need a separate public reverse-proxy configuration for each browser device or changes to local DSH Web services.

The three scripts follow that workflow:

| Script | Run it on | What it does |
|---|---|---|
| [`enroll-client.sh`](../../deploy/tailcat/enroll-client.sh) | Operator computer | Saves a client identity and prints the public key for the Hub administrator |
| [`serve-hub.sh`](../../deploy/tailcat/serve-hub.sh) | Hub host | Serves one local TCP port through Tailcat, allowing only the configured client public key |
| [`connect-hub.sh`](../../deploy/tailcat/connect-hub.sh) | Operator computer | Uses the saved client key to forward the remote port onto local `127.0.0.1` |

For Docker, publish the container port on the NAS host's loopback interface and run Tailcat on the host. The container needs no VPN client, TUN access, or additional privileges. DSH nodes continue using their existing Node Agent connections.

Tailcat provides encrypted tunnels and NAT traversal without a Tailscale account. It is a separate tool from `tailscaled`; see the [official overview](https://tailscale.com/tailcat).

## What the scripts do today

| Capability | Status |
|---|---|
| Persistent client identity, public-key allowlist, reusable server identity | Provided by the scripts |
| Client loopback binding and selectable local/remote ports | Provided by the scripts |
| Forward a container's published port from its NAS host | Available when that port is reachable on the host |
| Map a Tailcat peer key to a Hub operator and issue a browser session | **Not implemented** |
| Replace Node Agent Access Service Tokens and enrollment with Tailcat | **Not implemented** |
| Manage Tailcat devices or immediately invalidate their browser sessions from Hub | **Not implemented** |

The steps below therefore **verify a device tunnel**, not a complete passwordless Hub installation. The raw Hub port still requires the Origin Secret and application authentication. Changing a URL to `localhost` also does not migrate browser origins or cookies.

## Try it: pair once, reuse the connection script

### Prepare both machines

Install Tailcat on the Hub host and operator computer using its [official installation guide](https://github.com/tailscale/tailcat/blob/main/INSTALL.md), then check `tailcat --help`. The bundled Bash scripts target Linux/macOS. Hub has a PowerShell node installer, but this repository does not yet provide PowerShell equivalents of these Tailcat scripts.

Run these commands from the repository root. The example assumes an already configured Hub with host loopback port `8080`, following [deployment](deployment.md), and uses client port `18080` to avoid conflicts. If your deployment uses a different port, change `DSH_HUB_PORT` on both sides.

### 1. Generate an identity on the operator computer, once

```bash
bash deploy/tailcat/enroll-client.sh
```

This saves the default `client-default` key. Give the printed **`nodekey:…` public key** to the Hub host. Do not copy the private key or regenerate the identity on every connection.

### 2. Allow that device on the Hub host

Create a saved server key on first use:

```bash
tailcat genkey --key=default --fixed-region
```

Then enter the complete client public key and start serving:

```bash
export TAILCAT_ALLOWED_NODEKEY='nodekey:<replace-with-full-client-public-key>'
export DSH_HUB_PORT=8080
bash deploy/tailcat/serve-hub.sh
```

Keep the process running and save the printed `tc…` address. The script does not install a background service. It refuses to start without a public-key allowlist; Tailcat validates the actual key. See upstream [key management](https://github.com/tailscale/tailcat/blob/main/README.md#key-management) for saved keys and fixed relay regions.

### 3. Connect from the operator computer

```bash
export TAILCAT_ADDRESS='tc<replace-with-server-address>'
export DSH_HUB_PORT=8080
export DSH_HUB_LOCAL_PORT=18080
bash deploy/tailcat/connect-hub.sh
```

The script stays in the foreground and binds only to `127.0.0.1`. Reuse this step for later connections without enrolling again.

### 4. Verify transport without confusing it with login

In another terminal on the operator computer:

```bash
curl --include http://127.0.0.1:18080/healthz
```

For a standard Hub Origin, expect **HTTP 404**: the request reached Hub through the tunnel but lacks the trusted proxy's Origin Secret. Also request `http://127.0.0.1:8080/healthz` directly on the Hub host and compare behavior and service logs. A single 404 does not prove the allowlist works.

Check rejection using an unapproved device or a separate new client identity. It must not receive an HTTP response from Hub. Do not copy the approved private key to that device. For a timeout or refused connection, check both processes, addresses, keys, and ports; do not remove `--allow` to make a connection succeed.

**Opening `http://127.0.0.1:18080` at this point does not give you a usable Hub login.** Continue using the configured HTTPS entry point for daily browser access. Do not inject the Origin Secret in the browser or disable Hub JWT verification.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TAILCAT_BIN` | `tailcat` | Path to a custom Tailcat executable |
| `TAILCAT_CLIENT_KEY` | `client-default` | Saved client key name; use the same value during generation and connection |
| `TAILCAT_SERVER_KEY` | `default` | Saved server key; explicitly use `new` for an ephemeral experiment |
| `TAILCAT_ALLOWED_NODEKEY` | Required | Public client identity allowed by the server |
| `TAILCAT_ADDRESS` | Required | Server address used by the client |
| `DSH_HUB_PORT` | `3000` | Agreed server-side local port; explicitly use `8080` for standard Compose |
| `DSH_HUB_LOCAL_PORT` | `3000` | Client loopback port; this example uses `18080` |

## Device-trust authentication: the next stage

The intended experience is: **once you explicitly approve your own device, it can enter your personal Hub with full operator authority without another account login each time.** This is a design target, not a capability delivered by the current scripts.

Implementation needs a separate private authentication entry point. It must obtain the peer public key from a verified Tailcat connection, look up the approved device, map it to the single operator, and issue a Hub session. The public route keeps its existing Cloudflare Access policy. Neither a localhost source address nor a self-reported HTTP header proves device identity.

Current `serve` TCP forwarding does not add a peer identity that Hub can simply trust in ordinary HTTP requests. A bridge needs authenticated Tailcat connection context or a dedicated adapter, integrated and tested with browser origin checks, cookies, WebSockets, and audit records. Acceptance must include:

- approved devices enter; unapproved devices and forged headers cannot bypass authentication;
- logins and significant actions remain attributable to a device key;
- device revocation invalidates existing HTTP sessions and WebSockets;
- public Access and node enrollment retain their existing verification;
- a defined browser Origin passes complete desktop and mobile interaction checks.

## Revocation and key handling

To revoke tunnel access today, stop the server process to interrupt connections, remove the device key or replace it with another approved key, and restart. Do not restart with an unrestricted allowlist. Key files are copyable software identities; treat a lost device as a potentially compromised private key.

The public key, server `tc…` address, and private key serve different purposes. Exchange the public key for pairing, share the address privately, and keep the private key in private device storage. Tailcat has no centralized device-management service or CLI/wire compatibility guarantee; pin and check your chosen version. Public relays are best effort; see [upstream constraints](https://github.com/tailscale/tailcat/blob/main/README.md).

**Revoking a Tailcat tunnel does not revoke a Hub node** or an existing public Access login. For a retired DSH machine, revoke its identity in Hub nodes and revoke its Service Token separately; see [operations](operations.md).

## If you already use Tailscale

For several devices on the same Tailnet, reuse that network for the private proxy-to-Hub connection. Tailscale Serve can also provide private HTTPS and identity headers, but Hub does not yet implement login based on those headers. Enabling Serve is not sufficient to complete Hub authentication. See [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).

For an existing public Hub, evaluate device tunnels as a separate access path while retaining the domain's authentication policy. Verify transport first, then deliver device authentication without interrupting the working entry point.
