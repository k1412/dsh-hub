# Gateway 网络工具与验证

Hub 镜像包含固定的 Tailscale 1.102.4 和 Tailcat 0.7.0。两种工具的 Linux amd64/arm64 安装包都有固定 SHA-256，保存在镜像的 `/app/downloads` 中。节点安装命令按邀请中的方式选择工具，最终配对只经过选定的加密覆盖网络。应用不会探测局域网地址或追加局域网、公网回退路径。

普通容器使用独立的用户态 `tailscaled`，登录和身份保存在 Hub 状态卷中。`compose.host-tailscale.yaml` 复用宿主已经登录的 Tailscale：只读取状态，在其 Tailnet IP 上绑定独立入口，不调用宿主的 `up`、`login` 或 `serve`。Tailcat 在独立状态目录保存 Hub 和 node 的持久密钥，由官方工具管理直连与中继。

Linux amd64/arm64 可以自动下载和校验工具。macOS 当前复用已经安装的工具；Tailscale 必须先完成登录。节点 CLI 把插件安装到现有 DSH Profile，不创建第二个 DSH Runtime。

在仓库中运行以下命令准备工具并执行真实网络测试：

```sh
node deploy/gateway/download-network.mjs --directory /tmp/gateway-downloads --install-directory /tmp/gateway-tools --arch amd64
node deploy/gateway/smoke-network.mjs --mode all --bin-directory /tmp/gateway-tools --requests 40 --concurrency 4 --reconnects 3 --hub-restarts 1 --report /tmp/gateway-network-report.json
```

测试创建临时 Hub 网络身份和两个隔离的 node 连接实例，通过真实 Tailcat 与 Tailscale CLI 发出并发 HTTP 请求，校验内容和来源，并测试 node 重连及 Hub 网络进程重启。测试不修改宿主 Tailscale 配置；Tailscale 未登录时会明确失败。报告把首次握手、持续请求和恢复时间分别统计，包含 p50、p95、失败率和恢复次数。

这是连接层测试。两个 node 实例在同一台测试机器上；Tailscale 通过现有宿主的 `nc` 数据面访问本机 Tailnet IP，结果不能代表跨机器或公网延迟。测试服务计数保留也不能替代 DSH 历史、草稿或权限状态的验收。已保存的实测报告位于 `reports/network-local-2026-10-03.json`。

官方依据：[Tailscale 用户态网络](https://tailscale.com/docs/concepts/userspace-networking)、[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)、[Tailcat](https://github.com/tailscale/tailcat/tree/v0.7.0)。
