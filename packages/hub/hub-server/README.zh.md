# dsh-hub-server

[English](README.md) | 中文

`@k1412/dsh-hub-server` 组装单用户 Hub 控制平面。它提供认证后的浏览器 API、官方 Web HTTP/事件路由、实时 SSE Fan-out、静态 UI、出站 Node Agent WebSocket 终止、节点注册、能力命令投递和审计发布。它不会加载 DSH、LLM Provider、节点插件或执行后端。

每个源站请求首先通过应用层私有源站 Secret。人类路由随后校验 Cloudflare Access Application JWT 和精确的操作员邮箱白名单。Agent 路由校验 Service Token `common_name`，将其绑定到一个已注册节点，并在接收能力流量前完成 Ed25519 Challenge-response。Server 会校验 Issuer、Audience、时间声明、Token 类型、密钥轮换、节点签名 Envelope、Boot 身份和连接代次。

浏览器变更请求必须携带已配置的 HTTPS `Origin`、JSON Content-Type，并在存在 Fetch Metadata 时满足同源要求。Server 不发送任何 CORS 授权。安全响应头禁止 Frame、跨源 Opener 共享、MIME 嗅探、Referrer 泄漏、内联脚本和响应缓存。

Hub 静态目录是官方 DSH Web 的固定构建，并包含经过审查的 Hub 设置插件；节点不能上传前端代码。官方 `/api/*` 和事件 WebSocket 按浏览器选择的节点与 Runtime 路由。SSE 只实时传递控制面节点事件，不保留事件正文。SQLite 持久化命令意图和投递状态；已完成正文只保留到浏览器显式确认或有界定期清理，因此 Hub 不会成为对话或工作区副本。

## 模型体验

无。本 Server 是操作员控制平面，不注册任何面向模型的能力。

#### KV Cache 影响

无；Hub 传输和 API 记录不会进入模型请求。

## 已知限制与后续工作

- 本包要求一个活动 Hub Server 进程拥有其 SQLite 数据库和事件 Fan-out。
- TLS 和 Cloudflare Access Policy 在到达源站前执行。应用仍会校验每个 Access JWT，因为私有反向代理本身不是身份凭证。
