# dsh-hub-node-agent

[English](README.md) | 中文

`@k1412/dsh-hub-node-agent` 是节点上唯一与 Hub 通信的长期运行进程。它通过 Cloudflare Access 建立出站 WSS，拥有节点 Ed25519 身份和可靠 SQLite Journal，认证本地 Connector，监督重连，并在 DSH 重启期间保存命令。它不打开任何入站 TCP 端口。

Hub Release 提供 Linux／macOS 和 Windows 一键安装器。Hub 的节点注册页生成包含短期注册码的完整命令；安装器验证 Release 校验和，把本包安装到用户私有版本目录，把 Connector Bundle 安装进现有 DSH Profile，并配置当前用户的系统服务。Cloudflare Client Secret 只通过隐藏提示读取，不会写入复制命令或进程参数。

Node Agent 不适合并入 Connector 插件的生命周期。DSH Profile 重启时，插件必须卸载，但节点身份、WSS 断线恢复和未确认命令 Journal 必须继续存在；同一机器的多个 Profile 也只能共享一个节点网络身份。因此 Connector 是用户可见的 DSH 插件，Node Agent 是同一操作系统账户下由一个命令安装的 Sidecar，而不是第二个 DSH Runtime。

服务在注册前和每次握手时校验固定的 Hub 应用密钥。Cloudflare Service Token 提供边缘机器身份，Ed25519 Challenge 证明已注册节点身份。重连使用指数 Full-jitter Backoff、新 Boot 身份、Hub 分配的连接代次隔离、签名序列重放、累计确认、Heartbeat 终止和严格 Payload 限额。

每个 DSH Runtime 通过仅所有者可访问的 Unix Socket 或经过 HMAC 认证的 Windows Named Pipe 连接，并使用 256 位共享密钥。Runtime 发布能力基线，只接收发往其 Runtime ID 的命令。命令在 Connector 返回结果前保持 `processing`。崩溃后，只读和幂等工作可以恢复；对账操作通过稳定命令身份检查权威状态；禁止重试的工作返回 `outcome-unknown`。

配置、私钥、Connector Secret、注册 Code、Service Token Secret 和 SQLite 数据库均使用仅所有者可访问的文件。一次性注册 Code 会在 Hub 接受后原子删除。Node Agent 使用 Hub 获权控制的 DSH Context 所属 OS 账户运行，绝不会静默提升为 Host Root。

## 模型体验

无。Node Agent 是控制面传输，不注册任何面向模型的能力。

#### KV Cache 影响

无；Node Agent 记录不会进入模型请求。

## 已知限制与后续工作

- 进程管理器负责重启、日志保留、资源限制和操作系统沙箱。本包有意不以 Root 身份安装自身。
- 节点身份与可靠数据库构成一个恢复单元。保留密钥但丢失数据库时，必须吊销并重新注册，不能猜测序列状态。
