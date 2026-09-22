# DSH version compatibility

The Hub Connector is an adapter to the DSH Host/Remote surface. DSH releases are not automatically wire-compatible: the upstream project has changed the Host API, Session persistence API, plugin loading model, and Web composition during the 0.1.x series.

## Current release line

Hub 1.0.4 was originally built and tested against the `0.1.0-rc.7` Host API family. The current Connector no longer packages the removed legacy Host ApiProxy/Session dependencies: it keeps the old in-process path for existing nodes and has a Typert Remote fallback for current Session and Settings endpoints.

The table distinguishes the published baseline from adapter coverage in the current source branch. Branch fixes do not automatically appear in published installers or images; check the actual source commit and artifacts you deploy.

These are covered versions, not a claim about the latest upstream release:

| DSH line | Upstream state | Hub status |
| --- | --- | --- |
| `0.1.0-rc.7` | legacy Host API / ApiProxy surface | supported by Hub 1.0.4 |
| `0.1.5-rc.2` / `0.1.5-rc.3` | Remote gateway and Session API changes | Connector Remote fallback, event bridge, and `$events/result` answer path covered; target bridge also carries Hub selection into `/api/*`; bundled Web UI remains the rc.7 composition |
| `0.1.6-alpha.2` / `0.1.7-alpha.1` | covered alpha versions; plugin manager and Session changes | Connector Remote fallback, tool/Skill routing, questions/cancel, event bridge, and `$events/result` answer path covered; target bridge covers the changed HTTP/WebSocket carrier, while the bundled Web UI remains the rc.7 composition |

Do not install a newer DSH profile into a node running the 1.0.4 Connector and assume that the Web page is enough to prove compatibility. The Connector's current Remote path and the page-level target bridge are tested independently of the bundled rc.7 Web artifact; the latest DSH Web composition has renamed client packages and still needs a separate [bundle migration](https://github.com/k1412/dsh-hub/issues/40). The Node settings page must show the DSH version, Connector version, and negotiated capabilities. A node upgrade is complete only after a canary session passes the functional checks in [operations](operations.md).

## Upgrade policy

Each Hub release records the exact DSH package family used to build and test the Connector. A future release may support more than one family, but each family must have its own adapter tests for session listing, history, answer submission, tool/skill execution, questions, cancellation, settings, and event streams. When an upstream release removes an imported package or changes a Remote method, the release is incompatible until those tests pass.

The version shown by a node is informational; capability negotiation remains authoritative. The Hub must reject a capability descriptor whose contract version or schema hash is not supported, even when the DSH version string looks newer.
