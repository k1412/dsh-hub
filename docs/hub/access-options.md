# Access options for a Hub deployment

The Hub keeps the DSH Runtime on the node and only needs one authenticated browser entry point plus outbound node connections. Choose the smallest network boundary that matches the operators who need access.

## Option A: Tailscale Serve (recommended for a private personal fleet)

Bind the Hub HTTP listener to localhost and publish it with `tailscale serve`. Serve is private to the tailnet, follows Tailscale grants or ACLs, and can add identity headers. The backend must continue listening only on localhost so those headers cannot be spoofed by a direct LAN request. This removes public DNS, certificate management, and inbound router rules. [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) documents the current CLI and identity-header behavior.

Use this when every browser and Hub host can run Tailscale. It is the default next-version deployment path.

## Option B: Tailcat point-to-point forwarding (minimal temporary access)

Tailcat is a netcat-like tool built from Tailscale's WireGuard, NAT traversal, and DERP components without a Tailscale control plane. It does not create a reusable authenticated Hub identity or an application policy. It is useful for a short-lived operator tunnel or bootstrap path, but it should terminate at a localhost-only reverse proxy and should not replace Hub enrollment, browser authentication, audit logging, or node authorization. The public DERP relays are rate-limited and have no uptime SLA. [Tailcat overview](https://tailscale.com/tailcat) and [Tailcat repository](https://github.com/tailscale/tailcat) describe these limits.

## Option C: Existing HTTPS reverse proxy plus identity provider

Keep the current reverse-proxy and Cloudflare Access design when the Hub must be reachable from browsers outside the tailnet. The proxy terminates HTTPS and forwards only to a loopback or private-network Hub origin. It must strip any incoming origin-secret header and inject the configured value itself. Cloudflare Access service tokens or an identity provider handle browser authentication; Hub still verifies the human session and keeps node enrollment separate.

## Option D: Self-hosted control plane

Use Headscale or another self-hosted WireGuard control plane when avoiding a hosted coordination service is a requirement. This retains the Tailscale-style private-network model but adds control-plane upgrades, ACL policy, DERP availability, and device enrollment to the operator's responsibilities.

## Recommendation

For the next release, add a first-run deployment choice with three supported paths: **private Tailscale Serve**, **existing HTTPS/Access**, and **temporary Tailcat tunnel**. The first two are full deployment modes. Tailcat is a diagnostic/bootstrap mode with an explicit expiry and no change to Hub's authorization model.

