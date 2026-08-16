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

The production image creates an online SQLite backup and copies immutable explicit objects without stopping the Hub. The destination must be a new directory on the mounted backup volume.

```sh
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker compose run --rm hub node /app/hub-server.mjs backup \
  --destination "/backup/${STAMP}"
docker compose run --rm hub node /app/hub-server.mjs verify-backup \
  --source "/backup/${STAMP}"
```

Copy the verified directory to a separate failure domain, encrypt it, and retain multiple generations. A valid backup contains `hub.db`, `objects/`, and `manifest.json`; verification checks every manifest file hash, every database-recorded object, and the audit chain. Record the container image digest and release version beside the backup. The manifest is an integrity record, not an external signature, so protect it with the backup.

## Restore Hub

Stop the Hub, preserve the damaged volume, create a fresh state volume, and restore `hub.db` plus `objects/` with ownership `10001:10001` and no group or world access. Start the exact image digest recorded with the backup before considering an application upgrade.

Run `verify-backup` before copying the files into the fresh volume. Use an isolated reverse-proxy route for the first start; Hub verifies the audit chain before listening. Verify node records are present and no restored instance can race the production Hub for the same nodes. Promote the route only after the original Hub is permanently stopped.

## Upgrade Hub

Create and export a fresh backup, read the release notes, pin the new immutable image digest, pull it, and recreate the container. Verify health, human login, node reconnection, session baseline loading, a read command, SSE refresh, and one terminal open and close.

Hub performs only known one-step database migrations at startup. The schema-v1-to-v2 migration retains every session-index row and adds a nullable project working-directory field, which nodes populate when they resend their baselines. A migrated database cannot be opened by an older image that understands only v1. To roll back the image, stop Hub and restore the complete pre-upgrade backup created and verified with that older image; never let the old image write the migrated volume directly.

Hub protocol negotiation is exact. Upgrade nodes when the new Hub no longer accepts their protocol or capability versions. A Hub release must not silently reinterpret an older capability descriptor.

## Upgrade a node

Upgrade the Node Agent package first, restart its service, and verify reconnection. Upgrade the Connector in each DSH profile through `dsh plugin --profile <name> add <release-asset> --save-exact`, then restart that DSH process and verify its runtime boot ID changes.

Local clients continue working while the Node Agent is offline. During a Connector restart the matching runtime is offline in Hub, and queued operations remain governed by their idempotency class.

## Manage plugins

Read inventory and capture the current lock hash. Approve an exact package version and SHA-256 tarball hash, then apply it to a canary node. Confirm inventory health and DSH runtime health before continuing to another node or wave.

If health fails, roll back to the retained target lock. Rollback restores the recorded dependency and Cordis files and runs the DSH profile package-manager installation with the frozen lock. A lock mismatch stops the operation unless inventory proves that the exact requested artifact is already present.

## Manage snapshots

Use configuration snapshots for Cordis composition, dependency snapshots for package manifests and locks, data snapshots for explicitly configured directories, and fleet snapshots for combined filtered profile state. Every create request carries a stable mutation ID, making reconnection safe.

Restore checks the snapshot artifact hash and configured roots. Supply an expected current hash when the caller must reject concurrent changes. Snapshot restore preflights every target, stages replacements, and rolls back committed replacements after a later failure. It writes only included files and does not delete unrelated files from a root.

## Investigate delivery failures

Check Cloudflare Access policy and Service Token status, public DNS and TLS, the private proxy-to-origin path, proxy WebSocket forwarding, Node Agent logs, and Hub audit records in that order. Never print Service Token secrets, enrollment codes, private keys, or Connector secrets while collecting diagnostics.

A sequence gap requests a runtime resynchronization. An `outcome-unknown` command requires inspection of node-authoritative state before another mutation. Do not convert it to success or retry solely from the Hub command record.
