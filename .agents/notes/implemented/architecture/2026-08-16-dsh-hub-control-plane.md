# Agent Note: DSH Hub control plane and outbound node connector

Status: implemented

English | [中文](2026-08-16-dsh-hub-control-plane.zh.md)

## Problem

One operator can run DSH on several computers and use local Web and desktop surfaces on those machines. Each surface originally reaches only its local runtime, so it cannot list every node, resume work remotely, or administer exact plugin and snapshot state from one authenticated page. Publishing every local Web listener would multiply Internet-facing origins and make the Web API the ceiling of remote control. Running DSH inside the central service would create a second execution model, while mirroring complete node data would create a second source of truth and an unbounded cache.

The control plane must preserve each node as the authority for its DSH runtime and data, coexist with every local client, provide the enrolled Hub with the full authority of the DSH context and Node Agent operating-system account, and require no inbound node listener.

## Decision

DSH Hub is a single-user control plane, not a DSH runtime. It authenticates the operator, enrolls nodes, routes versioned capability commands, indexes enough metadata to present the fleet, presents exact plugin and snapshot operations, and records an append-only hash-chained audit log. It never creates a DSH `Context`, runs a model or tool, or loads a node's DSH plugins. A machine that also hosts Hub joins the fleet through the same node path as every other machine.

Each controlled machine installs two cooperating components. Hub Connector is a Cordis plugin loaded into an existing DSH composition that provides the transport-independent Host `ApiProxy` and Typert Gateway services; it uses them to expose the standard DSH HTTP and event protocols plus Hub capabilities. Node Agent is a separate process under the DSH-owning operating-system account; it owns node identity, durable WSS delivery, local IPC, plugin artifact activation, snapshots, size-bounded file operations, and PTY streams represented by audited commands.

The Connector does not depend on the optional Web plugin or proxy a node-local Web listener. The standard Web profile already provides the Host services; other compositions provide them explicitly. When local Web, a desktop client, and Hub Connector are loaded against the same runtime, all three act on the same live session owner. Resource identity is `{nodeId, runtimeId, resourceId}`. Local presentation state remains local, while session messages, queue state, cancellations, approvals, and questions are authoritative in DSH and become visible through each surface's normal projection.

## Authority and isolation

Hub is the only application-level command authority accepted by an enrolled Node Agent. A correctly authenticated and signed command receives no additional node-side approval. Connector operations inherit all authority of the DSH context; supervisor, filesystem, process, and PTY operations inherit all authority of the operating-system account running Node Agent. Installation does not silently elevate that account, and deliberately running it as a privileged account remains an explicit deployment decision.

Nodes establish one outbound WSS connection. Node Agent and Connector communicate over framed, size-bounded, HMAC-authenticated local IPC with owner-only secrets. Neither component opens an Internet-reachable listener. Human traffic and machine traffic may share an edge hostname, but human requests require a verified Cloudflare Access JWT and same-origin mutation checks, while machine requests require a per-node Cloudflare Service Token plus Ed25519 proof bound to the enrolled node identity.

The Hub server validates the Access JWT issuer, audience, signature, type, time bounds, and exact operator identity against current JWKS. It also requires a high-entropy origin secret at the private reverse-proxy boundary. Access-layer authentication is therefore necessary but not sufficient by itself, and reaching an origin address or port does not bypass application authentication.

## Protocol and recovery

Hub and Node Agent exchange signed envelopes containing the protocol version, node and optional runtime identity, boot identity, connection generation, message identity, directional sequence, cumulative acknowledgement, time bounds, payload hash, and payload. Authentication assigns a new connection generation and negotiates exact capability descriptors containing semantic version and schema hash.

Both peers journal durable commands and results before acknowledging them. Reconnection exchanges acknowledgement positions, rejects stale generations and duplicate message identities, replays unacknowledged durable records, and then reconciles runtime instances, capabilities, incomplete commands, and stream baselines. Mutations require an idempotency key or an explicit reconciliation procedure. A crash after an unconfirmed side effect produces `outcome-unknown`; it does not trigger blind re-execution. Hub removes completed command bodies after explicit browser acknowledgement and periodically applies a bounded cleanup window to abandoned terminal records.

