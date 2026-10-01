# DSH version compatibility

The Hub Connector is an adapter to the DSH Host/Remote surface. DSH releases are not automatically wire-compatible: the upstream project has changed the Host API, Session persistence API, plugin loading model, and Web composition during the 0.1.x series.

## Current release line

Hub 1.0.4 was originally built and tested against the `0.1.0-rc.7` Host API family. The current Connector no longer packages the removed legacy Host ApiProxy/Session dependencies: it keeps the old in-process path for existing nodes and has a Typert Remote fallback for current Session and Settings endpoints.

The table distinguishes the published baseline from adapter coverage in the current source branch. Branch fixes do not automatically appear in published installers or images; check the actual source commit and artifacts you deploy.

These are covered versions, not a claim about the latest upstream release:

| DSH line | Upstream state | Hub status |
| --- | --- | --- |
| `0.1.0-rc.6` / `0.1.0-rc.7` | legacy Host API / ApiProxy surface | supported by Hub 1.0.4; Connector waits for ApiProxy dependencies to activate rather than entering the current Remote path prematurely |
| `0.1.5-rc.2` / `0.1.5-rc.3` | Remote gateway and Session API changes | Connector Remote fallback, event bridge, and `$events/result` answer path covered; target bridge also carries Hub selection into `/api/*`; bundled Web UI remains the rc.7 composition |
| `0.1.6-alpha.2` / `0.1.7-alpha.1` | covered alpha versions; plugin manager and Session changes | Connector Remote fallback, tool/Skill routing, questions/cancel, event bridge, and `$events/result` answer path covered; target bridge covers the changed HTTP/WebSocket carrier, while the bundled Web UI remains the rc.7 composition |
| `0.1.7-rc.2` | currently verified DSH runtime | The Connector bridges sessions and events, translates the bundled rc.7 Web UI's `host.listDirectory`, `host.createDirectory`, and `host.pickDirectory` calls to the current `directoryPicker` Remote, and wraps workspace mutations in the `request` argument required by the current `workspace` Remote. Hub still bundles the rc.7 Web UI composition, so new DSH Web features do not automatically appear in Hub. |

Do not install a newer DSH profile into a node running the 1.0.4 Connector and assume that the Web page is enough to prove compatibility. The Connector's current Remote path and the page-level target bridge are tested independently of the bundled rc.7 Web artifact; the latest DSH Web composition has renamed client packages and still needs a separate [bundle migration](https://github.com/k1412/dsh-hub/issues/40). The Node settings page must show the DSH version, Connector version, and negotiated capabilities. A node upgrade is complete only after a canary session passes the functional checks in [operations](operations.md).

## Upgrade policy

The pinned selector's `session.models` call is adapted to the current `session.modelCatalog` and `session.projections` reads. The adapter retains each Session's next model selection, falls back to that Runtime's deployment default for an unconfigured Session, and preserves provider groups, reasoning metadata, and isolated provider failures. Model selection continues through `session.selectModel`; the adapter wraps its named `request` argument. Existing legacy ApiProxy model services remain authoritative.

The pinned history UI's `session.history` call is adapted to the current `session.page` using the observed `session.projections.asOfSeq` as a valid log cut. Backward pagination and the tail page's projection baseline are preserved. Legacy ApiProxy history remains authoritative. Connector waits for its Runtime's dependencies and backs off after clean IPC closure as well as errors, preventing startup failures from flooding Runtime notifications.

Archive browsing, trash, restore, and permanent deletion are Hub extensions exposed by the negotiated `dsh.session-lifecycle` capability. Their JSONL storage and write-lock contract is verified against `0.1.7-rc.2`; older DSH families are not assumed to support deletion. Upgrade Hub, Node Agent, and Connector together to use the new contract. Nodes without it remain usable and display an upgrade notice in [session management](session-management.md).

Each Hub release records the exact DSH package family used to build and test the Connector. A future release may support more than one family, but each family must have its own adapter tests for session listing, history, answer submission, tool/skill execution, questions, cancellation, settings, and event streams. When an upstream release removes an imported package or changes a Remote method, the release is incompatible until those tests pass.

The version shown by a node is informational; capability negotiation remains authoritative. The Hub must reject a capability descriptor whose contract version or schema hash is not supported, even when the DSH version string looks newer.
