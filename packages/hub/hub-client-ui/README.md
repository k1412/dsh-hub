# dsh-hub-client-ui

English | [中文](README.zh.md)

`@k1412/dsh-hub-client-ui` is the Hub-specific client plugin mounted into official DSH Web. It contributes a node/Runtime selector to the official new-session row and adds management pages to the official Settings framework. It does not replace session, project, message, model-selection, folder-selection, or interaction flows, and it never loads frontend JavaScript from a node.

## Pages

- **New session target** lists online Runtimes that advertise `dsh.web.fetch` beside the official Workspace picker. The last choice is preselected, changing it clears only the current blank-session selection, and choosing an aggregated existing Workspace automatically synchronizes the selector to that Workspace's owner.
- **Current Runtime** shows the selected node and Runtime in the official Settings header. Switching it updates the tab-local owner and refreshes schema scopes plus direct Host controllers such as models, permissions, and agents without remounting the official Settings shell; generation fencing prevents a late response from the previous node from being displayed or written. Language and appearance remain browser-owned, Hub nodes are Hub-global, and Node plugins selects its management target separately.
- **Hub nodes** creates one-time enrollment grants, lists and cancels pending enrollment, shows node and runtime state, monitors reliable queues in both directions, stream interruptions, pending browser control waits, and command timeouts, chooses the default runtime for ownerless operations without filtering the fleet session page, and revokes a node identity. Health data refreshes every 15 seconds.
- **Node plugins** shows the actually installed version, enabled state, and health; classifies npm, external, and failed lookups independently; relies on the Node Agent to preserve dependency and Cordis state before every update; shows every update outcome; and offers one-click rollback.
- **Advanced diagnostics** is collapsed by default inside Hub nodes. Terminal is an emergency shell with the Node Agent account's authority. Files starts only from an operator-entered absolute path, and writes and deletes use content hashes to reject concurrent replacement. Neither is a normal chat or project-file navigation entry.
- **Managed-scope snapshots** is collapsed by default inside Node plugins and is separate from automatic plugin rollback. It exists only for explicit configuration, dependency, or approved-data recovery points and is not an operating-system image.

Every mutation uses the same-origin Hub API. Cloudflare Access authentication, the Hub operator allowlist, Origin Secret enforcement, and node capability validation remain server-side; the browser never holds a node Service Token or node private key. The reviewed Hub document explicitly enables Host-backed Settings across this authenticated control plane without classifying the public page as loopback, so native desktop actions such as opening a local path remain unavailable remotely.

## Model Experience

None, as the new-session selector and Settings pages contribute no model-facing tools or context.

#### KV Cache effect

None; Settings state does not enter model requests.

## Known Limitations and Deferred Work

- Terminal keeps 256 KiB of browser scrollback and closes its PTY with the page; it is not a recoverable session.
- The file editor only saves fully read UTF-8 regular files of at most 1 MiB. Binary or larger files receive a safe explanation and cannot be saved from the browser.
- The selected Runtime is the owner for Settings and new ownerless operations, not a fleet-list filter. Sessions from all enrolled nodes remain aggregated and grouped by Workspace folder with their node label attached.
