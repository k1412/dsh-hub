# Experiment: node management and native delegation

This branch adds `/control/<nodeId>` and `/control/grants` to the independent SSR
Gateway. One operator retains full authority; node-to-node access defaults to deny.
The Hub has no models or model credentials and does not persist prompts, results or
session history. Older nodes remain compatible with native UI protocol version 1.

## User workflow

Complete the node configuration below and bring A and B online. Configure B's delegation workspace and local model first.

1. **Manage a node:** From node details, open experimental management. Check versions in the plugin table, enter an exact target version to install or update, or enable, disable and remove eligible plugins. A `restart-required` job means installation reached disk but active code is unverified. Once tasks have finished, choose “Controlled restart DSH”. Full DSH updates, start, stop and restart require the [independent supervisor](#optional-resident-supervisor). They are unavailable without it and refuse active work.
2. **Grant A→B:** Open node grants and select source A and target B. The form automatically binds their paired Runtime identities; check those identities in node details before submitting. Enter B's configured absolute workspace, select discovery, task start, read and cancel, and choose an expiry in hours or days. B→A needs a separate grant. Read permission does not grant access to another session's tasks.
3. **Delegate in A's native session:** For example: “Discover my authorized nodes. On node B, inspect the project's test configuration in its allowed workspace. Give me the task ID, then check progress and summarize the result. Do not change files.” The model uses the registered `peer_discover`, `peer_task_start`, `peer_task_read` and `peer_task_cancel` tools; no handwritten RPC is needed. Tools derive source identity from the current native session; the model cannot choose a source session. “Do not change files” is a task instruction. The workspace only constrains the starting cwd; it is **not a sandbox**.
4. **Read, cancel and revoke:** B uses its own model and credentials to create a separate native subagent session. Local task metadata records the source node, Runtime, session and target workspace. Keep the returned task ID and ask in the same A session: “Check that task's progress and result” or “Cancel that task”. An operator can immediately revoke A→B on the grants page. Further access is refused and related tasks receive cancellation requests. Loss of Hub or the source connection also leads to cooperative cancellation when the local lease expires within 30 seconds; uncooperative tools may delay exit. Remote results are untrusted data and convey no additional authority.

## Install and run

Follow the [Gateway guide](gateway-design.md) to build and pair nodes.
`pnpm run gateway:build` produces `dist/gateway/server.mjs` and
`dist/gateway/downloads/gateway-node.tgz`. Upgrade the existing node plugin and
configure its existing Cordis entry:

```yaml
control: true
delegationWorkspace: /srv/delegated
trustedPackages:
  - example-dsh-plugin
```

Create the workspace first. Omit delegationWorkspace for management only. Reload
the existing Runtime; never start a second Runtime or expose the local Web listener.
Delegation requires tools, agents, agentDefaultModel, sessions and sessionController;
management requires pluginManager. The compatibility target is DSH 0.1.7-rc.2.

Open experimental management from node details. Inventory contains selected safe
fields. Installations require exact versions and names in the node's trustedPackages;
URL, path and git specs are rejected. Use the plugin table and “Check version” / “Install / update” buttons. The page shows
installed versions, human-readable status and action buttons; protocol details remain
collapsed. Grant expiry is selected in hours or days. The connection plugin and critical management services are
protected. Changes use official pluginManager and the same profile persistence as
the native CLI, retaining original YAML.

## Jobs and updates

One management mutation runs per node; separate nodes can run concurrently. Request
IDs are durable idempotency keys; changing parameters under an existing ID fails.
After disconnect, query inventory before retrying. The local journal stores bounded
summaries. Unfinished jobs become interrupted-review-required after restart and are
never replayed automatically. Official cancelInstall restores installation files;
other changes or installations already applying can be too late to cancel. Official
failed/cancelled installs restore package.json and lockfile. Arbitrary removal does
not promise rollback. Raw diagnostics remain local.

All DSH lifecycle operations, including version checks and updates, require an online
independent supervisor advertising lifecycle capability. They never fall back to the Runtime.
This includes npm and Docker installations.
The [deployment adapter](../../deploy/gateway/update-adapter.mjs) runs on the node or
deployment host. Set DSH_UPDATE_CONFIG in the independent supervisor environment to an administrator-owned
JSON configuration:

- stateDirectory and approvedVersions specify local journal storage and approved versions.
- npm mode: kind=npm, absolute releases/current paths; current must already be a
  release symlink. npm, restart and verify are argv arrays starting with absolute
  executables. The supervisor starts DSH through current. The adapter stages an
  installation, verifies its version, switches the symlink, restarts and verifies.
  Failure restores the old symlink; old releases remain. verify receives the version.
- Docker mode: kind=docker, prepare/apply/verify/rollback are fixed deployment-owned
  argv arrays. prepare/apply/rollback receive version and job ID. The deployment must
  implement pinned image sources, volume retention, single-container replacement and
  readiness checks. The adapter never pretends in-container npm updates are persistent.

Run the supervisor in a separate service/cgroup from DSH, so restarting DSH cannot kill
the updater responsible for verification and rollback. A supervisor crash retains locks;
inspect the deployment journal, subprocesses and actual version locally. Never mount Docker sockets into the Hub.
Only the local administrator should own the executor and its configuration.

## Grants and tools

Create an A→B grant with both Runtime identities, target workspace, capabilities and
expiry. Capabilities are discover, task.start, task.read and task.cancel; reverse access
requires a separate grant. Official tools register in A's native session and obtain
source session identity from execution context. B creates a separate native session
using its own model selection and credentials. Tasks bind source node, Runtime,
session and target workspace. Cross-session reads, conflicting replays and recursive
delegation fail. Remote tool output is marked untrusted; embedded instructions should
not be followed. Workspace admission is **not a filesystem sandbox**. B executes with
its local session permissions, so operators must authorize the target execution environment.

Grants are checked at dispatch and before returning results. The Hub renews a separate
local B lease every 10 seconds only while the original source and target connections,
Runtime identities, generations and grant remain valid. B uses a monotonic timer with
a maximum 30-second lease. Hub loss/restart, source loss or revocation stops renewal;
B requests cooperative cancellation and exposes the reason. Long grant expiry never
replaces this lease. Reconnection does not resend prompts or adopt old tasks through
idempotency replay. A blocked event loop or noncooperative native tool can delay actual
termination; such tasks keep their active slot and report cancelRequested until idle.

## Protocol and limits

Control RPC shares the existing authenticated outbound Tailscale or Tailcat WebSocket.
Both sides negotiate x-dsh-control=2; otherwise no control frames are sent. Node,
Runtime and connection generation are bound to the authenticated connection. Frames
are limited to 64KiB, with 16 pending calls and eight executing requests per side.
Calls time out after 30 seconds and writes are never automatically retried. Native
streams retain their window and channel limits. Each connection uses a random nonce and monotonically increasing sequence; the receiver
keeps one high-water mark, rejecting old requests without a growing replay cache.
There is no 10000-request lifetime limit. Delegation permits four active and
256 retained tasks, 16384 prompt characters and 32768 result characters. Terminal task
metadata expires after seven days on admission. The administrator cleanup button
(task.cleanup) can remove terminal records older than 24 hours. Active tasks and records
within that minimum idempotency window are never removed; new admission is rejected
while all 256 records remain protected. Native session history remains governed by DSH.

## Verification

```sh
pnpm run gateway:test
pnpm run check
pnpm run build
DSH_NATIVE_ROOT=/path/to/installed-dsh pnpm exec tsx packages/hub/gateway-node/tests/delegation-native-smoke.mts
```

Tests cover two simultaneous native/control carriers, direction/Runtime/generation/
revocation checks and isolated recoverable management journals. Native tests use installed
DSH with a fixture LLM to avoid model fees. Loopback latency does not establish Internet
Tailscale/Tailcat latency. Real Tailcat helpers are also exercised on one test host. These tests do not establish
cross-region performance or production deployment readiness.

### Native verification performed on this branch

- Two real rc.2 Runtimes: A's fixture model issues five official tools to discover B,
  start/read a real task and start/cancel another. Tests cover cross-session denial,
  cancellation during revocation and reconnect without duplicate execution. Both
  authenticated loopback WebSocket and real Tailcat 0.7.0 node helpers were exercised.
  Endpoints share one test host; cross-region latency and Tailscale control traffic
  have not been validated for this branch.
- Two actual pluginManager services with a local fixture registry: parallel distinct
  versions, enable/disable, update, restoration after a non-bundle update fails,
  disk-only rollback, refusal of further mutation pending restart, and preserved original YAML comments.
- Complete official browser smoke passed. Open in App still requires an upstream
  listener-only endpoint and remains unavailable remotely.
- 12000 rounds, 24000 control calls plus concurrent native fetches: with a separate
  10026-call replay regression. See the release report for current timing and results. This bounded load test
  does not establish hours of stability. Measurements depend on machine and load.

```sh
DSH_NATIVE_ROOT=/path/to/installed-dsh pnpm exec tsx packages/hub/gateway-node/tests/control-native-two-runtime.mts
# Optionally set GATEWAY_CONTROL_TAILCAT_BIN_DIR to verified tailcat binaries
DSH_NATIVE_ROOT=/path/to/installed-dsh DSH_TEST_PNPM=/path/to/pnpm.cjs pnpm exec tsx packages/hub/gateway-node/tests/management-native-smoke.mts
CONTROL_SOAK_ROUNDS=12000 CONTROL_BENCHMARK_REPORT=/tmp/control-benchmark.json pnpm exec vitest run packages/hub/gateway-transport/tests/control.spec.ts
```

### Explicit limits

Initial DSH installation, start/stop/restart and uninstall use the optional resident node
supervisor. Without it, inventory reports external-supervisor-required. This separate
outbound connection has no Runtime or Web listener and cannot delegate tasks. Both
connections bind authenticated node/Runtime identity. Stopping DSH leaves the supervisor
available. Administrators may explicitly set installation:
npm; detected Docker takes precedence and unknown installations remain external.
For DSH version checks select dsh.update: the npm executor checks an exact version
against the fixed official registry; Docker configuration must supply a check command.
`/control/audit` retains at most 10000 action/node/request-ID/time summaries. The control
handshake advertises management/delegation capabilities; nodes without a delegation
workspace do not advertise delegation. The target also cancels at authorization expiry,
without requiring the Hub to remain online.


## Optional resident supervisor

Use the same packaged CLI without another Runtime:

```sh
node package/lib/cli.js pair-supervisor --manifest enrollment.json --state-directory /srv/gateway-state --bin-directory /srv/gateway-bin --runtime-id default
DSH_UPDATE_CONFIG=/srv/gateway-state/update.json node package/lib/cli.js supervise --connection-file /srv/gateway-state/connection.json --runtime-id default --update-executor /usr/local/bin/dsh-update
```

enrollment.json is the manifest from the existing invitation endpoint; pairing uses only
its selected overlay. Existing nodes can reuse connection.json and skip pair-supervisor.
A fresh machine can pair its supervisor before dsh.install. Initialize the installed
profile and Gateway plugin through the official CLI, then load them in the same Runtime.
The Runtime ID must match the later plugin configuration.

Executor configuration must explicitly list approvedActions (install/start/stop/restart/uninstall).
Install/update target an exact version; start/stop/restart/uninstall require target=current. npm
install refuses an existing current path; update replaces the existing symlink. Docker
install uses fixed prepare/install/verify commands. Other actions use fixed same-named
commands. Start/stop/restart must operate the **existing single supervised service**, with an
idempotent start command, never launch a separate dsh process. The Hub also rejects
install/start while the Runtime is online.

The packaged [systemd adapter](../../deploy/gateway/systemd-service-adapter.mjs) supports
Linux user services. Set DSH_SERVICE_UNIT to the existing DSH unit and DSH_CURRENT_RELEASE
to the absolute current path. Configure command arrays with the adapter's absolute path
and operation, for example `["/usr/local/bin/dsh-service-adapter", "start"]`. It controls
one unit through systemctl. Uninstall stops that unit and archives the current symlink,
preserving profiles and old releases. The existing DSH unit must launch through current.
Adjust the [supervisor user-unit template](../../deploy/gateway/dsh-gateway-supervisor.service)
for local paths and these environment variables. Do not couple its lifetime to the DSH unit.

Plugin and lifecycle operations share a local exclusive lock. Crashes retain the lock to
prevent uncertain retries. An administrator can request management.recover through the
supervisor only for operations that cannot leave an executor behind and after the recorded owner PID
has exited. Plugin installation and lifecycle locks require local subprocess/journal
reconciliation even when that PID has exited. Corrupt locks and PID reuse also require
local inspection. The deployment adapter also retains its own journal
and lock; inspect interrupted updates and current locally before recovering them.

## Durable management and executor contract

The node fsyncs its operation reservation before any mutation. Disk version, upstream
application result and active code are distinct fields; package installation success
does not prove that HMR applied the package. Journal write failures
lock mutations and show persistence-failed; background failures do not reject into the
Runtime. “Retry journal write” retries persistence without replaying the operation.
An unreadable journal requires local repair and reload. Completion is exposed only
after its durable write; restart-required means installed but not yet active.
Exact plugin checks consult official inspect metadata or the configured registry when
already installed. Successful installation must match the actual installed manifest;
a malformed bundle recovery verifies the disk version only and keeps the restart fence.
An HMR application error after successful installation does not trigger another nested
HMR rollback. Active code remains explicitly unverified.

The supplied executor emits one JSON result on stdout: check reports availableVersion;
install/apply reports installedVersion. Both must equal the requested exact version.
Docker check and verify commands must emit `{ "version": "0.1.7-rc.2" }` for the
available image and actual running installation respectively. Exit zero alone is not
version verification. Docker first-install failure runs a configured cleanup argv array;
without it the status is manual-recovery-required and locks remain. It never reports
rolled-back without invoking rollback. The deployment owner must make cleanup and
rollback verify their resulting deployment state.

Management executor timeout leaves the executor running and the node locked for local
reconciliation, including after process restart. Adapter command timeout may leave
children alive, so the adapter retains its own lock and does not race rollback against
them. Stop/reconcile all updater descendants, inspect both journals and the installed
version before locally removing stale locks; never use the Gateway PID alone as proof.
The default mutation timeout is five minutes; adapter commands default to four minutes.
This conservative recovery policy favors avoiding concurrent updates over automatic recovery.

## Controlled restart and activity admission

“Controlled restart DSH” invokes the independent supervisor's approved `restart` action
against the existing service. Add `restart` to approvedActions and configure its command
array (the systemd adapter already supports it). No implicit restart or cancellation is
performed after a plugin update. Stop/update/restart/uninstall all refuse an active
Runtime or native maintenance; this release offers no forced interruption button.
An offline or older Runtime without the admission capability cannot authorize these
operations. Start/install retain their separate idempotent service semantics.

The Runtime reserves the existing shared management.lock before checking public
agents.list(), Agent.status and bounded Agent.whenIdle(). The same lock protects Hub
`task.start` admission and plugin operations. The supervisor adopts that exact request's
prepared token and keeps the fence across execution. Public agent/pre-step rejects new
model steps during admitted maintenance. This prevents Hub-owned admission races; it
is **not a whole-Runtime freeze** and cannot serialize arbitrary local administrator CLI
or native plugin UI operations, which use their own upstream locks. No private agent
registry APIs or upstream core patches are used. The workspace remains a task cwd policy,
**not a sandbox**.

After start/install/update/restart the job remains awaiting-runtime-verification until
the same authenticated node/Runtime has a new connection generation, a fresh process
identity and the expected DSH version. The fence then releases. A connection reconnect
inside the old process is insufficient. Pending durable jobs can be verified after Hub
reconnection. Executor uncertainty still requires local reconciliation.

Plugin `changed:true`, exitCode 0, or `application:restart-required` never proves active
code changed. Failed HMR with the target on disk shows restart-required and retains the
fence. Recovery of a malformed bundle may restore the prior disk version through the
official installer, but reports disk-restored-active-unverified and still requires an
explicit restart. A fresh Runtime handshake proves that Runtime restarted; it does not
invent a generic active plugin version field absent from rc.2. Plugin-specific live
service evidence is required to verify active code. Inventory/SSR shows unknown otherwise.

The native Remote/HMR regression installs an actual fixture through Connection Fetch +
Typert Remote inside the public hmr.runExclusive scope. It observes disk 1.0.1 / active
1.0.0 after the actual nested-HMR failure, then disposes the old Runtime and starts the
same profile in a fresh process to prove active 1.0.1. The explicit outer HMR scope is
necessary for this bounded reproduction; ordinary Remote alone did not reproduce the
production origin of that scope. Core module hashes remain unchanged.

```sh
DSH_NATIVE_ROOT=/path/to/installed-dsh pnpm exec tsx packages/hub/gateway-node/tests/lifecycle-native-smoke.mts
DSH_NATIVE_ROOT=/path/to/installed-dsh DSH_TEST_PNPM=/path/to/pnpm.cjs pnpm exec tsx packages/hub/gateway-node/tests/management-remote-native-smoke.mts
```

The activity test holds real native and delegated model streams plus native maintenance,
checks refusal without cancellation, and exercises shared admission against a harmless
local supervisor executor. It does not stop a production service. Model sourceSession
comes only from the official tool execution Agent; model arguments cannot override it.
Read/cancel ownership includes source node, Runtime, session and target Runtime/workspace.
Management methods remain operator-only and are rejected by peer dispatch.
