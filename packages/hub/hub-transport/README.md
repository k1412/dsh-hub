# dsh-hub-transport

English | [中文](README.zh.md)

`@k1412/dsh-hub-transport` provides the durable reliable-delivery state machine used beneath the Hub and Node Agent WebSocket loops. A reconnect creates a new fenced connection generation while retaining directional sequence numbers, message identifiers, accepted inbound work, and unacknowledged outbound bodies in SQLite.

## Delivery contract

The sender persists a strict protocol body before transmission. Each direction allocates a monotonically increasing sequence and attaches the receiver's cumulative acknowledgement. The receiver authenticates the signed envelope, verifies node, boot, generation, validity window, and acknowledgement range, then durably accepts exactly the next contiguous sequence before business dispatch.

An acknowledgement deletes only the confirmed outbound prefix. A reconnect re-signs the same durable message identifier, sequence, and body for the new connection generation and local boot. The send cursor pages through every record after the acknowledgement position, so a backlog at or beyond one page still drains. Duplicate delivery does not dispatch again, a gap requests authoritative resynchronization, and an old socket fails generation fencing.

Inbound work has `pending`, `processing`, and `processed` states. A process crash before dispatch leaves `pending` work. A crash during dispatch leaves `processing` work, allowing the capability layer to apply its declared read, idempotent, reconcile, or never-retry policy. Transport replay never assumes that a partially executed mutation is safe to repeat.

The outbox applies record and byte quotas and exposes records, bytes, oldest-record time, and configured capacity to its owner for backpressure and health reporting. Processed inbox content is removed while a bounded metadata suffix remains for deduplication. Acknowledgement-only records coalesce and are not answered with another acknowledgement-only record by the connection loop.

## Model Experience

None, as this package delivers control-plane records and registers nothing model-facing.

#### KV Cache effect

None; reliable-delivery records do not enter a model request.

## Known Limitations and Deferred Work

- Version 1 accepts contiguous WebSocket delivery and rejects gaps. Reconstructible high-volume streams resynchronize from their capability baseline instead of buffering arbitrary out-of-order windows.
- The SQLite journal is designed for one active process per peer database. Multi-process ownership requires an external lease and is outside this package.
