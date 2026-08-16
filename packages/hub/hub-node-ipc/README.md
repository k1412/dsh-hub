# dsh-hub-node-ipc

English | [中文](README.zh.md)

`@k1412/dsh-hub-node-ipc` defines the local stream between the out-of-process Node Agent and the Connector inside a DSH runtime. It uses strict JSON frames, a four-byte length prefix, a 4 MiB frame limit, and a fresh challenge authenticated with HMAC-SHA-256. The 256-bit shared secret never crosses the socket.

Unix deployments place the socket and secret in an owner-only directory. Windows deployments use an HMAC-authenticated named pipe and protect the secret with owner-only file permissions. The Node Agent opens no inbound TCP listener. A local process that cannot read the secret cannot register a runtime or inject a Hub command.

The local body carrier reuses the Hub protocol's strict business-body schemas but does not reuse its Internet signature envelope. The Node Agent remains the only owner of WSS, Ed25519 identity, sequence journals, enrollment credentials, and reconnect policy.

## Model Experience

None, as local transport registers nothing model-facing.

#### KV Cache effect

None; IPC records do not enter model requests.

## Known Limitations and Deferred Work

- Operating-system permissions are part of authentication. An administrator or a process already running as the Node Agent account can inspect the secret and is inside that node's authority boundary.
- One Connector connection owns one runtime id at a time; reconnecting the same id supersedes its previous local socket.
