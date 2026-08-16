# dsh-hub-client-ui

English | [中文](README.zh.md)

`@k1412/dsh-hub-client-ui` is the Hub-specific client plugin mounted into the official DSH Web Settings framework. It does not replace session, project, message, model-selection, or interaction flows, and it never loads frontend JavaScript from a node.

## Pages

- **Hub nodes** creates one-time enrollment grants, lists and cancels pending enrollment, shows node and runtime state, switches the active runtime, and revokes a node identity.
- **Node plugins** shows the actually installed version, enabled state, and health; checks npm updates; relies on the Node Agent to preserve dependency and Cordis state before every update; shows every update outcome; and offers one-click rollback.
- **Advanced diagnostics** is collapsed by default inside Hub nodes. Terminal is an emergency shell with the Node Agent account's authority. Files starts only from an operator-entered absolute path, and writes and deletes use content hashes to reject concurrent replacement. Neither is a normal chat or project-file navigation entry.
- **Whole-profile snapshots** is collapsed by default inside Node plugins and is separate from automatic plugin rollback. It exists only for explicit configuration, dependency, or approved-data recovery points.

Every mutation uses the same-origin Hub API. Cloudflare Access authentication, the Hub operator allowlist, Origin Secret enforcement, and node capability validation remain server-side; the browser never holds a node Service Token or node private key.

## Model Experience

None, as this package extends operator Settings only and contributes no model-facing tools or context.

#### KV Cache effect

None; Settings state does not enter model requests.

## Known Limitations and Deferred Work

- Terminal keeps 256 KiB of browser scrollback and closes its PTY with the page; it is not a recoverable session.
- The file editor only saves fully read UTF-8 regular files of at most 1 MiB. Binary or larger files receive a safe explanation and cannot be saved from the browser.
