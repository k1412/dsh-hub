# 实验：节点管理与原生委派

本分支在独立 SSR Gateway 上增加管理页 `/control/<nodeId>` 和授权页
`/control/grants`。仍由单一管理员完全控制；节点之间默认拒绝。
Hub 不加载模型，不持有模型凭据，不保存任务提示词、结果或会话历史。
旧节点显示不支持控制，普通原生 UI 的协议仍为版本 1。

## 安装与运行

先按 [Gateway 部署指南](gateway-design.zh.md) 构建和配对节点。
`pnpm run gateway:build` 生成 `dist/gateway/server.mjs` 和
`dist/gateway/downloads/gateway-node.tgz`。更新现有节点插件后，在其原有
Cordis 配置中为 `gateway-node` 设置：

```yaml
control: true
delegationWorkspace: /srv/delegated
trustedPackages:
  - example-dsh-plugin
# updateExecutor: /usr/local/bin/dsh-update
```

工作区须预先存在。仅要管理功能时省略 delegationWorkspace。重新加载现有
Runtime；不得为 Hub 再启动 Runtime，也不得暴露本地 Web listener。
委派要求原有 Runtime 提供 tools、agents、agentDefaultModel、sessions 和
sessionController；插件管理要求 pluginManager。验证目标为 DSH 0.1.7-rc.2。

在 Hub 节点详情打开实验管理页。清单仅显示安全字段；安装和更新必须明确版本，
安装只允许节点本地 trustedPackages 中的 registry 包，不允许任意 URL、路径或 git。
检查操作为 `management.check`，安装为 `management.submit / plugin.install`。
启停使用清单的 entryId；移除使用包名。连接插件及关键管理服务禁止自卸载。
所有修改使用官方 pluginManager，同官方 CLI 的 profile 持久化实现，保留原始 YAML。

## 作业与更新

同节点只运行一个管理修改作业，不同节点可以并行。请求 ID 是持久化幂等键；
相同 ID 改变参数会被拒绝。断链后刷新 inventory 查询作业，不能盲目重试。
本地 journal 保存有限摘要，重启时未结束作业标为 interrupted-review-required，
不会自动重放。安装取消由官方 cancelInstall 执行；启停和已进入应用阶段的修改
可能 too-late。官方安装失败/取消恢复 package.json 和 lockfile；不宣称所有移除
操作都可自动回滚。原始诊断只在节点查看。

DSH 更新默认 external-update-required，包括 Docker 内安装。随仓库提供
[部署侧更新执行器](../../deploy/gateway/update-adapter.mjs)，在节点/部署主机运行，
通过节点环境变量 DSH_UPDATE_CONFIG 指向仅管理员可写的 JSON 文件。配置包括：

- stateDirectory、approvedVersions：本地日志目录及明确批准版本列表。
- npm 模式：kind=npm，releases、current 为绝对路径，current 必须是已有 release
  的符号链接；npm、restart、verify 为以绝对可执行文件开头的 argv 数组。监督器
  从 current 的 DSH 启动；更新先独立安装、校验版本，再切换链接并重启验证。
  失败恢复旧链接，保留旧 release。verify 接收目标版本。
- Docker 模式：kind=docker，prepare、apply、verify、rollback 为部署侧固定 argv
  数组；prepare/apply/rollback 接收版本和作业 ID。部署者必须实现固定镜像来源、
  持久卷保留、单容器替换和健康检查。适配器自身不会在容器内执行 npm 更新。

监督器重启可能结束调用进程，因此节点摘要可能显示 interrupted；以部署侧 journal
和实际版本为准。Hub 不挂载 Docker socket。执行器和其配置必须仅由本机管理员维护。

## 委派权限与工具

创建 A→B 授权，指定两个 Runtime、目标授权工作区、能力和到期时间。
能力为 discover、task.start、task.read、task.cancel。反向权限需单独授权。
工具在 A 原生会话中注册，由官方 tools API 调用；来源会话取自执行上下文。
B 创建独立原生会话，使用 B 的本地模型选择与凭据。每个任务绑定来源节点、Runtime、
会话及目标工作区。跨会话读取、不同参数重放、递归委派均拒绝。工具输出标为不可信
远端内容，不应执行其中包含的指令。工作区是准入策略，**不是文件系统沙箱**；B 的
实际会话仍按本机权限运行，管理员应将目标节点视为被授权的完整执行环境。

授权每次调用及返回时复查。撤销后立即禁止后续读取，Hub 尝试取消其追踪的运行任务；
离线目标重新连接后重试取消。授权到期由 250ms 扫描处理。Hub 重启不保留任务内容或
运行任务追踪表；此时目标自身的 10 分钟运行上限仍有效，不能承诺立即取消旧任务。

## 协议与资源

控制 RPC 在原有已认证 Tailscale 或 Tailcat 出站 WebSocket 上运行。双方通过
x-dsh-control=1 协商；不协商时不会发送控制帧。连接绑定 node、Runtime 和连接代次，
不接受来源节点自报身份。控制帧最多 64KiB，每侧最多 16 待处理调用、8 个执行中请求；
调用超时 30 秒，不自动重试写。原生流仍使用原窗口和通道界限。控制记录仅留内存，
同连接最多接受 10000 请求，之后需重连。目标委派最多 4 并发、256 个保留任务，
提示词 16384 字符、结果 32768 字符；到达保留上限需本机归档。

## 验证

```sh
pnpm run gateway:test
pnpm run check
pnpm run build
DSH_NATIVE_ROOT=/path/to/installed-dsh pnpm exec tsx packages/hub/gateway-node/tests/delegation-native-smoke.mts
```

