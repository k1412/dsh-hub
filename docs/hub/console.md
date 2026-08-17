# Using the DSH Hub console

English | [中文](console.zh.md)

This guide explains what Hub adds to official DSH Web. Sessions, project groups, working-directory selection, message streaming, tool rendering, scrolling, and mobile interactions come from official Web. Hub adds one node/Runtime selector to the official new-session row; management entries live under Settings in the lower-left menu.

## Start a session on a node and folder

1. Open **New session**. The main page continues to show project groups and sessions from every online Runtime together.
2. In the hero row, choose **Node and Runtime**. Hub preselects the last usable choice.
3. Use the adjacent official Workspace picker to choose a remembered folder or browse that node's filesystem to add one.
4. Send the first message. The Workspace identity becomes authoritative and every later request routes to its owner automatically.

Changing the node before the first message clears the previous blank-session selection so a prompt cannot be sent to the old node by mistake. Choosing an existing Workspace from the fleet list synchronizes the node selector to its owner. No visit to Settings is required.

## Check Current Runtime before changing Settings

The Settings header always shows **Current Runtime**. Switching it does not reload the shell. Hub refreshes both schema-backed settings and direct Host controllers such as models, permissions, and agents, while preventing a late read from the previous node from replacing the new state.

Settings scopes are:

| Page or setting | Owner |
|---|---|
| General permissions, default agent, and submission behavior | Current Runtime |
| General language and appearance | Current browser, independent of nodes |
| Models, configurable plugins, and Agent presets | Current Runtime |
| Hub nodes | Hub-global |
| Node plugins, update history, and managed-scope snapshots | Management target selected inside Node plugins |

The official **Plugins** page configures runtime settings for DSH feature plugins. Hub's separate **Node plugins** page manages package inventory, updates, and recovery; they are not the same operation.

## Enroll nodes and choose a fallback runtime

Open **Settings → Hub nodes**.

1. Enter a recognizable display name. Node ID is generated automatically and can be edited before submission.
2. Select **Generate enrollment code**. The code appears once and expires after 15 minutes.
3. Create a distinct Cloudflare Access Service Token for that node.
4. Copy the displayed one-command installer and run it on the target machine. Paste only the Service Token Client ID value, not the `CF-Access-Client-Id:` header label; the Client Secret uses a hidden prompt and does not enter shell history.
5. **Waiting to connect** lists unbound grants and allows cancellation before expiry. **Enrolled nodes** shows online, offline, and revoked states plus every DSH runtime.
6. Select **Set as default** only as the fallback for another ownerless Host operation. New sessions can choose their node directly on the main page. Revoking a node identity disconnects it immediately but does not delete sessions or files on the node.

One physical machine needs one Node Agent and may connect multiple DSH profiles with distinct runtime IDs. Every node requires a distinct Service Token.

If enrollment reports that a non-JSON page was returned before reaching Hub, the request was normally intercepted by Cloudflare Access or another edge layer. Verify the Client ID and Secret values, that the Access application has a Service Auth policy accepting that token, and that the token can reach `/hub/v1/bootstrap`; do not keep retrying with a new enrollment code until those checks pass.

## Plugin state, update, and rollback

Open **Settings → Node plugins** and choose a target runtime. **Current plugins** comes from the node's current DSH profile, not a Hub cache:

- **Healthy** means the package is installed, enabled in the profile bundle list, and its installed version matches the managed record.
- **Disabled** means the package exists but is not enabled.
- **Unhealthy** means the package is missing or its installed version differs from the managed record. Inspect node logs before continuing a batch update.

After **Check for updates**, the page shows current and registry-latest versions and exposes an update button only when a newer version exists. Every update follows this sequence:

- **Externally managed** means the package came from a local file, Workspace, Git, or an independent Release. Hub does not query npm or rewrite that source.
- **Temporarily unavailable** affects only that plugin; the rest of the inventory and update buttons remain usable.
- **Up to date** means the npm registry lookup succeeded and versions match.

1. The node verifies that the dependency lock did not change after the page read it.
2. The node automatically saves package manifests, lockfiles, Cordis configuration, and managed-plugin records as an update-specific rollback point.
3. The node downloads the exact version from the restricted public npm registry, records its artifact hash, invokes DSH profile management, and validates composition and installed state.
4. Failure restores automatically. Success enters **Update and rollback history** with source version, target version, time, and **Roll back to before update**.

Rollback never requires an operator to remember a hash, artifact ID, or snapshot ID. If a later update has changed the lock, an older rollback stops instead of overwriting newer state.

## Plugin rollback versus managed-scope snapshots

Plugin update does not require a manual snapshot. Each update creates its own automatic rollback point solely to undo that plugin change.

**Managed-scope snapshots** is collapsed by default and is a separate advanced recovery feature. It is not a disk or operating-system image:

- Configuration: top-level Cordis composition files.
- Dependencies: package manifests and lockfiles.
- Data: only `snapshotPaths` explicitly approved in Node Agent configuration.
- All managed paths: filtered profile configuration, dependencies, and approved data scope.

Snapshots remain in the node's private Node Agent state and are neither uploaded nor cached in Hub. The node creates a protection snapshot before restore. Secret-like filenames, environment files, and symbolic links are excluded, but the system does not classify arbitrary file content for secrets.

## Why terminal and files exist

**Settings → Hub nodes → Advanced diagnostics: terminal and files** is collapsed by default. These are rescue channels for when normal DSH workflows fail, not primary navigation.

- Emergency terminal checks or repairs Node Agent, Connector, DSH profiles, and system services. It requires explicit risk acknowledgement. The PTY closes with the page, is not stored as a session, and retains only bounded browser scrollback.
- Path-based files reads a known log or repairs a known configuration. It starts from an absolute node path and does not build a whole-disk index. Only fully read UTF-8 files up to 1 MiB are editable. Save and delete include the content version observed at read time and fail if the node file changed. Binary and larger files are read-only.

Both execute with the Node Agent operating-system account and enter Hub audit. Running Node Agent as root or administrator intentionally grants Hub that same authority.

## What Hub stores

Hub uses SQLite only for node identities, runtime and capability baselines, minimal session discovery fields, reliable delivery state, short-lived command bodies, and the audit chain. Sensitive command bodies are cleared after the browser claims completed results.

Hub does not cache full sessions, workspace files, terminal output, plugin artifacts, plugin rollback transactions, or snapshots. Nodes retain them and serve them on demand, so Hub backup and Node Agent state backup are separate boundaries.
