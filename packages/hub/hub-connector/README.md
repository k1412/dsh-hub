# `@k1412/dsh-hub-connector`

English | [中文](README.zh.md)

Hub Connector is a host-side Cordis namespace plugin that exposes one existing DSH runtime to the local Hub Node Agent. It consumes the transport-independent `ctx.apiProxy` host gateway, so Hub, local Web, and desktop clients operate on the same sessions, event sources, persistence, settings, and model configuration.

Connector opens only an authenticated local IPC client connection. It has no HTTP server, public listener, browser assets, DSH Web transport dependency, or ownership of another DSH runtime. Removing it leaves every local DSH surface and session authoritative state unchanged.

The release bundle contributes one Cordis row to an existing profile. Its namespace export preserves `inject`, `Config`, and `apply` through the real Cordis Loader. One Connector instance identifies one DSH process by a stable runtime ID; several profiles on one machine may share the same Node Agent with distinct runtime IDs.

Connector detects the DSH version from the CLI package that launched the runtime. Set `DSH_HUB_DSH_VERSION` on the DSH process only when an embedding launcher hides that package path; an explicit `dshVersion` plugin setting takes precedence over both.

## Model Experience

None, as the Connector bridges operator control-plane calls and registers no model-facing prompt, tool, skill, or context.

#### KV Cache effect

None; Connector transport records do not enter model requests.

## Known Limitations and Deferred Work

- Connector must run in a DSH Context that provides the compatible Host `apiProxy` service. The standard Web profile provides it; another composition must compose that Host service and its prerequisites explicitly. Connector cannot attach to an unrelated DSH process or infer that two processes share live state.
- Node Agent must run under an operating-system account that can read the owner-only IPC secret and reach the configured local endpoint.
