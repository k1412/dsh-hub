# Experiment: node management and native delegation

This branch adds `/control/<nodeId>` and `/control/grants` to the independent SSR
Gateway. One operator retains full authority; node-to-node access defaults to deny.
The Hub has no models or model credentials and does not persist prompts, results or
session history. Older nodes remain compatible with native UI protocol version 1.

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
# updateExecutor: /usr/local/bin/dsh-update
```

Create the workspace first. Omit delegationWorkspace for management only. Reload
the existing Runtime; never start a second Runtime or expose the local Web listener.
Delegation requires tools, agents, agentDefaultModel, sessions and sessionController;
management requires pluginManager. The compatibility target is DSH 0.1.7-rc.2.

Open experimental management from node details. Inventory contains selected safe
fields. Installations require exact versions and names in the node's trustedPackages;
URL, path and git specs are rejected. Use `management.check` to inspect a version and
`management.submit / plugin.install` to install. Enable/disable uses entryId; removal
uses the package name. The connection plugin and critical management services are
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

DSH updates default to external-update-required, including Docker installations.
The [deployment adapter](../../deploy/gateway/update-adapter.mjs) runs on the node or
deployment host. Set DSH_UPDATE_CONFIG in the node environment to an administrator-owned
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

Supervisor restarts may terminate the caller, leaving its summary interrupted; inspect
the deployment journal and actual version. Never mount Docker sockets into the Hub.
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

Grants are checked at dispatch and before returning results. Revocation immediately
blocks subsequent reads and attempts cancellation of tracked running tasks. Offline
targets are retried after reconnect. Expiry is checked every 250ms. The Hub does not
persist its running-task tracking table; after Hub restart, the target's ten-minute
limit remains, but immediate cancellation of old tasks is not guaranteed.

## Protocol and limits

Control RPC shares the existing authenticated outbound Tailscale or Tailcat WebSocket.
Both sides negotiate x-dsh-control=1; otherwise no control frames are sent. Node,
Runtime and connection generation are bound to the authenticated connection. Frames
are limited to 64KiB, with 16 pending calls and eight executing requests per side.
Calls time out after 30 seconds and writes are never automatically retried. Native
streams retain their window and channel limits. A connection accepts at most 10000
control requests before reconnect is necessary. Delegation permits four active and
256 retained tasks, 16384 prompt characters and 32768 result characters; archive locally
when retention capacity is reached.

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
Tailscale/Tailcat latency. Real networks, soak testing and deployment updates require
further isolated verification; these tests do not establish production readiness.

### Native verification performed on this branch

- Two real rc.2 Runtimes: A's fixture model issues five official tools to discover B,
  start/read a real task and start/cancel another. Tests cover cross-session denial,
  cancellation during revocation and reconnect without duplicate execution. Both
  authenticated loopback WebSocket and real Tailcat 0.7.0 node helpers were exercised.
  Endpoints share one test host; cross-region latency and Tailscale control traffic
  have not been validated for this branch.
- Two actual pluginManager services with a local fixture registry: parallel distinct
  versions, enable/disable, update, restoration after a non-bundle update fails,
  removal isolated to A and preserved original YAML comments.
- Complete official browser smoke passed. Open in App still requires an upstream
  listener-only endpoint and remains unavailable remotely.
- 9000 rounds, 18000 control calls plus concurrent native fetches: approximately
  52 seconds, zero errors, no pending requests at completion. This bounded load test
  does not establish hours of stability. Measurements depend on machine and load.

```sh
DSH_NATIVE_ROOT=/path/to/installed-dsh pnpm exec tsx packages/hub/gateway-node/tests/control-native-two-runtime.mts
# Optionally set GATEWAY_CONTROL_TAILCAT_BIN_DIR to verified tailcat binaries
DSH_NATIVE_ROOT=/path/to/installed-dsh DSH_TEST_PNPM=/path/to/pnpm.cjs pnpm exec tsx packages/hub/gateway-node/tests/management-native-smoke.mts
CONTROL_SOAK_ROUNDS=9000 CONTROL_BENCHMARK_REPORT=/tmp/control-benchmark.json pnpm exec vitest run packages/hub/gateway-transport/tests/control.spec.ts
```

### Explicit limits

Initial DSH installation, start/stop and uninstall use the optional resident node
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

Executor configuration must explicitly list approvedActions (install/start/stop/uninstall).
Install/update target an exact version; start/stop/uninstall require target=current. npm
install refuses an existing current path; update replaces the existing symlink. Docker
install uses fixed prepare/install/verify commands. Other actions use fixed same-named
commands. Start/stop must operate the **existing single supervised service**, with an
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
supervisor only after the recorded owner PID has exited. Corrupt locks, live owners and
PID reuse require local inspection. The deployment adapter also retains its own journal
and lock; inspect interrupted updates and current locally before recovering them.
