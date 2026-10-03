# Gateway network tools and verification

The Hub image contains pinned Tailscale 1.102.4 and Tailcat 0.7.0 releases. Their Linux amd64/arm64 archives have fixed SHA-256 digests and are stored in `/app/downloads`. The node installation command selects the tool from its invitation; final enrollment uses only that encrypted overlay. The application does not probe LAN addresses or add LAN/public fallback paths.

Ordinary containers use a dedicated userspace `tailscaled`, with login and identity persisted in the Hub state volume. `compose.host-tailscale.yaml` reuses an already logged-in host Tailscale daemon: it only reads status and binds an independent listener to its Tailnet IP, without calling host `up`, `login`, or `serve`. Tailcat saves persistent Hub and node keys in isolated state directories; upstream tools manage direct connections and relays.

The installer checks local Tailscale first, with a four-second status timeout. An accessible, logged-in client is reused without another download or login; `DSH_GATEWAY_TAILSCALE_SOCKET` can select an existing daemon by absolute socket path. If that device signs out later, reuse mode asks you to sign into the existing Tailscale client instead of creating another identity. Hub invitations authorize DSH pairing; they do not replace Tailscale login or network permissions. The node must be able to reach Hub through its Tailnet.

On Linux amd64/arm64, an unavailable client triggers a pinned private-tool download and an official login prompt. Dedicated network archives are cached in `network-cache` under the node state directory. Repeat installations verify the entire SHA-256 before reuse; corrupted or different-version archives download again. Older installations download once when first adopting this cache. macOS requires the selected tool installed and Tailscale already logged in. The node CLI installs the plugin into an existing DSH Profile without starting a second DSH Runtime.

Run these commands from the repository to prepare tools and execute real network checks:

```sh
node deploy/gateway/download-network.mjs --directory /tmp/gateway-downloads --install-directory /tmp/gateway-tools --arch amd64
node deploy/gateway/smoke-network.mjs --mode all --bin-directory /tmp/gateway-tools --requests 40 --concurrency 4 --reconnects 3 --hub-restarts 1 --report /tmp/gateway-network-report.json
```

The test creates a temporary Hub network identity and two isolated node connection instances. It sends concurrent HTTP requests through actual Tailcat and Tailscale CLI tools, checks content and origin, and exercises node reconnections and Hub network process restarts. Host Tailscale configuration is unchanged; an unsigned-in Tailscale host fails explicitly. The report separates initial handshakes, sustained requests, and recovery latency, including p50, p95, failure rates, and recovery counts.

This is a connection-layer test. Both node instances run on one test machine; Tailscale uses the existing host's `nc` data path to its own Tailnet IP, so results do not represent a cross-machine or WAN path. Preserving the probe server's counter does not verify DSH history, drafts, or permission state. The recorded result is `reports/network-local-2026-10-03.json`.

Upstream references: [Tailscale userspace networking](https://tailscale.com/docs/concepts/userspace-networking), [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), [Tailcat](https://github.com/tailscale/tailcat/tree/v0.7.0).
