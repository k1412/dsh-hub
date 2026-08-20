# Operate DSH Hub

English | [中文](operations.zh.md)

This guide covers routine lifecycle operations after the Hub and at least one node are installed.

## Enroll a node

Create a short-lived enrollment grant while authenticated as the operator, issue a distinct Cloudflare Access Service Token, and run `dsh-hub-node init` on the target node. Unattended operation may use the offline `create-enrollment` command in the [deployment guide](deployment.md), but Hub must be stopped first so that two processes never write its state volume concurrently. Enrollment is complete only after Hub records the node public key and Service Token identity and the one-time code disappears from the owner-only Node Agent configuration.

Verify the node, runtime, DSH version, Connector version, and advertised capabilities in the fleet view. Test a read operation before enabling plugin, file, snapshot, or terminal workflows.

## Revoke a node

Revoke the node in Hub and delete or disable its Cloudflare Access Service Token. Hub fences the active connection and refuses later generations. Stop the Node Agent and remove its private state only after deciding that the identity and queued results are not needed for investigation.

Revocation does not delete sessions or workspace data from the node. It also does not delete Hub audit history. Re-enrolling the same machine creates a new node identity unless the preserved owner-only state is deliberately reused with a matching Hub record.

## Back up Hub

The production image creates an online SQLite backup without stopping Hub. The destination must be a new directory on the mounted backup volume.

```sh
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker compose run --rm hub node /app/hub-server.mjs backup \
  --destination "/backup/${STAMP}"
docker compose run --rm hub node /app/hub-server.mjs verify-backup \
  --source "/backup/${STAMP}"
```

Copy the verified directory to a separate failure domain, encrypt it, and retain multiple generations. A valid backup contains `hub.db` and `manifest.json`; verification checks the database hash and audit chain. Record the container image digest and release version beside the backup. The manifest is an integrity record, not an external signature, so protect it with the backup. Plugin rollback transactions and snapshots live in each node's Node Agent state and require separate backup.

## Restore Hub

Stop Hub, preserve the damaged volume, create a fresh state volume, and restore `hub.db` with ownership `10001:10001` and no group or world access. Start the exact image digest recorded with the backup before considering an application upgrade.

Run `verify-backup` before copying the files into the fresh volume. Use an isolated reverse-proxy route for the first start; Hub verifies the audit chain before listening. Verify node records are present and no restored instance can race the production Hub for the same nodes. Promote the route only after the original Hub is permanently stopped.

## Upgrade Hub

Create and export a fresh backup, read the release notes, pin the new immutable image digest, pull it, and recreate the container. Verify health, human login, node reconnection, session baseline loading, a read command, SSE refresh, and one terminal open and close.

Hub performs only known sequential database migrations at startup. Schema v1 to v2 preserves every session-index row and adds a nullable project working-directory field. Schema v2 to v3 removes the never-adopted Hub object-cache tables; node files, plugin artifacts, and snapshots remain on nodes. An older image cannot open the migrated database. To roll back an image, stop Hub and restore the complete pre-upgrade backup created and verified with that older image; never allow the old image to write the migrated volume directly.

Hub protocol negotiation is exact. Upgrade nodes when the new Hub no longer accepts their protocol or capability versions. A Hub release must not silently reinterpret an older capability descriptor. To support a node-by-node rollout, Hub 1.0 accepts both `dsh.plugins` 2.0 and 3.0 at negotiation time. Version 2.0 retains only the original update-available response; version 3.0 distinguishes registry sources, external sources, and per-plugin lookup failures. Hub advertises only the current 3.0 contract to new connections and never relabels a 2.0 response as 3.0.

The recommended order is: back up and upgrade Hub, upgrade Node Agent one machine at a time, then upgrade Connector and restart the corresponding DSH Profile during a maintenance window that will not interrupt important work. An older Node Agent remains usable through the legacy plugin contract during the compatibility window; the richer source and error states become available when the new Node Agent reconnects, without restarting Connector. A later major release may remove the legacy contract only after the fleet contains no old Agent.

## Upgrade a node

Linux and macOS nodes enrolled by the one-command installer can be upgraded in place without a new enrollment grant or another Cloudflare credential prompt:

```sh
curl -fsSL https://github.com/k1412/dsh-hub/releases/latest/download/install-node.sh \
  | bash -s -- --upgrade --profile web
```

