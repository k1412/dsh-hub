# hub/：DSH Hub 控制平面软件包

[English](README.md) | 中文

Hub 软件包族定义远程控制平面，但不会让 Hub 成为 DSH Runtime。

| 软件包 | 职责 | ctx key |
|---|---|---|
| [`hub-protocol/`](hub-protocol/README.md) | 带签名和版本的 Hub 到节点 Wire Vocabulary 与能力 Descriptor | 无 |
| [`hub-storage/`](hub-storage/README.md) | SQLite 控制平面记录和内容寻址持久对象 | 无 |
| [`hub-transport/`](hub-transport/README.md) | 持久序列、确认、重放与连接隔离 | 无 |
| [`hub-server/`](hub-server/README.md) | 认证后的操作 API、事件投递与 Agent WebSocket Server | 无 |
| [`hub-capabilities/`](hub-capabilities/README.md) | 运行时校验的 DSH 会话、终端、插件、快照、设置和文件合约 | 无 |
| [`hub-node-ipc/`](hub-node-ipc/README.md) | 使用仅所有者可访问密钥的 Connector 到 Agent 本地认证分帧 | 无 |
| [`hub-node-agent/`](hub-node-agent/README.md) | 出站 WSS、节点持久状态、本地 Connector Registry 与监督 | 无 |
| [`hub-connector/`](hub-connector/README.md) | 把现有 DSH `apiProxy` 接入认证本地 IPC 的 Cordis 插件 | `apiProxy` |

依赖方向从 Hub Application、Node Agent 和 Connector 实现指向 `hub-protocol`。协议包不依赖 Web Server、Agent、模型、工具或文件系统控制能力。

## 已知限制与延期工作

- Hub 软件包只实现单活动 Hub Writer；多写入者高可用需要单独的共识设计。
