# dsh-hub-server

[English](README.md) | 中文

`@k1412/dsh-hub-server` 组装单用户 Hub 控制平面。它提供认证后的浏览器 API、官方 Web HTTP/事件路由、实时 SSE Fan-out、静态 UI、出站 Node Agent WebSocket 终止、节点注册、能力命令投递和审计发布。它不会加载 DSH、LLM Provider、节点插件或执行后端。

每个源站请求首先通过应用层私有源站 Secret。人类路由随后校验 Cloudflare Access Application JWT 和精确的操作员邮箱白名单。Agent 路由校验 Service Token `common_name`，将其绑定到一个已注册节点，并在接收能力流量前完成 Ed25519 Challenge-response。Server 会校验 Issuer、Audience、时间声明、Token 类型、密钥轮换、节点签名 Envelope、Boot 身份和连接代次。

浏览器变更请求必须携带已配置的 HTTPS `Origin`、JSON Content-Type，并在存在 Fetch Metadata 时满足同源要求。Server 不发送任何 CORS 授权。安全响应头禁止 Frame、跨源 Opener 共享、MIME 嗅探、Referrer 泄漏、内联脚本、动态求值和响应缓存。Style Policy 允许经过审查的官方客户端 Bundle 生成内联 Style Attribute 和 `<style>` 元素；Script 仍只允许同源静态制品。Hub Boot Script 会在官方入口运行前选择 Zod 的非 JIT Parser，Loader 也只在 Composition 含有表达式节点时编译表达式求值器。

Hub 静态目录是官方 DSH Web 的固定构建，并包含经过审查的 Hub 设置插件；节点不能上传前端代码。Fleet 列表与搜索会汇总全部在线且支持 Web 的 Runtime；离线 Runtime 的最小会话索引仍按工作目录显示并明确标为离线，但历史和聊天操作要等待其所有者重连。浏览器中的不透明身份会把后续官方 `/api/*` 调用自动送回所属 Runtime，事件 WebSocket 则复用全部在线 Runtime。所选默认 Runtime 只用于没有既有身份的操作。SSE 只实时传递控制面节点事件，不保留事件正文。SQLite 持久化命令意图和投递状态；已完成正文只保留到浏览器显式确认或有界定期清理，因此 Hub 不会成为对话或工作区副本。

节点列表合并 Node Agent 报告的上行发件箱与 Hub 持有的下行发件箱状态，包括记录数、字节数、最旧记录、容量、最后心跳、压力和被抑制 Stream。压力变化进入审计日志；受影响的官方事件连接会关闭并重新同步，避免在流量中断后继续展示不完整状态。Hub 每 20 秒向官方浏览器事件通道和应急终端发送一次 WebSocket Ping，使空闲连接能够穿过有界的反向代理超时，并终止不再响应的对端。

## 模型体验

无。本 Server 是操作员控制平面，不注册任何面向模型的能力。

#### KV Cache 影响

无；Hub 传输和 API 记录不会进入模型请求。

## 已知限制与后续工作

- 本包要求一个活动 Hub Server 进程拥有其 SQLite 数据库和事件 Fan-out。
- TLS 和 Cloudflare Access Policy 在到达源站前执行。应用仍会校验每个 Access JWT，因为私有反向代理本身不是身份凭证。
