# Security Policy

[中文](SECURITY.md) | English

The DSH Hub operator has the enrolled node account's full authority. A vulnerability may affect terminal commands, workspace files, sessions, plugin updates, and snapshot recovery. Do not disclose exploitable details in a public issue.

Use the repository's **Security → Report a vulnerability** flow and include affected versions, prerequisites, reproduction, impact, and a suggested fix. Never attach live tokens, private keys, enrollment codes, or user data; ask for a secure transfer path when evidence is necessary.

Authentication or Origin Secret bypass, cross-node routing, signature or replay flaws, command escalation, node-supplied script execution, reliable-queue cross-talk, update/rollback artifact verification, and backup disclosure receive priority. Keep reports private until a fix ships.

Only the current stable GitHub Release is supported. A secure deployment requires an identity-protected HTTPS entry, a non-public Origin, an exact operator allowlist, one Service Token per node, and non-privileged node accounts. See the [security model](docs/hub/security.md).