On Windows, run `install-node.ps1 -Upgrade` from the same Release. The upgrader verifies the Release, retains Connector under the persistent `~/.dsh-hub/packages` directory, atomically replaces any expired temporary `file:` reference in the profile, reinstalls and restarts the Node Agent service. Restart the corresponding DSH profile during a safe maintenance window, then verify both Node Agent and Connector versions under **Settings → Hub nodes**. Supply `--state-directory` and `--profile` for non-default locations and profiles, or their PowerShell/environment equivalents.

For manually managed nodes, upgrade the Node Agent package and restart its service first. Retain the Connector Release artifact in a persistent directory and run `dsh plugin --profile <name> add <persistent-release-asset> --save-exact`; never leave a profile pointing at an installer temporary-directory tgz. Connector upgrades may be deferred for a Runtime executing a long-running task. Do not interrupt a session merely to make versions uniform; finish that Runtime after the task completes.

Local clients continue working while the Node Agent is offline. During a Connector restart the matching runtime is offline in Hub, and queued operations remain governed by their idempotency class.

## Manage plugins

Choose a runtime under **Settings → Node plugins** to see actual plugin versions, enabled state, and health. After **Check for updates**, select an exact target version. Node Agent automatically preserves the current dependency and Cordis files before updating, restricts downloads to the public npm registry, and records the artifact SHA-256. Update a canary node first and confirm plugin and DSH runtime health before continuing to another node or wave.

Node Agent restores automatically when an update fails. After a successful update, **Update and rollback history** shows **Roll back to before update**. Rollback restores the recorded dependency and Cordis files and runs the DSH profile package-manager installation with the frozen lock. If a later update has changed the current lock, rollback stops rather than overwrite newer state.

## Manage snapshots

Use configuration snapshots for Cordis composition, dependency snapshots for package manifests and locks, data snapshots for explicitly configured directories, and fleet snapshots for combined filtered profile state. Every create request carries a stable mutation ID, making reconnection safe.

Restore checks the snapshot artifact hash and configured roots. Supply an expected current hash when the caller must reject concurrent changes. Snapshot restore preflights every target, stages replacements, and rolls back committed replacements after a later failure. It writes only included files and does not delete unrelated files from a root.

## Investigate delivery failures

Check Cloudflare Access policy and Service Token status, public DNS and TLS, the private proxy-to-origin path, proxy WebSocket forwarding, Node Agent logs, and Hub audit records in that order. Never print Service Token secrets, enrollment codes, private keys, or Connector secrets while collecting diagnostics.

During enrollment, an HTTP or HTML response from Access is not a Hub JSON response. Current installers report this as a non-JSON page before Hub and name the Client ID/Secret, Service Auth policy, and `/hub/v1/bootstrap` checks without echoing the response body. Paste only the Client ID value, never the `CF-Access-Client-Id:` label. A successful bootstrap must return JSON whose `serviceIdentity` exactly equals that Client ID before the Node Agent writes its pinned Hub identity.

**Settings → Hub nodes** displays reliable-queue health in both directions every 15 seconds. Node-to-Hub values come from the Node Agent report; Hub-to-node values come directly from Hub's journal. On a healthy connection both record counts return close to zero and the oldest-record time disappears. `warning` means total usage has reached 75%, queued reconstructible stream frames have reached 500 records or 4 MiB, or frames were suppressed; `critical` means total usage has reached 95% or control records have entered the emergency in-memory queue. Agent service logs include both record and byte usage. An offline node may lack a fresh node-side report, while its Hub queue, last heartbeat, and cached session index remain visible.

When a queue is full, keep the Node Agent service running and restore the Hub WSS path first. Node Agent pages through the existing journal before publishing runtime baselines and reserves capacity for control records. Question and approval requests use that control reserve and are not intentionally suppressed. Do not delete the node database, private key, or Connector secret, and do not re-enroll merely to bypass sequence state. If the page reports an interrupted stream, Connector replaces its event subscriptions without restarting DSH; pending interactions replay into the composer, while transient streams such as terminals must be reopened. Indexed sessions remain visible by working directory with an offline label meanwhile.

Confirm recovery with all four signals: the Node Agent process is not restart-looping, both queue record counts continue to fall, the runtime returns online, and an existing session remains usable from local Web or desktop and Hub. Pressure recovery writes a `transport.pressure` audit record, while the cumulative suppressed-frame count remains available for diagnosis.

A sequence gap requests a runtime resynchronization. An `outcome-unknown` command requires inspection of node-authoritative state before another mutation. Do not convert it to success or retry solely from the Hub command record.
