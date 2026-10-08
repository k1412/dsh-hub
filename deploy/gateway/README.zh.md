# Gateway 网络工具与验证

Hub 镜像包含固定的 Tailscale 1.102.4 和 Tailcat 0.7.0。两种工具的 Linux amd64/arm64 安装包都有固定 SHA-256，保存在镜像的 `/app/downloads` 中。节点安装命令按邀请中的方式选择工具，最终配对只经过选定的加密覆盖网络。应用不会探测局域网地址或追加局域网、公网回退路径。

普通容器使用独立的用户态 `tailscaled`，登录和身份保存在 Hub 状态卷中。`compose.host-tailscale.yaml` 复用宿主已经登录的 Tailscale：只读取状态，在其 Tailnet IP 上绑定独立入口，不调用宿主的 `up`、`login` 或 `serve`。Tailcat 在独立状态目录保存 Hub 和 node 的持久密钥，由官方工具管理直连与中继。

安装器先检查本机 Tailscale，状态查询最多等待 4 秒。已有可访问且已登录的客户端时直接复用，不下载另一份，不重新登录；可通过 `DSH_GATEWAY_TAILSCALE_SOCKET` 指定现有 daemon 的绝对 socket 路径。复用模式在设备退出登录后提示重新登录现有 Tailscale，不自动创建另一个身份。Hub 邀请只负责 DSH 配对，不替代 Tailscale 登录或网络权限；节点需要能够通过 Tailnet 访问 Hub。

Linux amd64/arm64 没有可用客户端时才下载固定版本的专用工具，并提示完成官方登录。专用网络归档保存在节点状态目录的 `network-cache` 中，重复安装先校验完整 SHA-256，再复用；损坏或版本不同会重新下载。首次使用此缓存的旧安装仍需下载一次。macOS 需预装所选工具，Tailscale 必须已登录。节点 CLI 把插件安装到现有 DSH Profile，不创建第二个 DSH Runtime。

在仓库中运行以下命令准备工具并执行真实网络测试：

```sh
node deploy/gateway/download-network.mjs --directory /tmp/gateway-downloads --install-directory /tmp/gateway-tools --arch amd64
node deploy/gateway/smoke-network.mjs --mode all --bin-directory /tmp/gateway-tools --requests 40 --concurrency 4 --reconnects 3 --hub-restarts 1 --report /tmp/gateway-network-report.json
```

测试创建临时 Hub 网络身份和两个隔离的 node 连接实例，通过真实 Tailcat 与 Tailscale CLI 发出并发 HTTP 请求，校验内容和来源，并测试 node 重连及 Hub 网络进程重启。测试不修改宿主 Tailscale 配置；Tailscale 未登录时会明确失败。报告把首次握手、持续请求和恢复时间分别统计，包含 p50、p95、失败率和恢复次数。

这是连接层测试。两个 node 实例在同一台测试机器上；Tailscale 通过现有宿主的 `nc` 数据面访问本机 Tailnet IP，结果不能代表跨机器或公网延迟。测试服务计数保留也不能替代 DSH 历史、草稿或权限状态的验收。已保存的实测报告位于 `reports/network-local-2026-10-03.json`。

官方依据：[Tailscale 用户态网络](https://tailscale.com/docs/concepts/userspace-networking)、[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)、[Tailcat](https://github.com/tailscale/tailcat/tree/v0.7.0)。

## 替换旧 Hub

基础 Gateway 与旧 Hub 是不同的服务。推荐保留已投入使用的 Gateway 主地址、节点子域名和安装地址，将旧网站入口在反向代理中跳转到 Gateway。这样已有邀请、节点身份和浏览器源站不用迁移；原有外部登录策略也可以保留。不要只把旧域名代理到 Gateway：服务会按配置的主地址校验 Host 和 Origin。

按以下顺序退役旧部署：

1. 备份旧 Hub 数据、Compose 配置以及各节点的 Profile；数据库停止写入后再做一致性备份。
2. 用实际网页和会话列表检查 Gateway 及每个在线节点。确认没有运行中的任务，再安排必要的节点重启。
3. 配置旧入口跳转，验证登录边界、目标网页和安装脚本，再停止旧 Hub。
4. 检查旧容器是否包含 Gateway 正在使用的 DSH Runtime。共享 Runtime 应迁到独立节点部署，保留原镜像、用户、状态卷和连接文件；不要连同旧 Node Agent 一起删除。
5. 从节点的 `dsh.profile.bundles` 中移除旧 `@k1412/dsh-hub-connector`，保留 `@k1412/dsh-gateway-node`。停用旧 Node Agent 的服务和自启；移除旧容器及旧 Compose 自启项目，不删除节点会话、模型配置或持久数据。
6. 再次核对节点 ID、会话数量、网页和原生会话列表。离线节点要单独记录，待其可达后清理；不能把在线节点检查称为全部设备已完成。

旧 Hub 数据备份是回退资料，不是 Gateway 的运行依赖。退役操作不会把旧 Hub 的数据库导入基础版；会话继续由对应节点的原生 DSH 保存和提供。