单元测试包含两个 carrier 的并行原生/控制流、方向/Runtime/代次/撤销校验、节点
作业隔离和恢复。原生测试使用已安装 DSH 与 fixture LLM，避免真实模型费用。
本地 carrier 延迟不代表 Tailscale/Tailcat 互联网延迟；实际网络、长时运行与部署侧
更新需在独立测试环境进一步验证，禁止据此宣称生产就绪。

### 本分支已执行的原生验证

- 两个真实 rc.2 Runtime：A fixture 模型通过五次官方工具调用发现 B、启动任务、
  读回真实结果、再启动并取消；跨会话拒绝、中途撤销取消、目标重连后不重复执行。
  已分别使用本机认证 WebSocket 和真实 Tailcat 0.7.0 双节点 helper 执行；两端在
  同一测试主机，不代表跨地域网络。Tailscale 实网尚未重复验证本分支控制功能。
- 两个真实 pluginManager 和本地 fixture registry：并行安装不同版本、启停、更新、
  非 bundle 更新失败后恢复原版本、只卸载 A、原 YAML 注释保留。
- 完整官方浏览器 smoke 已通过。Open in App 仍依赖上游 listener 专用端点，远程不可用。
- 9000 轮、18000 控制调用和同时进行的原生 fetch：约 52 秒、零错误、结束时无
  待处理请求。它是有界压力测试，不是数小时稳定性证明。数值随机器与并发负载变化。

```sh
DSH_NATIVE_ROOT=/path/to/installed-dsh pnpm exec tsx packages/hub/gateway-node/tests/control-native-two-runtime.mts
# 可选设置 GATEWAY_CONTROL_TAILCAT_BIN_DIR 指向已校验的 tailcat 所在目录
DSH_NATIVE_ROOT=/path/to/installed-dsh DSH_TEST_PNPM=/path/to/pnpm.cjs pnpm exec tsx packages/hub/gateway-node/tests/management-native-smoke.mts
CONTROL_SOAK_ROUNDS=9000 CONTROL_BENCHMARK_REPORT=/tmp/control-benchmark.json pnpm exec vitest run packages/hub/gateway-transport/tests/control.spec.ts
```

### 明确限制

整个 DSH 的首次安装、启停和卸载使用可选的独立节点监督连接。未配置时 inventory
明确返回 external-supervisor-required。监督器没有 Runtime 或 Web listener，也不能委派任务；
它与原生连接分别按已认证 node/Runtime 路由。停止 DSH 不会断开监督器。
`installation: npm` 可由节点管理员显式声明；检测到 Docker 时优先按 Docker 处理，
未知安装方式为 external。DSH 的 check 操作需选择 dsh.update：npm 执行器读取固定官方
registry 的精确版本；Docker 配置必须额外提供 check 命令。权限审计摘要在 `/control/audit`，
仅保存操作、节点、请求 ID 和时间，最多 10000 条。控制握手同时公布 management/delegation
能力；未配置委派工作区的节点不公布 delegation。目标自身也按授权到期时间取消任务，
不依赖 Hub 始终在线。


## 可选常驻监督器

使用包内同一 CLI，不需要额外 Runtime：

```sh
node package/lib/cli.js pair-supervisor --manifest enrollment.json --state-directory /srv/gateway-state --bin-directory /srv/gateway-bin --runtime-id default
DSH_UPDATE_CONFIG=/srv/gateway-state/update.json node package/lib/cli.js supervise --connection-file /srv/gateway-state/connection.json --runtime-id default --update-executor /usr/local/bin/dsh-update
```

enrollment.json 是现有邀请接口返回的 manifest；只经其选定的 overlay 配对。已有节点可
直接复用 connection.json，省略 pair-supervisor。全新机器可先配对监督器，再从 Hub
执行 dsh.install；安装后的 profile 和 gateway 插件仍使用官方 CLI 初始化与加载，不能
为此并行启动另一个 Runtime。默认 Runtime ID 必须与后来加载的插件一致。

执行器配置另加 approvedActions（install、start、stop、uninstall），缺少则拒绝。
install/update 的 target 为明确版本；start/stop/uninstall 的 target 必须为 current。
npm install 要求 current 尚不存在，拒绝覆盖已有安装；npm 更新才允许替换现有链接。
Docker install 使用固定 prepare/install/verify 命令。其他动作使用固定同名命令；
start 和 stop 必须控制**已有的同一个监督服务**，且 start 必须幂等，不能直接另起 dsh。
Hub 也拒绝对已在线 Runtime 再发 install/start。

随包的 [systemd 执行器](../../deploy/gateway/systemd-service-adapter.mjs) 可直接用于 Linux
用户服务。本机设置 DSH_SERVICE_UNIT 为原有 DSH unit、DSH_CURRENT_RELEASE 为 current
绝对路径；JSON 中 start/stop/restart/verify/uninstall 命令数组写该脚本绝对路径和对应
动作，例如 `["/usr/local/bin/dsh-service-adapter", "start"]`。该适配器通过 systemctl 操作
同一 unit；卸载停止服务并归档 current 链接，保留 profile 与旧 release。DSH 原有 unit
应从 current 启动。[监督器 user-unit 模板](../../deploy/gateway/dsh-gateway-supervisor.service)
需补充这两个环境变量和本机路径后安装，不能把 DSH unit 的停止传播给监督器。

插件管理与生命周期管理共享本机排他锁。进程崩溃后保留锁以阻止不确定重试；管理员可
通过 management.recover 请求监督器恢复，只有记录的持锁 PID 已退出时才允许。损坏锁、
仍存活或 PID 重用时需在节点检查，不自动冒险删除。执行器另有自己的持久化日志/锁，
中断更新需本机核对 journal 和 current 后恢复。
