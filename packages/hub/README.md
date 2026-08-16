# hub/ — DSH Hub control-plane packages

English | [中文](README.zh.md)

The Hub package family defines the remote control plane without turning the Hub into a DSH runtime.

| Package | Role | ctx key |
|---|---|---|
| [`hub-protocol/`](hub-protocol/README.md) | Signed, versioned Hub-to-node wire vocabulary and capability descriptors | none |
| [`hub-storage/`](hub-storage/README.md) | SQLite control-plane records with no node-file cache | none |
| [`hub-transport/`](hub-transport/README.md) | Durable sequences, acknowledgements, replay, and connection fencing | none |
| [`hub-server/`](hub-server/README.md) | Authenticated operator API, event delivery, and Agent WebSocket server | none |
| [`hub-capabilities/`](hub-capabilities/README.md) | Runtime-validated DSH session, terminal, plugin, snapshot, settings, and file contracts | none |
| [`hub-node-ipc/`](hub-node-ipc/README.md) | Authenticated local Connector-to-Agent framing with owner-only secrets | none |
| [`hub-node-agent/`](hub-node-agent/README.md) | Outbound WSS, durable node state, local Connector registry, and supervision | none |
| [`hub-connector/`](hub-connector/README.md) | Cordis plugin bridging existing DSH Host APIs and event channels into authenticated local IPC | `apiProxy`, Typert Gateway |
| [`hub-client-ui/`](hub-client-ui/README.md) | Node, plugin, and advanced-diagnostic pages mounted into official Web Settings | `slots`, `locale` |

The dependency direction is from Hub applications, Node Agent, and Connector implementations toward `hub-protocol`. The protocol package has no Web-server, Agent, model, tool, or filesystem-control dependency.

## Known Limitations and Deferred Work

- The Hub packages implement a single active Hub writer; multi-writer high availability requires a separate consensus design.
