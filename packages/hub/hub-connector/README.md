# `@k1412/dsh-hub-connector`

English | [中文](README.zh.md)

Hub Connector is a host-side Cordis namespace plugin that exposes one existing DSH runtime to the local Hub Node Agent. It consumes the transport-independent `ctx.apiProxy` and Typert Gateway, so Hub, local Web, and desktop clients operate on the same sessions, event sources, persistence, settings, and model configuration.

The single command shown by Hub node enrollment installs this Connector bundle and its companion Node Agent together. From DSH's perspective, the client extension is this package's `dsh.bundle`; the persistent Node Agent is not another profile and owns no DSH runtime.

Connector opens only an authenticated local IPC client connection. It has no HTTP server, public listener, browser assets, DSH Web plugin dependency, or ownership of another DSH runtime. The `dsh.web` capability maps official Web HTTP requests and both event channels to Host services instead of proxying a node Web port. Removing Connector leaves every local DSH surface and session authoritative state unchanged.

The release bundle contributes one Cordis row to an existing profile. Its namespace export preserves `inject`, `Config`, and `apply` through the real Cordis Loader. One Connector instance identifies one DSH process by a stable runtime ID; several profiles on one machine may share the same Node Agent with distinct runtime IDs.

Connector detects the DSH version from the CLI package that launched the runtime. Set `DSH_HUB_DSH_VERSION` on the DSH process only when an embedding launcher hides that package path; an explicit `dshVersion` plugin setting takes precedence over both.

When Node Agent requests authoritative resynchronization, Connector replaces only its owner-only IPC and Host event subscriptions. The DSH process, live Agent, goal, and tool execution continue unchanged. Opening a fresh ApiProxy mux replays any still-pending question or approval with its stable request ID, allowing Hub to rebuild the interactive composer after a dropped connection.

## Model Experience

None, as the Connector bridges operator control-plane calls and registers no model-facing prompt, tool, skill, or context.

#### KV Cache effect

None; Connector transport records do not enter model requests.

## Known Limitations and Deferred Work

- Connector must run in a DSH Context that provides compatible Host `apiProxy` and Typert Gateway services. A standard profile provides them; another composition must compose those services and prerequisites explicitly. Connector cannot attach to an unrelated DSH process or infer that two processes share live state.
- Node Agent must run under an operating-system account that can read the owner-only IPC secret and reach the configured local endpoint.
