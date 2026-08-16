# `@k1412/dsh-hub-connector`

[English](README.md) | 中文

Hub Connector 是宿主侧 Cordis 命名空间插件，用于把一个现有 DSH Runtime 接入本机 Hub Node Agent。它使用与传输无关的 `ctx.apiProxy` 与 Typert Gateway，因此 Hub、本地 Web 与桌面客户端操作相同的会话、事件源、持久化、设置和模型配置。

Hub 节点注册页给出的一个命令会同时安装此 Connector Bundle 和配套 Node Agent。对 DSH 而言，客户端扩展形态就是本包的 `dsh.bundle`；常驻 Node Agent 不属于第二个 Profile，也不拥有 DSH Runtime。

Connector 只建立经过认证的本地 IPC 客户端连接。它没有 HTTP Server、公网监听、浏览器资源或 DSH Web 插件依赖，也不拥有另一套 DSH Runtime。`dsh.web` 能力把官方 Web 的 HTTP 请求和两条事件通道映射到 Host Service，不代理节点 Web 端口。移除 Connector 不会改变任何本地 DSH 界面和会话权威状态。

发行 Bundle 向现有 Profile 添加一个 Cordis 配置行。它的命名空间导出可以让 `inject`、`Config` 和 `apply` 完整通过真实 Cordis Loader。一个 Connector 实例使用稳定 Runtime ID 标识一个 DSH 进程；同一机器上的多个 Profile 可以使用不同 Runtime ID 共享同一个 Node Agent。

Connector 会从启动 Runtime 的 CLI 软件包中检测 DSH 版本。仅当嵌入式启动器隐藏了该软件包路径时，才需要在 DSH 进程上设置 `DSH_HUB_DSH_VERSION`；显式的 `dshVersion` 插件配置优先于这两种方式。

## 模型体验

无，因为 Connector 只桥接操作员控制平面调用，不注册面向模型的 Prompt、工具、Skill 或 Context。

#### KV Cache 影响

无；Connector 传输记录不会进入模型请求。

## 已知限制与延期工作

- Connector 必须运行在提供兼容 Host `apiProxy` 与 Typert Gateway 的 DSH Context 中。标准 Profile 会提供这些 Service；其他组合必须显式组合它们及其前置依赖。Connector 不能附加到不相关的 DSH 进程，也不会推断两个进程共享实时状态。
- Node Agent 必须使用能够读取仅所有者可访问 IPC 密钥并连接已配置本地端点的操作系统账户运行。
