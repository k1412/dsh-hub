# Gateway network tools and verification

The Hub image contains pinned Tailscale 1.102.4 and Tailcat 0.7.0 releases. Their Linux amd64/arm64 archives have fixed SHA-256 digests and are stored in `/app/downloads`. The node installation command selects the tool from its invitation; final enrollment uses only that encrypted overlay. The application does not probe LAN addresses or add LAN/public fallback paths.

Ordinary containers use a dedicated userspace `tailscaled`, with login and identity persisted in the Hub state volume. `compose.host-tailscale.yaml` reuses an already logged-in host Tailscale daemon: it only reads status and binds an independent listener to its Tailnet IP, without calling host `up`, `login`, or `serve`. Tailcat saves persistent Hub and node keys in isolated state directories; upstream tools manage direct connections and relays.

The installer checks local Tailscale first, with a four-second status timeout. An accessible, logged-in client is reused without another download or login; `DSH_GATEWAY_TAILSCALE_SOCKET` can select an existing daemon by absolute socket path. If that device signs out later, reuse mode asks you to sign into the existing Tailscale client instead of creating another identity. Hub invitations authorize DSH pairing; they do not replace Tailscale login or network permissions. The node must be able to reach Hub through its Tailnet.

On Linux amd64/arm64, an unavailable client triggers a pinned private-tool download and an official login prompt. Dedicated network archives are cached in `network-cache` under the node state directory. Repeat installations verify the entire SHA-256 before reuse; corrupted or different-version archives download again. Older installations download once when first adopting this cache. macOS requires the selected tool installed and Tailscale already logged in. The node CLI installs the plugin into an existing DSH Profile without starting a second DSH Runtime.


Multiple Hubs can connect through the same existing Profile/Runtime. Give each experimental connection its own `--state-directory`, `--instance` and `--package-alias`, preserving the base package, identity and configuration. For example:

```sh
curl -fsSL https://experiment-hub.example/install.sh -o /tmp/experiment-install.sh
sh /tmp/experiment-install.sh --hub https://experiment-hub.example --invite TOKEN --profile web --instance gateway-node-control --package-alias @k1412/dsh-gateway-node-control --state-directory "$HOME/.local/state/dsh-gateway-control" --control
```

The installer verifies the downloaded archive, then creates a private `file:` archive whose actual package name matches the requested alias. Session browser registration uses that same name. This prevents pnpm hoisted layouts from deduplicating different experimental code under the base package name and version. Installed runtime, CLI, manifest and browser files are compared against the derived archive before activation; a mismatch restores the Profile files and refuses activation. Experimental dependencies stay outside the Profile bundle list. The installer inserts a separate Cordis Loader entry pointing to the alias package's `lib/index.js` in that Profile. The rc.2 browser scanner ignores bare aliases whose names differ from the package manifest; absolute module paths use its supported package discovery and register the session navigation client once. Reinstalling a named entry preserves its additional configuration, including the delegation workspace and trusted package list. Omitting the new options preserves existing installation behavior. Reload the same Runtime through its existing service mechanism.

To remove an experiment, first delete only its managed block from `# BEGIN DSH GATEWAY INSTANCE gateway-node-control` through `# END DSH GATEWAY INSTANCE gateway-node-control`. Then remove the `@k1412/dsh-gateway-node-control` dependency with that Profile's package manager and reload the original Runtime. Preserve the base entry, base dependency and other connections' state directories. Hub stores no model configuration or credentials.

Run these commands from the repository to prepare tools and execute real network checks:

```sh
node deploy/gateway/download-network.mjs --directory /tmp/gateway-downloads --install-directory /tmp/gateway-tools --arch amd64
node deploy/gateway/smoke-network.mjs --mode all --bin-directory /tmp/gateway-tools --requests 40 --concurrency 4 --reconnects 3 --hub-restarts 1 --report /tmp/gateway-network-report.json
```

The test creates a temporary Hub network identity and two isolated node connection instances. It sends concurrent HTTP requests through actual Tailcat and Tailscale CLI tools, checks content and origin, and exercises node reconnections and Hub network process restarts. Host Tailscale configuration is unchanged; an unsigned-in Tailscale host fails explicitly. The report separates initial handshakes, sustained requests, and recovery latency, including p50, p95, failure rates, and recovery counts.

This is a connection-layer test. Both node instances run on one test machine; Tailscale uses the existing host's `nc` data path to its own Tailnet IP, so results do not represent a cross-machine or WAN path. Preserving the probe server's counter does not verify DSH history, drafts, or permission state. The recorded result is `reports/network-local-2026-10-03.json`.

Upstream references: [Tailscale userspace networking](https://tailscale.com/docs/concepts/userspace-networking), [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), [Tailcat](https://github.com/tailscale/tailcat/tree/v0.7.0).

The manual release acceptance gate below requires a complete, isolated DSH rc.2 code tree and separately built base/session/control archives; build the control archive with `pnpm run build` first. It is not part of the automatic CI steps. The official CLI reproduces and repairs a hoisted three-package collision, boots all three connections in one temporary Runtime, verifies delegation readiness, and checks isolated removal. Each browser first acknowledges Continue through the base connection; upstream persists that notice in the shared Runtime, so session/control origins must reach provider dismissal without a repeated notice. Chromium and WebKit use normal provider dismissal, pointer focus and keyboard input to create an **unsent** draft. Before interrupting only an owned fixture connection, the gate requires one visible conversation and its exact native `dsh.conversation.<sessionId>` draft mirror. It then checks connector/browser mux recovery, unchanged conversation/draft, unchanged blank-turn state, and unaffected other connections. A separate reader checks the real `/plugins/events` SSE graph before interruption, old-stream closure, and a fresh graph after recovery; this is not a claim of browser EventSource recovery.

```sh
export DSH_NATIVE_ROOT=/path/to/isolated/dsh/node_modules/@deepseek-ai/dsh
export DSH_GATEWAY_BASELINE_PACKAGE=/path/to/base/gateway-node.tgz
export DSH_GATEWAY_SESSION_PACKAGE=/path/to/session/gateway-node.tgz
export DSH_GATEWAY_CONTROL_PACKAGE="$PWD/dist/gateway/downloads/gateway-node.tgz"
DSH_NATIVE_BROWSER=chromium pnpm exec tsx packages/hub/gateway-node/tests/coexist-native-smoke.mts
DSH_NATIVE_BROWSER=webkit pnpm exec tsx packages/hub/gateway-node/tests/coexist-native-smoke.mts
```

The carrier is a loopback fixture, with private temporary Profile/state directories and no model inference. Reports print their temporary artifact directory and separate connector, browser mux and native-stream recovery timings. These measurements do not establish public-network latency or an SLA. No production Profile or host Tailscale identity is used.

Large native history messages are split into bounded transport frames and reassembled unchanged. Each message is limited to 16 MiB, with a 32 MiB queue budget per node connection. Update the node plugin together with the Gateway to enable large-message transfer; existing small-message framing remains compatible. A closed native channel explicitly closes the browser connection instead of leaving history loading indefinitely.
