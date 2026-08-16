# dsh-hub-capabilities

[English](README.md) | 中文

`@k1412/dsh-hub-capabilities` 定义 Hub 服务与 DSH 进程内 Connector 之间的版本化应用合约。它不依赖官方 Web 插件或其传输层。Connector 将这些合约直接映射到本地 Web 和桌面端已共享的 DSH Runtime Service。

当前合约覆盖共享会话与实时事件、官方 Web HTTP/事件载体、交互终端、插件清单与事务化发布、四类快照、Runtime 健康、脱敏设置，以及以节点为权威来源的工作区文件。插件与快照合约已升级到版本 2，其余能力保持精确版本协商。每个操作和 Stream 都具有严格运行时 Schema，其规范化 JSON Schema 哈希包含在节点公告的能力 Descriptor 中。

能力必须精确匹配版本。变更操作声明只读、幂等、对账或禁止重试语义，使崩溃恢复不会盲目重复执行。可重建 Stream 从新的权威基线恢复；临时终端输出会报告中断，不会伪造丢失的字节。

## 模型体验

无。这些是操作员控制面合约，不注册任何面向模型的能力。

#### KV Cache 影响

无；能力校验不会改变模型输入。

## 已知限制与后续工作

- 合约有意暴露 JSON 兼容的 DSH Domain Event。Connector 会拒绝无法序列化的事件类型，而不会上传可执行 UI 代码。
- 普通操作期间，插件制品和快照保留在仅所有者可访问的 Node Agent 状态中；能力操作只携带不可变哈希和 Manifest，不内嵌大型字节数组。
