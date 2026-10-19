# Upstream DSH compatibility and node upgrades

For gateway plugin `2.0.0-alpha.2`, the explicitly validated versions are `0.1.7-rc.2` and `0.2.1-rc.2`; other prereleases are not implicitly supported. Invitation installation and plugin peers declare this same range. Clients, Typert descriptors and assets come from each node's own DSH installation. The Hub does not copy model configuration or credentials.

DSH 0.2.1 requires a native Connection Peer. Each paired plugin connection creates its own owner Peer, shared by HTTP and mux with native interactions enabled. The trusted local plugin creates this identity; browser identity fields do not select it. Cordis owns its disposal. Older runtimes without createPeer retain their native legacy interface. Nodes and Hub plugin connections never share Peers.

Preserve the profile, sessions and current runtime before installing an exact version in a separate release directory. Updating the three connection plugins preserves named Loader entries, workspaces, grants and connection files. Check for active tasks before switching. Restore the old runtime and profile if verification fails. Do not rebuild the user's profile from defaults.

Release validation includes check/build, simultaneous node Peer isolation, old/new native SDKs, Chromium/WebKit mobile input and Full access, model selection, fixture replies and reloaded history, file upload/download, and coexistence of the actual three connection archives. Runtime tests use a fixture model. Offline nodes retain their identity and are upgraded after reconnection; they are not reported complete.
