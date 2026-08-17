# dsh-hub-protocol

[English](README.md) | 中文

`@k1412/dsh-hub-protocol` 是 DSH Hub 与出站 Node Agent 之间与传输无关、带版本的协议。它定义严格能力 Descriptor、认证和命令 Body、签名 Envelope、Canonical JSON Hash、Ed25519 身份生成和验证失败分类。

本包不打开 Socket、不持久化 Queue、不调用 DSH，也不选择授权 Policy。WebSocket、本地 IPC Stream、持久 Queue 或测试 Loopback 都可以承载相同记录。实现先用 `hubSignedEnvelopeSchema` 解析不可信记录，再用 `verifyHubEnvelope()` 验证，只有通过后才能分发 Body。

## Envelope contract

每个 Envelope 都标识节点 Boot、Connection Generation、消息、方向 Sequence、累计 Acknowledgement、有效时间窗、Body Hash 和签名。签名覆盖完整 Header 和 SHA-256 Body Hash。Body 是严格 JSON，未知字段会导致校验失败。

`directionSequence` 在一条认证方向中单调递增，`cumulativeAck` 确认对端的连续前缀。Sequence 验证和持久回放属于传输实现；本包只提供 Wire Field，不持有可变连接状态。

Node Agent 使用 `transport.status` 控制正文报告可靠发件箱容量、当前使用量、压力级别和被抑制的 Stream 类别。该记录只描述传输健康，不改变确认位置，也不把被丢弃的瞬时 Frame 声明为已交付。

## Capability contract

`defineHubCapability()` 验证声明的能力并计算其 Canonical Descriptor Hash。每个 Operation 声明一种重试姿态：

- `read`：尝试中断后可以安全地再次执行；
- `idempotent`：使用相同 Idempotency Key 重复执行只产生一个结果；
- `reconcile`：崩溃可能使结果产生歧义，因此 Provider 会在另一次 Mutation 前检查权威状态；或者
- `never-retry`：中断的尝试返回显式终态失败，需要操作者产生新的意图。

Stream 声明从权威 Baseline 重新打开能否重建错过的状态。Descriptor 拒绝重复 Operation 或 Stream 名称。

## Authentication contract

`generateHubIdentity()` 返回 Ed25519 公钥和私钥 PEM。调用者负责以 Owner-only 权限持久化、轮换、吊销和备份该身份。`signHubEnvelope()` 验证并签署一条完整记录。`verifyHubEnvelope()` 区分格式错误、Body Hash 不匹配、签名失败、过期和不合理的未来 `issuedAt`。

应用握手在两个方向都使用新鲜 Challenge。TLS、Cloudflare Access、注册码验证、固定密钥和节点吊销是本包之外的实现 Policy，在部署系统中仍然是必需项。

## Model Experience

None, as this package authenticates control-plane records and registers nothing model-facing.

#### KV Cache effect

None; protocol records do not enter a model request.

## Known Limitations and Deferred Work

- 协议版本 1 承载 JSON 记录；制品字节流使用由传输包持有的 Chunk 记录，而不是本基础 Vocabulary。
- Canonical JSON 为可互操作的 Hub 记录定义，但外部实现仍需通过跨语言 Conformance Vector 才会获得支持。
