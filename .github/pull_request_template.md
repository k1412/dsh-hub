<!-- Use “Fixes #NN” for an issue this PR closes or “Related to #NN” for context. -->

## Summary / 变更摘要

- <!-- Describe the operator-visible or architectural outcome. -->

## Validation / 验证

- [ ] Relevant unit and integration tests pass.
- [ ] Hub protocol, authentication, storage, or recovery changes include failure-path tests.
- [ ] Local Web, desktop, and Hub coexistence remains covered when Connector behavior changes.
- [ ] Docker and packed release assets are verified when deployment code changes.

## Security and compatibility / 安全与兼容性

- [ ] No credentials, private deployment identifiers, hostnames, addresses, or personal data are committed.
- [ ] New dependencies and executable artifacts are justified and pinned by the lockfile or immutable digest.
- [ ] Wire, durable-state, browser API, and capability schema changes are explicitly versioned.
- [ ] The Hub remains a full-authority control plane, not a DSH runtime or node-confirmation layer.

## Documentation / 文档

- [ ] Chinese primary documentation and its complete English mirror are updated together.
- [ ] Reviewed Web snapshot changes pin the upstream commit and include a reproducible source patch.

Issue: <!-- Fixes #NN or Related to #NN -->
