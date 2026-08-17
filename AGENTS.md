# DSH Hub repository guidance

This repository contains only the DSH Hub control plane, node-side integration,
deployment, reviewed Web artifact snapshot, tests, and bilingual documentation.

- Preserve the full-authority, single-operator model and the node-only outbound connection boundary.
- Never expose a node's local DSH Web listener or run a second DSH Runtime for Hub access.
- Route every operation by explicit node and Runtime ownership; add simultaneous multi-node coverage for routing or transport changes.
- Keep public documentation generic and free of live domains, addresses, accounts, paths, and secrets.
- Update Chinese primary docs and their English mirror together.
- Treat `third_party/official-web/dist` as generated reviewed material; update it only with its pinned source patch and Web regression gates.
- Run `pnpm run check` and `pnpm run build` before handoff.
