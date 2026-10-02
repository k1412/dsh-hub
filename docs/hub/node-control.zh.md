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
```

工作区须预先存在。仅要管理功能时省略 delegationWorkspace。重新加载现有
Runtime；不得为 Hub 再启动 Runtime，也不得暴露本地 Web listener。
委派要求原有 Runtime 提供 tools、agents、agentDefaultModel、sessions 和
sessionController；插件管理要求 pluginManager。验证目标为 DSH 0.1.7-rc.2。

在 Hub 节点详情打开实验管理页。清单仅显示安全字段；安装和更新必须明确版本，
安装只允许节点本地 trustedPackages 中的 registry 包，不允许任意 URL、路径或 git。
使用插件表和“检查版本”“安装 / 更新”按钮；状态、版本及启停/卸载操作直接显示，
协议详情折叠。授权有效期使用小时/天选项。连接插件及关键管理服务禁止自卸载。
所有修改使用官方 pluginManager，同官方 CLI 的 profile 持久化实现，保留原始 YAML。

## 作业与更新

同节点只运行一个管理修改作业，不同节点可以并行。请求 ID 是持久化幂等键；
相同 ID 改变参数会被拒绝。断链后刷新 inventory 查询作业，不能盲目重试。
本地 journal 保存有限摘要，重启时未结束作业标为 interrupted-review-required，
不会自动重放。安装取消由官方 cancelInstall 执行；启停和已进入应用阶段的修改
可能 too-late。官方安装失败/取消恢复 package.json 和 lockfile；不宣称所有移除
操作都可自动回滚。原始诊断只在节点查看。

所有 DSH 生命周期动作（包括版本检查和更新）都要求在线且公布 lifecycle 能力的
独立监督器，不会回退到 Runtime 内执行。npm 与 Docker 安装均遵守此要求。随仓库提供
[部署侧更新执行器](../../deploy/gateway/update-adapter.mjs)，在节点/部署主机运行，
通过独立监督器环境变量 DSH_UPDATE_CONFIG 指向仅管理员可写的 JSON 文件。配置包括：

- stateDirectory、approvedVersions：本地日志目录及明确批准版本列表。
- npm 模式：kind=npm，releases、current 为绝对路径，current 必须是已有 release
  的符号链接；npm、restart、verify 为以绝对可执行文件开头的 argv 数组。监督器
  从 current 的 DSH 启动；更新先独立安装、校验版本，再切换链接并重启验证。
  失败恢复旧链接，保留旧 release。verify 接收目标版本。
- Docker 模式：kind=docker，prepare、apply、verify、rollback 为部署侧固定 argv
  数组；prepare/apply/rollback 接收版本和作业 ID。部署者必须实现固定镜像来源、
  持久卷保留、单容器替换和健康检查。适配器自身不会在容器内执行 npm 更新。

监督器必须与 DSH 位于不同服务/cgroup，重启 DSH 才不会杀死负责验证和回滚的更新器。
监督器崩溃会保留锁；需在本机核对部署 journal、子进程和实际版本。Hub 不挂载 Docker socket。执行器和其配置必须仅由本机管理员维护。

## 委派权限与工具

创建 A→B 授权，指定两个 Runtime、目标授权工作区、能力和到期时间。
能力为 discover、task.start、task.read、task.cancel。反向权限需单独授权。
工具在 A 原生会话中注册，由官方 tools API 调用；来源会话取自执行上下文。
B 创建独立原生会话，使用 B 的本地模型选择与凭据。每个任务绑定来源节点、Runtime、
会话及目标工作区。跨会话读取、不同参数重放、递归委派均拒绝。工具输出标为不可信
远端内容，不应执行其中包含的指令。工作区是准入策略，**不是文件系统沙箱**；B 的
实际会话仍按本机权限运行，管理员应将目标节点视为被授权的完整执行环境。

授权每次调用及返回时复查。Hub 每 10 秒续租一次，前提是原始来源/目标连接、Runtime、
连接代次和授权仍有效。B 使用独立单调计时器，租约最长 30 秒。Hub 丢失或重启、源断联、
撤权均停止续租；B 请求协作取消并显示原因。长期 grant 不能替代短租约。重连不重发
提示词，也不通过幂等重放接管旧任务。事件循环阻塞或不协作的原生工具可能延迟实际
终止；此时任务保留活动槽位，显示 cancelRequested，直到真正空闲。

## 协议与资源

控制 RPC 在原有已认证 Tailscale 或 Tailcat 出站 WebSocket 上运行。双方通过
x-dsh-control=2 协商；不协商时不会发送控制帧。连接绑定 node、Runtime 和连接代次，
不接受来源节点自报身份。控制帧最多 64KiB，每侧最多 16 待处理调用、8 个执行中请求；
调用超时 30 秒，不自动重试写。原生流仍使用原窗口和通道界限。每个连接使用随机 nonce 和单调递增序号；
接收方只保留一个最高序号，永久拒绝该连接上的旧请求，内存不随调用数增长。
不再有同连接 10000 次请求的终身上限。目标委派最多 4 并发、256 个保留任务，
提示词 16384 字符、结果 32768 字符。准入时自动清理结束超过 7 天的元数据；
管理员清理按钮（task.cleanup）可移除结束超过 24 小时的记录。运行中任务及最少
24 小时幂等窗口内记录不会移除；256 条均受保护时拒绝新任务。原生历史仍由 DSH 管理。

## 验证

```sh
pnpm run gateway:test
pnpm run check
pnpm run build
DSH_NATIVE_ROOT=/path/to/installed-dsh pnpm exec tsx packages/hub/gateway-node/tests/delegation-native-smoke.mts
```

单元测试包含两个 carrier 的并行原生/控制流、方向/Runtime/代次/撤销校验、节点
作业隔离和恢复。原生测试使用已安装 DSH 与 fixture LLM，避免真实模型费用。
本地 carrier 延迟不代表 Tailscale/Tailcat 互联网延迟；另用真实 Tailcat helper 在同一测试主机验证；
这些测试不证明跨地域性能或生产部署就绪。

### 本分支已执行的原生验证

- 两个真实 rc.2 Runtime：A fixture 模型通过五次官方工具调用发现 B、启动任务、
  读回真实结果、再启动并取消；跨会话拒绝、中途撤销取消、目标重连后不重复执行。
  已分别使用本机认证 WebSocket 和真实 Tailcat 0.7.0 双节点 helper 执行；两端在
  同一测试主机，不代表跨地域网络。Tailscale 实网尚未重复验证本分支控制功能。
- 两个真实 pluginManager 和本地 fixture registry：并行安装不同版本、启停、更新、
  非 bundle 更新失败后恢复原版本、待重启期间拒绝继续修改、原 YAML 注释保留。
- 完整官方浏览器 smoke 已通过。Open in App 仍依赖上游 listener 专用端点，远程不可用。
- 12000 轮、24000 控制调用和同时进行的原生 fetch，另有 10026 次调用的旧请求重放回归。
  当前耗时和结果见交付报告。它是有界压力测试，不是数小时稳定性证明。数值随机器与并发负载变化。

```sh
DSH_NATIVE_ROOT=/path/to/installed-dsh pnpm exec tsx packages/hub/gateway-node/tests/control-native-two-runtime.mts
# 可选设置 GATEWAY_CONTROL_TAILCAT_BIN_DIR 指向已校验的 tailcat 所在目录
DSH_NATIVE_ROOT=/path/to/installed-dsh DSH_TEST_PNPM=/path/to/pnpm.cjs pnpm exec tsx packages/hub/gateway-node/tests/management-native-smoke.mts
CONTROL_SOAK_ROUNDS=12000 CONTROL_BENCHMARK_REPORT=/tmp/control-benchmark.json pnpm exec vitest run packages/hub/gateway-transport/tests/control.spec.ts
```

### 明确限制

整个 DSH 的首次安装、启停、重启和卸载使用可选的独立节点监督连接。未配置时 inventory
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

执行器配置另加 approvedActions（install、start、stop、restart、uninstall），缺少则拒绝。
install/update 的 target 为明确版本；start/stop/restart/uninstall 的 target 必须为 current。
npm install 要求 current 尚不存在，拒绝覆盖已有安装；npm 更新才允许替换现有链接。
Docker install 使用固定 prepare/install/verify 命令。其他动作使用固定同名命令；
start、stop 和 restart 必须控制**已有的同一个监督服务**，且 start 必须幂等，不能直接另起 dsh。
Hub 也拒绝对已在线 Runtime 再发 install/start。

随包的 [systemd 执行器](../../deploy/gateway/systemd-service-adapter.mjs) 可直接用于 Linux
用户服务。本机设置 DSH_SERVICE_UNIT 为原有 DSH unit、DSH_CURRENT_RELEASE 为 current
绝对路径；JSON 中 start/stop/restart/verify/uninstall 命令数组写该脚本绝对路径和对应
动作，例如 `["/usr/local/bin/dsh-service-adapter", "start"]`。该适配器通过 systemctl 操作
同一 unit；卸载停止服务并归档 current 链接，保留 profile 与旧 release。DSH 原有 unit
应从 current 启动。[监督器 user-unit 模板](../../deploy/gateway/dsh-gateway-supervisor.service)
需补充这两个环境变量和本机路径后安装，不能把 DSH unit 的停止传播给监督器。

插件管理与生命周期管理共享本机排他锁。进程崩溃后保留锁以阻止不确定重试；管理员可
通过 management.recover 请求监督器恢复，仅无遗留执行器风险的动作且记录的持锁 PID 已退出时才允许。插件安装和 DSH
生命周期操作即使 PID 已退出也必须在本机核对子进程和 journal。损坏锁或 PID 重用
同样需要本机核对。执行器另有自己的持久化日志/锁，
中断更新需本机核对 journal 和 current 后恢复。

## 管理持久化与执行器协议

节点对操作预留记录执行 fsync 后才开始副作用。磁盘版本、上游应用结果和活动代码是
不同字段；包安装成功不能证明 HMR 已应用。日志写入失败会锁定修改并显示
persistence-failed；后台失败不会抛出到 Runtime。“重试写入日志”仅重试持久化，
不重放操作。不可读取的 journal 必须本机修复并重新加载。完成状态在持久化成功后
才可见；restart-required 表示已安装但尚未生效。插件版本检查使用官方 inspect
元数据；已安装包则查询配置的 registry。成功安装须核对实际 manifest 版本；
损坏 bundle 恢复仅核验磁盘版本并保留重启围栏。安装成功后的 HMR 应用错误不会再次
触发嵌套 HMR 回滚；活动代码版本保持明确未验证。

随附执行器向 stdout 输出一条 JSON：check 返回 availableVersion，install/apply
返回 installedVersion，均须等于明确目标版本。Docker check/verify 命令必须分别
报告可用镜像和实际运行安装的 `{ "version": "0.1.7-rc.2" }`；仅退出零不算版本核验。
Docker 首次安装失败会调用显式 cleanup argv；缺少时为 manual-recovery-required
并保留锁。不会在未调用 rollback 时报告 rolled-back。部署者必须让 cleanup 和
rollback 验证其执行后的部署状态。

管理执行器超时后继续运行但节点保持锁定，重启后仍要求本机核对。adapter 命令超时
可能遗留子进程，因此保留自身锁，不与潜在子进程并发回滚。停止/核对所有更新器后代，
检查两份 journal 和已安装版本后才能本机移除旧锁；不能仅以 Gateway PID 消失为依据。
修改作业默认超时五分钟，adapter 命令默认四分钟。此保守恢复策略优先避免并发更新。

## 受控重启与活动任务准入

“受控重启 DSH”由独立监督器对原服务执行批准的 restart 动作。在 approvedActions
增加 restart 并配置命令数组（systemd 适配器已支持）。插件更新后不会自动重启或取消
任务。stop/update/restart/uninstall 在原生任务或 maintenance 活动时一律拒绝；本版
不提供强制中断按钮。离线或不支持 admission 能力的旧 Runtime 不能批准这些操作。
start/install 仍按独立的幂等服务语义执行。

Runtime 先预留现有共享 management.lock，再通过公开 agents.list()、Agent.status
及有界 Agent.whenIdle() 检查静默状态。同一锁保护 Hub task.start 准入和插件操作。
监督器接管该请求的 prepared token，并在执行期间保留围栏。公开 agent/pre-step 在
已批准维护期间拒绝新模型 step。它防止 Hub 自有操作竞态，**不是全 Runtime 冻结**；
任意本机管理员 CLI、原生插件 UI 使用自己的上游锁，无法由此原子串行化。未调用私有
agent registry API，也未修改上游 core。workspace 始终是任务 cwd 策略，**不是沙箱**。

start/install/update/restart 后，作业保持 awaiting-runtime-verification，直到同一已认证
node/Runtime 以新连接 generation、新进程身份和目标 DSH 版本上线，才释放围栏。
原进程仅断线重连不足以验证。Hub 重连后可继续验证持久化待确认作业；执行器状态不明
仍需本机核对。

插件 changed:true、exitCode 0 或 application:restart-required 都不代表活动代码已更新。
磁盘已有目标包而 HMR 失败时，显示 restart-required 并保留围栏。损坏 bundle 可由官方
安装器恢复旧磁盘版本，但只报告 disk-restored-active-unverified，仍需显式重启。新
Runtime 握手证明 Runtime 已重启，不能凭空提供 rc.2 缺失的通用活动插件版本字段。
活动代码需插件自身的实时服务证据验证，否则 inventory/SSR 明确显示未知。

真实 Remote/HMR 回归通过 Connection Fetch + Typert Remote，在公开 hmr.runExclusive
外层作用域中安装实际 fixture。原生嵌套 HMR 错误后，磁盘为 1.0.1、活动代码仍为 1.0.0；
完整释放原 Runtime 后，在新进程启动同一 profile，验证活动代码为 1.0.1。此有界复现
需要显式外层 HMR 作用域；普通 Remote 单独调用未复现生产中该作用域的来源。官方 core
模块哈希保持不变。

```sh
DSH_NATIVE_ROOT=/path/to/installed-dsh pnpm exec tsx packages/hub/gateway-node/tests/lifecycle-native-smoke.mts
DSH_NATIVE_ROOT=/path/to/installed-dsh DSH_TEST_PNPM=/path/to/pnpm.cjs pnpm exec tsx packages/hub/gateway-node/tests/management-remote-native-smoke.mts
```

活动检查测试同时保持真实普通原生任务、委派模型流和原生 maintenance，断言拒绝且不
取消，并用无服务副作用的本机监督器 fixture 验证共享准入。未停止生产服务。模型的
sourceSession 只取自官方工具执行 Agent，参数不能覆盖；read/cancel 同时校验来源节点、
Runtime、会话和目标 Runtime/workspace。管理方法只供 operator，peer dispatch 一律拒绝。
