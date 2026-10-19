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

多个 Hub 可以连接同一个现有 Profile/Runtime。实验连接必须使用独立 `--state-directory`、`--instance` 和 `--package-alias`，保留基础连接的包、身份与配置。例如：

```sh
curl -fsSL https://experiment-hub.example/install.sh -o /tmp/experiment-install.sh
sh /tmp/experiment-install.sh --hub https://experiment-hub.example --invite TOKEN --profile web --instance gateway-node-control --package-alias @k1412/dsh-gateway-node-control --state-directory "$HOME/.local/state/dsh-gateway-control" --control
```

安装器先校验下载归档，再生成私有 `file:` 副本，使包的实际名称等于指定别名，会话浏览器模块也以同一名称注册。这避免 pnpm hoisted 布局按基础包名称和版本去重不同实验代码。激活前逐项核对已安装 Runtime、CLI、manifest 与浏览器文件；内容不符则恢复 Profile 文件并拒绝激活。实验依赖不进入 Profile 的 bundle 列表。安装器直接插入独立 Cordis Loader 条目，其模块路径指向该 Profile 下别名包的 `lib/index.js`。rc.2 的浏览器模块扫描会忽略 manifest 名称不同的裸别名；绝对模块路径使用官方支持的 package 定位方式，使会话导航客户端只注册一次。重装命名条目时保留其额外配置，包括委派工作区与允许包列表。省略新选项时保留原安装行为。更改后按现有服务机制重载同一个 Runtime。

移除实验时先仅删除相应 `# BEGIN DSH GATEWAY INSTANCE gateway-node-control` 到 `# END DSH GATEWAY INSTANCE gateway-node-control` 的受管条目，再在该 Profile 目录用其包管理器移除 `@k1412/dsh-gateway-node-control` 依赖并重载原 Runtime。保留基础条目、基础依赖以及其他连接的状态目录。Hub 不保存模型配置或凭据。

以下是**手工发布验收 gate**，需要完整、隔离的 DSH rc.2 代码树，以及分别构建的基础版、会话实验版和控制实验版归档；控制版归档先运行 `pnpm run build` 生成。该 gate 不属于自动 CI 步骤。官方 CLI 先复现并修复 hoisted 三包去重冲突，再在同一个临时 Runtime 加载三条连接，核对委派能力就绪和隔离卸载。每个浏览器先在基础连接通过正常 Continue 确认首次访问提示；上游将确认状态保存在同一个 Runtime，后续会话/控制 origin 必须直接进入稍后配置 provider 步骤，而不重复弹窗。Chromium 与 WebKit 通过正常稍后配置 provider、指针聚焦和键盘输入创建**未发送**草稿。仅中断自有 fixture 连接前，必须存在一个可见会话，且原生 `dsh.conversation.<sessionId>` 镜像属于该会话并保存精确草稿；恢复后核对 connector、浏览器 mux、同一会话和草稿、未提交轮次状态，以及其他连接未受影响。独立 reader 还会读取真实 `/plugins/events` SSE 的切断前 graph、确认旧流结束，再读取恢复后的新 graph；不宣称浏览器 EventSource 自动恢复。

```sh
export DSH_NATIVE_ROOT=/path/to/isolated/dsh/node_modules/@deepseek-ai/dsh
export DSH_GATEWAY_BASELINE_PACKAGE=/path/to/base/gateway-node.tgz
export DSH_GATEWAY_SESSION_PACKAGE=/path/to/session/gateway-node.tgz
export DSH_GATEWAY_CONTROL_PACKAGE="$PWD/dist/gateway/downloads/gateway-node.tgz"
DSH_NATIVE_BROWSER=chromium pnpm exec tsx packages/hub/gateway-node/tests/coexist-native-smoke.mts
DSH_NATIVE_BROWSER=webkit pnpm exec tsx packages/hub/gateway-node/tests/coexist-native-smoke.mts
```

载体使用 loopback fixture，Profile 与连接状态位于私有临时目录，不调用模型推理。报告打印临时制品目录，并分别记录 connector、浏览器 mux 和原生流恢复耗时；这些结果不能代表公网延迟或 SLA。测试不使用生产 Profile 或宿主 Tailscale 身份。

大型原生历史消息会拆分为有界传输帧，重组后原样交给客户端。单条消息上限为 16 MiB，每个节点连接的队列预算为 32 MiB。启用大消息传输时应同时更新网关和节点插件；已有的小消息帧保持兼容。原生通道关闭时会明确关闭浏览器连接，避免历史一直处于加载状态。
