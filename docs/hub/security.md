# DSH Hub security

English | [中文](security.zh.md)

This reference defines the security model for a single-operator Hub with fully trusted enrolled nodes.

## Authority model

The Hub operator has all DSH capabilities advertised by an enrolled runtime. A Node Agent also grants file, terminal, plugin, and snapshot authority equal to its operating-system account when profile management is enabled. Commands do not require a second confirmation on the node.

The installer never silently acquires root or administrator privileges. Run the Node Agent under the least-privileged account that still owns the intended DSH profiles and workspaces. A root Node Agent intentionally gives Hub root-equivalent control over that node.

## Human authentication

Cloudflare Access authenticates the browser through the chosen identity provider. Hub then verifies the Access JWT signature against the team JWKS, exact issuer, application audience, `type`, time claims, subject, and exact normalized operator-email allowlist.

The implementation follows Cloudflare's [JWT validation contract](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) and reads the application token from the documented [`Cf-Access-Jwt-Assertion` header](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/). Deployments must use the exact audience emitted for their Access application.

Cloudflare Access is not the only authorization layer. The operator allowlist is mandatory and contains no wildcard, domain suffix, or group expansion. Same-origin checks protect browser mutations, and the browser terminal WebSocket requires the exact public Origin.

## Node authentication

Each node receives a distinct Cloudflare Access Service Token and a short-lived one-time enrollment code. The Node Agent generates an Ed25519 identity locally and proves possession through a signed challenge. Hub stores only the enrollment-code hash and binds the node ID, node public key, and Service Token identity at first acceptance.

Later connections must match all three bound identities and cannot submit another enrollment code. Revocation fences new and existing connection generations. Rotate a Service Token by enrolling a replacement identity according to the operations guide; never copy another node's private configuration.

## Origin isolation

The public hostname terminates at Cloudflare Access and a trusted reverse proxy. The reverse proxy removes any incoming origin-secret header, inserts its private value, and forwards to the Hub over a private path. Hub checks this value before routing any HTTP or WebSocket endpoint and returns a not-found response when it is absent.

This application-layer guard prevents IP-and-port access from bypassing Cloudflare even when the origin port is accidentally reachable. It complements, rather than replaces, a loopback or private-interface bind, host firewall, overlay-network policy, TLS validation on non-loopback hops, and reverse-proxy access logs.

## Transport and replay protection

Node traffic uses HTTPS and WSS through the Access application. Signed application envelopes bind the node, boot, connection generation, direction sequence, cumulative acknowledgement, message ID, timestamps, body, and signature. Strict schemas reject unknown fields and oversized frames.

The durable journal accepts a message once, rejects gaps and impossible acknowledgements, fences superseded generations, and limits queued bytes. Reconstructible streams trigger a baseline refresh after interrupted delivery; transient PTY output is not replayed as if it were durable state.

## Secret handling

Hub secrets, Service Token secrets, enrollment codes, private Ed25519 keys, and Connector IPC secrets use owner-only files or container environment injection. They never enter Git, browser APIs, audit details, session discovery, snapshots, or diagnostic messages.

The Hub settings capability returns redacted values and secret-slot state. Snapshot collection excludes environment files and secret-like names, but it does not classify arbitrary file content; configure data roots as sensitive local state and review them before backup. Node snapshots remain in owner-only Node Agent storage. Plugin artifacts are executable code. Automatic update accepts only exact semantic versions from the public npm registry and records the downloaded SHA-256 on the node; this does not replace publisher and package-content review.

## Browser content security

Hub serves one fixed UI build with a restrictive Content Security Policy, frame denial, no third-party scripts, no inline script execution, no dynamic evaluation, and no runtime-loaded node UI extensions. The style policy permits inline attributes and `<style>` elements because the reviewed official bundles compute layout and inject component CSS at runtime; bundled fonts may use `data:` URLs, while the script policy still accepts only same-origin static assets. Hub selects Zod's non-JIT parser before the official entry runs, while Loader defers compiling its expression evaluator unless a composition actually evaluates an expression node. The reviewed static Hub roster contains no such nodes, so nodes cannot upload JavaScript for execution in the Hub origin.

Session events and terminal output remain untrusted display data. The UI inserts them as text rather than HTML. New rich renderers belong in the reviewed Hub build and must not evaluate event payloads.

## Storage and backup

SQLite contains security-relevant control state and must reside on an encrypted, access-controlled volume. Backups include node public identities, command metadata and transient unclaimed bodies, and audit records. Protect them like the live Hub state even though node private keys and model credentials are absent. Hub has no node-file cache. Back up Node Agent state separately when plugin rollback transactions and snapshots must survive node-disk loss.

Hub verifies the complete audit hash chain at startup. The chain detects damaged, changed, or reordered rows relative to the database being opened; it is not an external signature and cannot prove history against an administrator who can replace the database and recompute the chain. Export or anchor audit records outside the Hub failure and administration domain when that stronger property is required.

Restore permissions before starting Hub, verify that the state directory is writable only by the container UID, and retain more than one independent backup generation. Test restore procedures on an isolated hostname that cannot reach production nodes.

## Required deployment controls

- Protect the hostname with Cloudflare Access and validate JWTs in Hub.
- Bind the origin to loopback or a private interface and restrict the firewall to the reverse proxy.
- Inject the origin secret only at the trusted reverse proxy and rotate it after exposure.
- Issue one Service Token per node and revoke unused tokens immediately.
- Run Hub and Node Agent as unprivileged accounts with private state directories.
- Pin immutable container digests and release asset checksums for production upgrades.
- Monitor authentication failures, node generation changes, revocations, command outcomes, backup age, and audit-chain verification.
