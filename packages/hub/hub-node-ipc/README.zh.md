# dsh-hub-node-ipc

[English](README.md) | 中文

`@k1412/dsh-hub-node-ipc` 定义进程外 Node Agent 与 DSH Runtime 内 Connector 之间的本地 Stream。它使用严格 JSON Frame、四字节长度前缀、4 MiB Frame 限额，以及通过 HMAC-SHA-256 认证的新鲜 Challenge。256 位共享 Secret 不会在 Socket 中传输。

Unix 部署将 Socket 和 Secret 放在仅所有者可访问的目录中。Windows 部署使用经过 HMAC 认证的 Named Pipe，并以仅所有者可访问的文件权限保护 Secret。Node Agent 不打开入站 TCP Listener。无法读取 Secret 的本地进程不能注册 Runtime 或注入 Hub 命令。

本地 Body Carrier 复用 Hub 协议的严格业务正文 Schema，但不复用其互联网签名 Envelope。Node Agent 始终是 WSS、Ed25519 身份、序列 Journal、注册凭据和重连策略的唯一所有者。

## 模型体验

无。本地传输不注册任何面向模型的能力。

#### KV Cache 影响

无；IPC 记录不会进入模型请求。

## 已知限制与后续工作

- 操作系统权限是认证的一部分。管理员或已经以 Node Agent 账户运行的进程可以读取 Secret，并处于该节点的权限边界内。
- 一个 Connector 连接一次拥有一个 Runtime ID；同一 ID 重新连接会替换此前的本地 Socket。
