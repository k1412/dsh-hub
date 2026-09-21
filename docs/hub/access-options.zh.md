# Hub 接入方案

Hub 让 DSH Runtime 留在节点上，只需要一个经过认证的浏览器入口和节点主动发起的连接。根据需要访问的操作员范围，选择最小的网络边界。

## 方案 A：Tailscale Serve（个人多节点推荐）

让 Hub HTTP 监听器只绑定 localhost，再用 `tailscale serve` 发布。Serve 只对 Tailnet 开放，遵循 Tailscale 的 grants 或 ACL，也可以附加身份 Header。后端必须继续只监听 localhost，避免局域网请求伪造这些 Header。这样不需要公网 DNS、证书管理或路由器入站规则。[Tailscale Serve 文档](https://tailscale.com/docs/features/tailscale-serve)介绍了当前 CLI 和身份 Header 行为。

当所有浏览器和 Hub 主机都能运行 Tailscale 时使用此方案。它应成为下一版本的默认部署路径。

## 方案 B：Tailcat 点对点转发（临时访问）

Tailcat 是基于 Tailscale WireGuard、NAT 穿透和 DERP 组件的 netcat 风格工具，不使用 Tailscale 控制面。它不会创建可复用的 Hub 身份，也没有应用级策略。它适合短时操作员隧道或引导流程，但应终止在只监听 localhost 的反向代理上，不能替代 Hub 的注册、浏览器认证、审计和节点授权。公共 DERP 中继有限流且没有可用性 SLA。[Tailcat 介绍](https://tailscale.com/tailcat)和[代码仓库](https://github.com/tailscale/tailcat)说明了这些限制。

## 方案 C：现有 HTTPS 反向代理加身份提供商

Hub 必须让公网浏览器访问时，继续使用现有反向代理和 Cloudflare Access 方案。代理负责 HTTPS 终止，只把请求转发到回环或私有网络中的 Hub Origin。代理必须删除外部传入的 Origin Secret Header，再自行注入配置值。Cloudflare Access Service Token 或身份提供商负责浏览器认证；Hub 仍独立校验操作员会话和节点注册。

## 方案 D：自托管控制面

如果不能依赖托管协调服务，可以使用 Headscale 或其他自托管 WireGuard 控制面。这保留类似 Tailscale 的私有网络模型，但需要自行维护控制面升级、ACL、DERP 可用性和设备注册。

## 推荐路径

下一版本的首次配置流程增加三个选项：**私有 Tailscale Serve**、**现有 HTTPS/Access**、**临时 Tailcat 隧道**。前两个是完整部署模式；Tailcat 是带明确过期时间的诊断/引导模式，不改变 Hub 的授权模型。