The Hub control contract is owned under `/hub/v1`. JSON REST carries bounded requests and mutations, a resumable SSE channel carries reconstructible control events, and a dedicated same-origin WebSocket relays interactive PTY frames. The Hub Web build uses the official DSH client roster directly. Hub fans out identity-free session, search, and workspace reads across every online `dsh.web` Runtime, rewrites node-local resource ids into opaque browser ids containing `{nodeId, runtimeId, sourceId}`, and routes later HTTP and event operations back to the owning Runtime. It combines each Runtime's complete workspace-order and archive snapshot before publishing it so one node cannot replace fleet-wide state. An operation without a resource identity uses the operator's selected Runtime when it needs one owner. The upstream Web API remains a browser-to-runtime interface rather than the Hub-to-node protocol.

Official client packages continue to own conversation, workspace, project grouping, directory selection, streaming, scrolling, errors, and mobile behavior. The conversation shell declares an optional root-scoped `conversation.hero.runtime` seat before its Workspace picker. Hub occupies it with a reviewed selector for online `dsh.web.fetch` Runtimes: the last usable target is preselected, a target change clears the old blank-session selection, and an existing opaque fleet Workspace synchronizes the selector to its owner. Settings still provides enrollment, fleet state, an ownerless-operation fallback, plugin health, update history, rollback, explicit snapshots, and acknowledged rescue diagnostics. Runtime selection does not filter the fleet page, replace the official interaction model, or load JavaScript supplied by a node.

## Storage and fleet operations

The reference deployment uses SQLite in WAL mode. It stores node identity, runtime and capability metadata, a minimal session index containing title and working directory, command delivery state, and audit entries. Schema v2 adds a nullable `workspace_path` column to an existing v1 session index in place; schema v3 removes the never-adopted object-cache tables. Both migrations retain control records. Node Agent stores downloaded plugin artifacts, rollback transactions, and snapshots in owner-only local state. Hub does not transparently cache conversation bodies, workspace content, terminal output, credentials, artifacts, snapshots, or general node files.

Node Agent installs only an exact semantic plugin version from the bounded public npm artifact route and records the downloaded SHA-256. Before mutation it preserves dependency, lock, Cordis, and managed-plugin state as a visible rollback transaction. It invokes DSH profile management without a shell, validates profile composition through `--dump-config`, verifies the installed package manifest and inventory, and automatically restores the recorded files plus a frozen install when application fails. Successful updates expose their source and target versions with one-click rollback; stale locks prevent an older transaction from overwriting later state. Snapshot manifests independently describe an explicit configuration, dependency, data, or fleet scope; secret-like files and symbolic links are excluded, every archive is hashed, roots must still match at restore time, and symlinked parents cannot redirect writes outside a configured root.

Hub Web UI is a reviewed, static build of official DSH client packages plus the Hub client plugin. Its startup script selects Zod's non-JIT parser before the official entry executes, and Loader defers compiling its expression evaluator until a composition actually evaluates an expression node. The static Hub roster contains no expression nodes, and its Content Security Policy disallows dynamic evaluation and inline scripts while permitting the inline attributes and `<style>` elements generated by the reviewed official client bundles. A node can advertise new typed capabilities, but connecting it never causes JavaScript supplied by that node to execute in the operator's browser. A new rich capability interface ships as reviewed Hub code.

## Verification

Protocol tests cover signatures, tampering, expiry, negotiation, sequencing, deduplication, stale generations, durable replay, and recovery. Storage tests cover ownership, atomic rotation of unconsumed enrollment grants, rejection of enrolled-node reuse, schema migration, command lifecycle and redaction, SQLite backup, and audit-chain verification. Server integration tests cover Access validation, origin checks, enrollment, signed Agent WSS exchange, command routing, connection revocation, official HTTP and event forwarding, terminal relay, and audit retrieval.

