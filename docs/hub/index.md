# DSH Hub documentation

English | [中文](index.zh.md)

DSH Hub provides one authenticated browser workspace for multiple DeepSeek Harness nodes while preserving each node as the authority for its runtime, sessions, workspaces, plugins, and credentials.

## Guides

- [Deployment](deployment.md) installs the Hub with Docker Compose and enrolls a DSH node.
- [Console guide](console.md) explains node enrollment, plugin state, automatic rollback, explicit snapshots, and advanced diagnostics.
- [Node services](node-services.md) runs the Node Agent under Linux, macOS, or Windows service management.
- [Operations](operations.md) covers enrollment, revocation, backup, restore, release upgrades, and recovery.

## References

- [Architecture](architecture.md) defines component ownership, transports, persistence, command delivery, and local-client coexistence.
- [Security](security.md) defines the trust boundaries, Cloudflare Access requirements, node authority, secret handling, and deployment hardening.

## Supported topology

One Hub controls any number of independently enrolled Node Agents. A node may expose one or more DSH runtimes, and each runtime may continue serving local Web and desktop clients while Hub is connected. Hub requires no inbound node port, SSH tunnel, or DSH Web route.
