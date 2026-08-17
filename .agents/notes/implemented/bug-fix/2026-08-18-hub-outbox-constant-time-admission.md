# Agent Note: Hub outbox admission stays constant-time

Status: implemented

English | [中文](2026-08-18-hub-outbox-constant-time-admission.zh.md)

## Problem

Reliable-journal admission counted every retained row and summed every body size before each enqueue. Filling the supported 10,000-record outbox therefore performed progressively larger scans and became quadratic. Two exact-capacity regressions running beside the assembled Web suite could exceed a shared CI runner's timeout even though the resulting journal remained correct.

The byte total cannot live only in process memory. Hub opens journals repeatedly over one control database, Node Agent must retain limits across restarts, and crash recovery must observe the same value as the durable rows.

## Decision

Peer state durably stores `outbound_bytes` beside the outbound sequence and acknowledgement cursors. Enqueue reads that one row to check record and byte limits, inserts the body, and increments the sequence and byte total in the same immediate transaction. Acknowledgement totals the deleted prefix once, then deletes it and subtracts its bytes in one transaction. Record usage is the exact difference between the two durable cursors.

Schema installation detects databases created before this field existed, adds the constrained counter, and backfills every peer from its retained outbox before normal journal construction continues. The migration is idempotent, so reopening the database does not recount or change a current counter.

## Alternatives considered

**Increase the test timeout.** This would hide workload-sensitive latency while preserving the quadratic production path for offline nodes with a large backlog.

**Cache usage in each journal object.** Separate journal instances and process restarts would disagree, allowing admission beyond the byte limit or rejecting work after acknowledgements.

**Maintain a separate aggregate table.** Peer state already owns the related sequence and acknowledgement cursors, so another row and lifecycle would add synchronization work without improving isolation.

## Consequences

Enqueue admission no longer scans retained bodies and exact-capacity tests complete well within their original timeout. Byte limits remain effective after reopen and upgrade. Acknowledgement still performs one bounded prefix aggregation because it deletes that same prefix; it does not repeat for each queued record.

Migration, acknowledgement, reopen, quota, 10,000-record pagination, Node Agent pressure, and multi-node delivery tests cover the resulting state transitions.
