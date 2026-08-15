# dsh-hub-node-agent

English | [中文](README.zh.md)

`@k1412/dsh-hub-node-agent` is the only long-running process on a node that communicates with the Hub. It opens an outbound WSS connection through Cloudflare Access, owns the node Ed25519 identity and reliable SQLite journal, authenticates local Connectors, supervises reconnects, and preserves commands across DSH restarts. It opens no inbound TCP port.

The service validates the Hub's pinned application key before enrollment and on every handshake. A Cloudflare Service Token supplies the edge machine identity; an Ed25519 challenge proves the enrolled node identity. Reconnect uses exponential full-jitter backoff, a new boot identity, Hub-assigned connection generation fencing, signed sequence replay, cumulative acknowledgements, heartbeat termination, and strict payload bounds.

Each DSH runtime connects over an owner-only Unix socket or an HMAC-authenticated Windows named pipe using a 256-bit secret. A runtime publishes its capability baseline and receives only commands addressed to its runtime id. Commands remain `processing` until the Connector returns a result. After a crash, read and idempotent work may resume, reconcile operations inspect authoritative state through their stable command identity, and never-retry work returns `outcome-unknown`.

The configuration, private key, Connector secret, enrollment code, Service Token secret, and SQLite database use owner-only files. The one-time enrollment code is atomically removed after Hub acceptance. The Node Agent runs with the same OS account whose DSH context the Hub is authorized to control; it never silently elevates to host root.

## Model Experience

None, as the Node Agent is control-plane transport and registers nothing model-facing.

#### KV Cache effect

None; Node Agent records do not enter model requests.

## Known Limitations and Deferred Work

- The process manager supplies restart, log retention, resource limits, and operating-system sandboxing. The package deliberately does not install itself as root.
- A node identity and its reliable database form one recovery unit. Losing the database while retaining the key requires revocation and re-enrollment instead of guessing sequence state.
