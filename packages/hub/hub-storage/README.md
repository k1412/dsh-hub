# dsh-hub-storage

English | [中文](README.zh.md)

`@k1412/dsh-hub-storage` supplies the single-Hub persistence boundary. It combines an owner-only SQLite control database with an immutable content-addressed object directory. SQLite runs with foreign keys, WAL journaling, full synchronous durability, extension loading disabled, strict tables, and an exact schema version.

## Stored data

The control database stores enrolled node identities, revocation state, connection generations, reliable-delivery journals, runtime capability baselines, a minimal session discovery index, durable command state, content-addressed object metadata, and a hash-chained audit log. Audit rows are append-only at the SQLite trigger layer.

Command intent is persisted before delivery. Legal state transitions distinguish pending, sent, running, successful, failed, and outcome-unknown commands. Hub discards a completed command's payload and result after the browser explicitly acknowledges the terminal result and periodically cleans abandoned completed bodies after a bounded retention window while retaining hashes and lifecycle metadata.

SQLite triggers make audit rows append-only, and the hash chain detects record changes or reordering when verified. The chain is not a signature or external transparency log and does not resist an administrator who can replace the database and recompute every hash.

The object directory accepts only four explicit durable classes: plugin artifacts, snapshots, exports, and backups. Objects use SHA-256 paths, atomic installation, hash verification, reference counting, and reference-aware collection. They are durable records rather than a general cache.

Conversation transcripts, workspace files, attachments, terminal output, raw logs, and credentials remain authoritative on their nodes and are not mirrored into this storage package. Session discovery contains identifiers, a title, timestamps, running state, and staleness only.

## Backup boundary

`HubControlStore.backupTo()` uses SQLite online backup for a transactionally consistent database copy. Content-addressed objects are immutable; an operational backup copies the database and referenced object tree together, verifies hashes, and protects both with the same owner-only access policy.

## Model Experience

None, as this package owns control-plane persistence and registers nothing model-facing.

#### KV Cache effect

None; stored control records do not enter a model request.

## Known Limitations and Deferred Work

- Schema version 1 requires an exact version match; upgrades that change it require the release-specific backup and migration procedure.
- The recommended topology runs one active Hub writer. High-availability multi-writer storage requires a separate consensus design and is not emulated with network-mounted SQLite.
