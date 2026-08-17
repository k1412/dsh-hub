# dsh-hub-node-agent

English | [中文](README.zh.md)

`@k1412/dsh-hub-node-agent` is the only long-running process on a node that communicates with the Hub. It opens an outbound WSS connection through Cloudflare Access, owns the node Ed25519 identity and reliable SQLite journal, authenticates local Connectors, supervises reconnects, and preserves commands across DSH restarts. It opens no inbound TCP port.

Hub releases provide one-command installers for Linux/macOS and Windows. The Hub node-enrollment page generates a complete command containing the short-lived enrollment grant; the installer verifies release checksums, installs this package under a private versioned user directory, installs the Connector bundle into an existing DSH profile, and configures a current-user system service. The Cloudflare Client Secret is collected only through a hidden prompt and is absent from the copied command and process arguments.

Node Agent cannot share the Connector plugin lifecycle. A DSH profile restart must unload its plugin, while node identity, WSS recovery state, and unacknowledged command journal must survive; several profiles on one machine must also share one node network identity. Connector is therefore the user-visible DSH plugin, while Node Agent is a same-account sidecar installed by the same command, not a second DSH runtime.

The service validates the Hub's pinned application key before enrollment and on every handshake. A Cloudflare Service Token supplies the edge machine identity; an Ed25519 challenge proves the enrolled node identity. Reconnect uses exponential full-jitter backoff, a new boot identity, Hub-assigned connection generation fencing, signed sequence replay, cumulative acknowledgements, heartbeat termination, and strict payload bounds.

After reconnecting, Node Agent sends the existing outbox in sequence-number pages before publishing runtime baselines. At the outbox high-water mark it reserves capacity for control records such as command results, runtime lifecycle, acknowledgements, pending question or approval requests, and the `goal` session projection used by CAS-backed Goal controls. Reconstructible high-volume stream frames are suppressed, while human-interaction request and resolution frames and Goal projection changes enter the control reserve or its bounded deferred queue. The early stream high-water mark counts queued `stream.frame` records and bytes, not large command results such as `session.history`; total records and bytes still enforce the hard reliable-journal quota. After pressure recovers, Node Agent requests a new authoritative stream generation from affected runtimes. Connection callbacks and a full queue cause backoff and diagnostics instead of terminating the long-running process.

Every 15 seconds Node Agent reports outbox records, bytes, oldest-record time, capacity, pressure, and cumulative suppressed stream frames to Hub. The report uses the same reliable path. When that path is completely full, Hub still exposes its reverse outbox and connection state, and the node report follows after an acknowledgement releases capacity.

Each DSH runtime connects over an owner-only Unix socket or an HMAC-authenticated Windows named pipe using a 256-bit secret. A runtime publishes its capability baseline and receives only commands addressed to its runtime id. Commands remain `processing` until the Connector returns a result. After a crash, read and idempotent work may resume, reconcile operations inspect authoritative state through their stable command identity, and never-retry work returns `outcome-unknown`.

The configuration, private key, Connector secret, enrollment code, Service Token secret, and SQLite database use owner-only files. The one-time enrollment code is atomically removed after Hub acceptance. The Node Agent runs with the same OS account whose DSH context the Hub is authorized to control; it never silently elevates to host root.

## Model Experience

None, as the Node Agent is control-plane transport and registers nothing model-facing.

#### KV Cache effect

None; Node Agent records do not enter model requests.

## Known Limitations and Deferred Work

- The process manager supplies restart, log retention, resource limits, and operating-system sandboxing. The package deliberately does not install itself as root.
- A node identity and its reliable database form one recovery unit. Losing the database while retaining the key requires revocation and re-enrollment instead of guessing sequence state.
- Suppressed transient stream frames are not presented as reliable replay. Reconstructible state returns from a fresh runtime stream generation, while transient output such as a terminal is explicitly reported as interrupted. Pending question and approval control frames and Goal projection changes are never intentionally suppressed.
