# dsh-hub-capabilities

English | [中文](README.zh.md)

`@k1412/dsh-hub-capabilities` defines the versioned application contract between Hub services and a Connector running inside DSH. It does not depend on the official Web plugin or its transport. The Connector maps these contracts directly to the DSH runtime services already shared by local Web and desktop surfaces.

The current contracts cover shared sessions and live events, the official Web HTTP/event carrier, interactive terminals, plugin inventory and transactional rollout, four snapshot classes, runtime health, redacted settings, and node-authoritative workspace files. Plugin and snapshot contracts are at version 2 while every other capability remains exactly version-negotiated. Every operation and stream has a strict runtime schema whose canonical JSON Schema hash is included in the advertised capability descriptor.

Exact version matching is required. Mutation operations declare read, idempotent, reconcile, or never-retry behavior, allowing crash recovery to avoid blind repetition. Reconstructible streams recover from a new authoritative baseline; transient terminal output reports an interruption rather than fabricating missed bytes.

## Model Experience

None, as these are operator control-plane contracts and register nothing model-facing.

#### KV Cache effect

None; capability validation does not alter model input.

## Known Limitations and Deferred Work

- The contracts intentionally expose JSON-compatible DSH domain events. A Connector rejects an event type it cannot serialize instead of uploading executable UI code.
- Plugin artifacts and snapshots remain in owner-only Node Agent state during ordinary operations; capability operations carry immutable hashes and manifests rather than embedding large byte arrays.
