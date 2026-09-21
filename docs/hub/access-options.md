# Access options for a Hub deployment

The Hub keeps the DSH Runtime on the node and only needs one browser entry point plus outbound node connections. Choose the smallest boundary that matches the operators who need access.

## Option A: Tailscale Serve (recommended for a private fleet)

Bind the Hub HTTP listener to localhost and publish it with `tailscale serve`. Serve is private to the tailnet, follows Tailscale grants or ACLs, and can add identity headers. Keep the backend on localhost so those headers cannot be spoofed by a direct LAN request. This removes public DNS, certificate management, and inbound router rules. See the [Tailscale Serve documentation](https://tailscale.com/docs/features/tailscale-serve).

Use this when the Hub host and every browser can run Tailscale. It is the best default for several trusted devices because the control plane supplies device identity, policy, and revocation.

## Option B: Tailcat device-pair access (recommended for one or two trusted devices)

Tailcat provides an encrypted point-to-point tunnel using Tailscale's WireGuard, NAT traversal, and DERP components without a Tailscale control plane. It can bind access to the client's public `nodekey`, so possession of the address alone is insufficient.

This repository includes three scripts:

```sh
# On the operator device; keep the private key here.
deploy/tailcat/enroll-client.sh

# On the Hub host; register the printed public nodekey.
export TAILCAT_ALLOWED_NODEKEY='nodekey:...'
export DSH_HUB_PORT=3000
deploy/tailcat/serve-hub.sh

# On the operator device; use the address printed by the server.
export TAILCAT_ADDRESS='tc...'
deploy/tailcat/connect-hub.sh
# Open http://127.0.0.1:3000 in the browser.
```

The server uses a saved key named `default` by default. Generate it once with `tailcat genkey --key=default --fixed-region` if a stable address is useful; use `TAILCAT_SERVER_KEY=new` for a one-shot address. The Hub port remains localhost-only. The client private key never moves to the Hub; only its public `nodekey` is registered.

This is a strong device binding with an intentional default-trust model: every approved device can use the Hub with the same operator authority. Revoke a device by removing its `nodekey` from the service configuration and restarting the process. Rotate the server key when the address itself has been widely disclosed. Keep the address private unless `--allow` is configured; a Tailcat address is a bearer capability.

Tailcat has no users, groups, ACL policy language, device inventory, or central revocation service. Its CLI and wire protocol currently carry no stability promise, and public DERP relays are best effort. Therefore this mode is appropriate for a personal Hub, bootstrap, or a small fixed set of devices. Use Tailscale Serve for a larger fleet or changing operator membership. See the [Tailcat overview](https://tailscale.com/tailcat), [Tailcat key and allowlist guidance](https://github.com/tailscale/tailcat/blob/main/README.md#key-management), and [Tailcat protected access example](https://github.com/tailscale/tailcat/blob/main/README.md#protected-ssh-server-over-dns).

## Option C: Existing HTTPS reverse proxy plus identity provider

Keep the current reverse-proxy and Cloudflare Access design when the Hub must be reachable from browsers outside the private network. The proxy terminates HTTPS and forwards only to a loopback or private-network Hub origin. It must strip any incoming origin-secret header and inject the configured value itself. Cloudflare Access or another identity provider handles browser authentication; Hub keeps human sessions, audit, and node enrollment separate.

## Option D: Headscale or another self-hosted control plane

Use Headscale when avoiding a hosted coordination service is a requirement. This retains a Tailscale-style private-network model but makes control-plane upgrades, ACL policy, DERP availability, and device enrollment the operator's responsibility.

## Decision guide

| Situation | Recommended access mode | Why |
| --- | --- | --- |
| One Hub and one trusted laptop | Tailcat allowlisted `nodekey` | Minimal setup, no account or control plane |
| Several personal devices | Tailscale Serve | Device identity, ACLs, and revocation |
| External collaborators or public browser access | HTTPS proxy + identity provider | User identity and audit policy |
| Hosted coordination is unacceptable | Headscale | Self-hosted control plane and ACLs |

Tailcat protects the transport and binds a device key; it does not replace Hub's application authorization or node enrollment. Keep the Hub listener on localhost in every mode.
