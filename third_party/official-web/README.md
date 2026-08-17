# Reviewed DSH Web artifact snapshot

This directory contains the browser-only artifact snapshot used by DSH Hub.
It keeps the Hub repository independent from the full DeepSeek Harness source
tree while preserving the exact official-Web interaction contract exercised by
the Hub acceptance tests.

- Upstream: `deepseek-ai/deepseek-harness` at the commit recorded in
  `snapshot.json`
- Hub compatibility changes: reproducible source patch in `hub-compat.patch`;
  `snapshot.json` pins both its source base and SHA-256
- License: MIT; see the repository `LICENSE` and `THIRD_PARTY_NOTICES.md`
- Integrity: every runtime file is hashed again when `scripts/build-hub-web.mjs`
  creates the immutable boot graph

The snapshot contains compiled browser assets only. It contains no Hub server,
node credentials, private endpoint, enrollment code, or user data.
