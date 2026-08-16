# dsh-hub-server

English | [中文](README.zh.md)

`@k1412/dsh-hub-server` assembles the single-user Hub control plane. It provides the authenticated browser API, live SSE fan-out, static UI delivery, outbound Node Agent WebSocket termination, node enrollment, capability command delivery, and audit publication. It never loads DSH, an LLM provider, a node plugin, or an execution backend.

Every origin request first passes an application-layer private-origin secret. Human routes then verify a Cloudflare Access application JWT and an exact operator email allowlist. Agent routes verify a Service Token `common_name`, bind it to one enrolled node, and complete an Ed25519 challenge-response before accepting capability traffic. The server validates issuer, audience, time claims, token type, key rotation, signed node envelopes, boot identity, and connection generation.

Browser mutations require the configured HTTPS `Origin`, JSON content type, and same-origin Fetch Metadata when present. No CORS permission is emitted. Security headers disable framing, cross-origin opener sharing, MIME sniffing, referrer leakage, inline scripts, and response caching.

SSE transfers live node events without retaining their payloads. A reconnect receives a resynchronization marker and reads fresh node-authoritative baselines. SQLite persists command intent and delivery state; completed bodies remain only until explicit browser acknowledgement or bounded periodic cleanup, so the Hub does not become a transcript or workspace replica.

## Model Experience

None, as this server is an operator control plane and registers nothing model-facing.

#### KV Cache effect

None; Hub transport and API records do not enter a model request.

## Known Limitations and Deferred Work

- The package expects one active Hub server process for its SQLite database and event fan-out.
- TLS and Cloudflare Access policy enforcement occur before the origin. The application still validates every Access JWT because a private reverse proxy is not an identity proof.
