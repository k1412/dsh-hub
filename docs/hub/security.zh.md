# DSH Hub 安全

[English](security.md) | 中文

本参考定义单操作员 Hub 与完全受信任注册节点的安全模型。

## 权限模型

Hub 操作员拥有已注册 Runtime 声明的全部 DSH 能力。启用 Profile 管理后，Node Agent 还会授予与其操作系统账户相同的文件、终端、插件和快照权限。命令不需要节点再次确认。

安装程序不会静默获取 Root 或管理员权限。应使用仍能拥有目标 DSH Profile 和工作区的最低权限账户运行 Node Agent。使用 Root 账户运行 Node Agent 会有意赋予 Hub 等同 Root 的节点控制权。

## 人员认证

Cloudflare Access 通过选定的身份提供方认证浏览器。Hub 随后根据 Team JWKS、精确 Issuer、Application Audience、`type`、时间声明、Subject 和精确规范化操作员邮箱白名单验证 Access JWT 签名。

实现遵循 Cloudflare 的 [JWT 验证合约](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)，并从文档规定的 [`Cf-Access-Jwt-Assertion` Header](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)读取 Application Token。部署必须使用其 Access Application 实际签发的精确 Audience。

Cloudflare Access 不是唯一授权层。操作员白名单是必需项，不支持通配符、域名后缀或组扩展。同源检查保护浏览器变更，浏览器终端 WebSocket 还要求精确的公共 Origin。

## 节点认证

每个节点获得不同的 Cloudflare Access Service Token 和短期一次性注册代码。Node Agent 在本地生成 Ed25519 身份，并通过签名挑战证明持有密钥。Hub 仅保存注册代码哈希，并在首次接受时绑定节点 ID、节点公钥和 Service Token 身份。

后续连接必须同时匹配三个已绑定身份，也不能再次提交注册代码。吊销会隔离新旧连接代际。请按照运维指南通过注册替代身份来轮换 Service Token；不得复制其他节点的私有配置。

## Origin 隔离

公共主机名终止于 Cloudflare Access 和受信任反向代理。反向代理删除任何传入 Origin Secret Header，插入其私有值，并通过私有路径转发到 Hub。Hub 在路由任何 HTTP 或 WebSocket Endpoint 前检查该值，缺失时返回 Not Found。

即使 Origin 端口被意外暴露，这个应用层保护也会阻止通过 IP 和端口绕过 Cloudflare。它用于补充而不是替代回环或私有接口绑定、主机防火墙、Overlay Network Policy、非回环链路的 TLS 验证以及反向代理访问日志。

## 传输与重放保护

节点流量通过 Access Application 使用 HTTPS 和 WSS。签名应用信封绑定节点、Boot、连接代际、方向序列号、累计确认、消息 ID、时间戳、正文和签名。严格 schema 会拒绝未知字段和超限 Frame。

持久日志只接受一次消息，拒绝序列缺口和不可能的确认，隔离被替代代际，并限制排队字节数。可重建流在交付中断后触发基线刷新；瞬时 PTY 输出不会被当作持久状态重放。

## 机密处理

Hub Secret、Service Token Secret、注册代码、Ed25519 私钥和 Connector IPC Secret 使用仅所有者可读的文件或容器环境注入。它们不会进入 Git、浏览器 API、审计详情、会话索引、快照或诊断消息。

Hub 设置能力返回脱敏值和 Secret Slot 状态。快照收集会排除环境文件和名称类似机密的文件，但不会对任意文件内容做机密分类；应把数据根目录视为敏感本地状态，并在备份或导出前审核。节点快照保留在仅所有者可访问的 Node Agent 存储中。插件制品是可执行受信任代码：只能应用经过审查且精确版本和 SHA-256 哈希与已批准制品一致的包。

## 浏览器内容安全

Hub 提供一个固定 UI Build，并使用严格的 Content Security Policy、Frame Deny、无第三方脚本、禁止内联脚本执行和禁止运行时加载节点 UI 扩展。节点不能上传 JavaScript 并在 Hub Origin 中执行。

会话事件和终端输出仍属于不受信任的显示数据。UI 以文本而不是 HTML 插入它们。新的富渲染器必须进入经过审查的 Hub Build，且不得求值事件 Payload。

## 存储与备份

SQLite 和内容寻址对象包含安全相关控制状态，必须位于加密且受访问控制的 Volume 上。备份包含节点公有身份、命令元数据与尚未领取的瞬时正文、审计记录，以及显式导入 Hub 存储的对象；即使其中不含节点私钥和模型凭据，也必须按实时 Hub 状态的等级保护。需要让本地插件回滚事务和快照在节点磁盘丢失后继续可用时，应单独备份 Node Agent 状态。

Hub 会在启动时验证完整审计哈希链。相对于当前打开的数据库，该哈希链可以发现损坏、变化或顺序重排的记录；它不是外部签名，无法针对有权替换数据库并重新计算哈希链的管理员证明历史。如果需要更强属性，应把审计记录导出或锚定到 Hub 故障域和管理域之外。

启动 Hub 前恢复文件权限，确认状态目录只允许容器 UID 写入，并保留多个独立备份世代。恢复演练应使用无法连接生产节点的隔离主机名。

## 必需部署控制

- 使用 Cloudflare Access 保护主机名，并在 Hub 中验证 JWT。
- 将 Origin 绑定到回环或私有接口，并通过防火墙只允许反向代理访问。
- 只在受信任反向代理注入 Origin Secret，并在泄露后轮换。
- 为每个节点签发一个 Service Token，并立即吊销不再使用的 Token。
- 使用非特权账户和私有状态目录运行 Hub 与 Node Agent。
- 生产升级固定不可变容器 Digest 和 Release 制品校验和。
- 监控认证失败、节点代际变化、吊销、命令结果、备份时效和审计链验证。
