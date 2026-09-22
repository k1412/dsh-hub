# Hub 接入方案

Hub 让 DSH Runtime 留在节点上，只需要一个浏览器入口和节点主动发起的连接。根据操作员范围选择最小的网络边界。

## 方案 A：Tailscale Serve（多设备推荐）

让 Hub HTTP 监听器只绑定 localhost，再用 `tailscale serve` 发布。Serve 只对 Tailnet 开放，遵循 Tailscale grants 或 ACL，也可以附加身份 Header。后端必须继续只监听 localhost，避免局域网请求伪造这些 Header。这样不需要公网 DNS、证书管理或路由器入站规则。参见 [Tailscale Serve 文档](https://tailscale.com/docs/features/tailscale-serve)。

当 Hub 主机和所有浏览器都能运行 Tailscale 时使用此方案。它适合多个可信设备，因为控制面提供设备身份、策略和撤销能力。

## 方案 B：Tailcat 设备配对（一个或两个可信设备推荐）

Tailcat 使用 Tailscale 的 WireGuard、NAT 穿透和 DERP 组件建立点对点加密隧道，但不使用 Tailscale 控制面。它可以按客户端公开的 `nodekey` 限制连接，因此仅知道地址不能访问。

仓库提供三个脚本：

```sh
# 在操作员设备执行；私钥留在此设备。
deploy/tailcat/enroll-client.sh

# 在 Hub 主机执行；登记上一步打印的公开 nodekey。
export TAILCAT_ALLOWED_NODEKEY='nodekey:...'
export DSH_HUB_PORT=3000
deploy/tailcat/serve-hub.sh

# 在操作员设备执行；填写服务端打印的地址。
export TAILCAT_ADDRESS='tc...'
deploy/tailcat/connect-hub.sh
# 浏览器打开 http://127.0.0.1:3000
```

服务端脚本默认使用名为 `default` 的保存密钥。需要稳定地址时，在服务端先执行 `tailcat genkey --key=default --fixed-region`；临时使用时设置 `TAILCAT_SERVER_KEY=new`。Hub 端口仍然只在本机监听。客户端私钥不会传到 Hub，只登记公开的 `nodekey`。

这是带有明确默认信任模型的设备强绑定：每台批准的设备都拥有相同的 Hub 操作权限。撤销设备时，从服务配置中删除它的 `nodekey` 并重启服务；如果地址已经广泛泄露，再轮换服务端密钥。除非配置了 `--allow`，不要公开地址，因为 Tailcat 地址本身是 bearer capability。

Tailcat 没有用户、用户组、ACL 策略语言、设备清单或集中撤销服务；当前 CLI 和线协议也没有稳定性承诺，公共 DERP 中继是尽力服务。因此它适合个人 Hub、引导流程或固定的少量设备。设备较多或成员经常变化时使用 Tailscale Serve。参见 [Tailcat 介绍](https://tailscale.com/tailcat)、[Tailcat 密钥与 allowlist 说明](https://github.com/tailscale/tailcat/blob/main/README.md#key-management)和 [Tailcat 受保护访问示例](https://github.com/tailscale/tailcat/blob/main/README.md#protected-ssh-server-over-dns)。

## 方案 C：现有 HTTPS 反向代理加身份提供商

Hub 必须让公网浏览器访问时，继续使用现有反向代理和 Cloudflare Access 方案。代理负责 HTTPS 终止，只把请求转发到回环或私有网络中的 Hub Origin。代理必须删除外部传入的 Origin Secret Header，再自行注入配置值。Cloudflare Access 或其他身份提供商负责浏览器认证；Hub 仍独立维护用户会话、审计和节点注册。

## 方案 D：Headscale 或其他自托管控制面

如果不能依赖托管协调服务，可以使用 Headscale。这保留类似 Tailscale 的私有网络模型，但需要自行维护控制面升级、ACL 策略、DERP 可用性和设备注册。

## 选择建议

| 场景 | 推荐接入方式 | 原因 |
| --- | --- | --- |
| 一个 Hub 和一台可信笔记本 | Tailcat allowlisted `nodekey` | 配置最少，不需要账号或控制面 |
| 多台个人设备 | Tailscale Serve | 提供设备身份、ACL 和撤销能力 |
| 外部协作者或公网浏览器 | HTTPS 代理加身份提供商 | 提供用户身份和审计策略 |
| 不能使用托管协调服务 | Headscale | 自托管控制面和 ACL |

Tailcat 保护传输并绑定设备密钥，但不替代 Hub 的应用授权或节点注册。所有方案都应让 Hub 监听器保持 localhost-only。