Connector composition tests exercise one shared Host API and event gateway through local Web, desktop, and Hub callers and verify that all three callers use the same session owner. Node tests cover authenticated local IPC, durable state, plugin inventory and transactions, snapshot exclusions and restore containment, optimistic file operations, and real PTY output. Hub client tests exercise direct new-session Runtime selection, last-choice persistence, opaque Workspace-owner synchronization, registration, cancellation, revocation, plugin update and rollback, explicit snapshot recovery, and advanced-diagnostic safeguards. Release checks install the packed Connector and Node Agent artifacts, and container checks build the Hub server and static UI for Linux AMD64. Deployment acceptance additionally exercises the existing local Web and desktop clients against the same real DSH runtime before and after Hub and Connector outages.

The Hub build test pins the complete official client roster plus the Hub Settings contribution. A built-page Chromium check serves that roster with the production Content Security Policy and requires the Hub Settings bundle and application root to load without policy or page errors. The official GUI component inventory and keyless Chromium replay remain required, so session creation, project grouping, working-directory selection, streaming, scrolling, error recovery, and mobile behavior cannot regress behind a Hub-specific replacement. Fleet-routing tests cover multi-Runtime list and search aggregation, opaque identity round trips, owner-directed history and chat, combined workspace-order and archive snapshots, malformed and cross-Runtime identity rejection, and multiplexed official events. Storage and server tests cover row-preserving schema migration, Connector baselines, WSS projection, and REST output.

## Alternatives considered

**Publish or reverse-proxy each node's local Web listener.** This multiplies public origins, couples the control plane to a browser transport, and prevents Hub from exposing a capability missing from the local Web API.

**Build an independent Hub conversation UI.** This duplicates fast-moving official behavior and already produced regressions in session creation, project grouping, streaming, scrolling, and error presentation. Building the official roster keeps those interactions upstream-owned while Hub adds only fleet controls.

**Run one complete DSH instance inside Hub.** This makes the control plane an execution host with a privileged special mode and does not solve access to sessions whose authoritative runtimes remain on other nodes.

**Run a second headless DSH process beside the local UI.** Two runtime owners can diverge in memory even when they share a profile directory. Loading Connector into the existing composition preserves a single owner and makes local and remote clients cooperate.

**Mirror all node content into a central database or object store.** This introduces an unnecessary second source of truth, expands the credential and privacy boundary, and requires arbitrary cache retention and invalidation policies.

**Execute node-supplied browser modules.** This transfers a node compromise into the operator's authenticated control-plane origin. Typed capability descriptions plus reviewed first-party surfaces preserve extensibility without remote code execution in the browser.

**Permit `unsafe-eval` in the Hub Content Security Policy.** This makes the official Loader and schema validators start without adaptation, but it also permits any same-origin script to compile strings and weakens the guarantee against node-supplied browser modules. The Hub instead uses the supported non-JIT Zod path and keeps Loader's expression compiler dormant for its expression-free static roster.

**Require interactive approval on every node.** This contradicts the single-user product's full-authority contract and prevents unattended fleet administration. The deliberate boundary is enrollment plus the Node Agent account's operating-system permissions.

**Present terminal, files, plugin rollback, and snapshots as equivalent node tools.** Their effect and recovery semantics differ. The console keeps plugin health and automatic rollback visible, separates whole-profile snapshots, and hides terminal and file rescue behind an acknowledged advanced disclosure.

## Consequences

The design provides one remote view while keeping execution and authoritative data on nodes. Local Web, desktop, and Hub can continue the same live session without database copying or a second DSH process. Outbound-only nodes need no inbound firewall exposure, and durable signed delivery makes disconnections recoverable.

The Hub and Node Agent remain security-sensitive because enrollment grants broad authority. Operators must protect the Hub origin, Node Agent account, identity files, service tokens, backups, and artifact approval process. Offline nodes expose only indexed metadata until they reconnect, and every capability or rich UI feature requires an explicitly versioned adapter and reviewed Hub surface. Hub browsers use Zod's interpreted validation path instead of its generated fast path, accepting lower parsing throughput to keep dynamic evaluation disabled. Hub backups and Node Agent state backups are separate: plugin rollback and snapshots survive only while their node-local material is retained. Adopting a new official Web roster requires rerunning the assembled Hub build and official browser regression inventory.
