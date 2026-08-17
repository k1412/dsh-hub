# dsh-hub-protocol

English | [中文](README.zh.md)

`@k1412/dsh-hub-protocol` is the transport-neutral, versioned contract between a DSH Hub and outbound Node Agents. It defines strict capability descriptors, authentication and command bodies, signed envelopes, canonical JSON hashing, Ed25519 identity generation, and verification failure categories.

The package does not open sockets, persist queues, invoke DSH, or select an authorization policy. A WebSocket, local IPC stream, durable queue, or test loopback carries the same records. Implementations parse an untrusted record with `hubSignedEnvelopeSchema`, verify it with `verifyHubEnvelope()`, and only then dispatch its body.

## Envelope contract

Every envelope identifies the node boot, connection generation, message, directional sequence, cumulative acknowledgement, validity window, body hash, and signature. The signature covers the complete header and SHA-256 body hash. The body is strict JSON and unknown fields fail validation.

`directionSequence` is monotonic within one authenticated direction and `cumulativeAck` acknowledges the peer's contiguous prefix. Sequence validation and durable replay belong to the transport implementation; this package supplies their wire fields without keeping mutable connection state.

Node Agent uses the `transport.status` control body to report reliable-outbox capacity, current usage, pressure, and suppressed stream classes. This record describes transport health only; it neither advances an acknowledgement nor claims that a suppressed transient frame was delivered.

## Capability contract

`defineHubCapability()` validates an advertised capability and derives its canonical descriptor hash. Each operation declares one retry posture:

- `read`: safe to execute again after an interrupted attempt;
- `idempotent`: repeated execution with the same idempotency key has one result;
- `reconcile`: a crash may make the outcome ambiguous, so the provider inspects authoritative state before another mutation; or
- `never-retry`: an interrupted attempt returns an explicit terminal failure and requires new operator intent.

Streams declare whether reopening from an authoritative baseline reconstructs missed state. A descriptor rejects duplicate operation or stream names.

## Authentication contract

`generateHubIdentity()` returns an Ed25519 public/private PEM pair. The caller owns owner-only persistence, rotation, revocation, and backup of that identity. `signHubEnvelope()` validates and signs one complete record. `verifyHubEnvelope()` distinguishes malformed data, body-hash mismatch, signature failure, expiry, and an implausibly future `issuedAt` value.

The application handshake uses fresh challenges in both directions. TLS, Cloudflare Access, enrollment-code validation, pinned keys, and node revocation are implementation policy outside this package and remain required in the deployed system.

## Model Experience

None, as this package authenticates control-plane records and registers nothing model-facing.

#### KV Cache effect

None; protocol records do not enter a model request.

## Known Limitations and Deferred Work

- Protocol version 1 carries JSON records; artifact byte streams use chunk records owned by the transport package rather than this foundational vocabulary.
- Canonical JSON is defined for interoperable Hub records, but external implementations still require cross-language conformance vectors before they are supported.
