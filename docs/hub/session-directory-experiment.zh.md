# 可运行的会话目录实验版

英文镜像：[Runnable session-directory experiment](session-directory-experiment.md)。

本分支提供最小节点网关的可运行扩展：需要认证的 `/sessions` 目录，以及在各节点**完整官方 DSH Web 客户端**中打开指定会话的导航。初版节点网关仍作为基线。只有设置 `DSH_GATEWAY_SESSION_DIRECTORY=1` 才开启实验功能；开启后主页显示简洁的实验目录入口。测试不会部署。

保留单操作者完整权限、节点独立源站、Tailscale/Tailcat 接入和节点主动出站边界。不创建第二个 Runtime，也不暴露本地 Web 监听器。Hub 保留认证/配对状态和少量短期目录元数据，不保留模型凭据、对话历史或快照。不实现自定义聊天、权限、模型选择界面，也不翻译业务载荷。

## 运行与安装

使用 Node 22.19+ 和仓库的 pnpm 11.7.0。执行 `pnpm run build`，生成 `dist/gateway/server.mjs` 和可安装的 `dist/gateway/downloads/gateway-node.tgz`，其中包含通过官方注册机制加载的客户端导航插件。沿用现有网关认证/网络配置，启动时设置：

```sh
DSH_GATEWAY_SESSION_DIRECTORY=1 node dist/gateway/server.mjs
```

功能默认关闭。`/sessions` 使用与节点列表相同的操作者授权。实验邀请清单声明节点能力；生成的安装命令使用独立实验状态目录及 `--instance gateway-node-experiment`。安装后重载**已有** DSH Runtime。支持的已安装 DSH 版本严格限定为 `0.1.7-rc.2`；版本或能力不匹配会显示该节点不可用。

同一 Runtime 连接两个 Hub 的操作步骤：

1. 保留主 Hub 连接及其现有 profile 条目和配置。
2. 以相同 Runtime 用户执行实验 Hub 生成的安装命令，使用相同 `--profile`、**不同**的 `--state-directory` 和 `--instance gateway-node-experiment`。不要复用主连接文件、身份或网络状态目录。
3. 安装器保留主连接的托管 YAML 块，加入独立命名 Loader 条目，指向它自己的 connectionFile。两个条目使用同一个兼容的节点包和相同 Runtime 服务。实验节点包仍兼容只有节点列表的网关。
4. 重载该 Runtime 一次，两个出站通道同时工作，不需要第二个 DSH 进程。首次仅安装命名实例时，会禁用尚未配置的默认条目；重新安装主条目会显式启用它。
5. 停止实验时，仅禁用/删除实验命名条目，重载同一个 Runtime，并在实验 Hub 撤销该节点。主条目仍在使用共享插件包时，不要卸载该包。

安装器拒绝覆盖属于其他 Hub 的状态目录，并保留现有 profile 原始 YAML/JS 表达式。安装器和实验都不启动第二个 Runtime。网络配置仍使用已有的 Tailscale/Tailcat 实现。

## 实际原生列表调用

服务端通过所属节点现有的 `GatewayTunnel.fetch` 调用发布版 rc.2 Typert Remote `session/list`。原生 HTTP 载体保持不变：`POST /api/session/list`，请求为：

```json
{"type":"client-request","rpcId":"unique-request-id","method":"session/list","payload":{"args":{"_request":{}}}}
```

响应必须是匹配 `rpcId` 的 `server-response`，并包含成功的 `RemoteResult.value.items`。这与生成的 `@deepseek-ai/dsh-api-session-controller/lib/typert.host.js` 中 `_request` 参数、远程声明和真实 Runtime 实现一致。Hub 不引入替代会话业务 API。原生列表读取不会恢复 Agent。

请求与响应绑定明确的节点 ID、Runtime ID 和每次连接新生成的随机代次。替换、撤销、关闭连接会使目录缓存和正在进行的快照失效。所有调用者共用**最多 8 个节点目录读取任务**的准入上限，不建立无界等待队列；每页也最多同时扇出 8 个节点。每个已派发节点超时为 3 秒。响应在 JSON 解码前限制为 **8 MiB**；取消会取消 Tunnel 响应流。节点错误使用固定状态，不显示原生异常详情；部分节点失败不影响健康节点显示。

目录同时通过已有原生 mux 读取 `workspace/follow` 的首个 baseline，提取 `archivedSessionIds`，随后发送 cancel 并关闭该 mux；快照帧上限为 256 KiB，受同一节点的 3 秒时限约束。rc.2 没有 `workspace/list` HTTP 接口。归档投影读取失败时，该节点目录明确报错，不能把未知归档状态当成可打开。

目录仅保留 `sessionId`、可选 `projections.values.title`、`updatedAt`、`running`、`agentAvailable` 和从工作区快照得到的 `archived` 标志。缺失标题显示 ID。路径和其他投影提示立即丢弃，不持久化也不渲染。不调用模型、配置或历史 API。空闲/无存活 Agent 对应原生标志，后者不等于已归档。

缓存 TTL 为 2 秒（可配置上限 5 秒），由定时器删除；默认每节点保留 10,000 行，最多 64 个目标。渲染前再次检查成员、Runtime 和连接代次。原生会话变更在短 TTL 后可见，连接/成员变更立即失效。不订阅历史或控制流，也不保留工作区 follow 订阅。

**rc.2 原生列表没有分页。** 声明的请求游标被忽略，结果也没有续页游标。显示分页只能在保留的元数据上完成，默认 50 行、最多 200 行。截断和节点状态均明确显示。活动变化可能移动 offset 页，不保证快照一致性。网络读取和临时解析仍随完整原生列表增长，直到触及字节上限。`session/page` 是对话历史接口，不是目录分页，本目录从不调用它。

## 精确原生会话点击

没有找到上游原生会话 URL 路由。本实验实现的是**明确的插件导航入口**，而不是猜测上游 hash/query 约定：

1. 已归档的会话仍显示在目录中，明确标记归档且不生成会话深链；需要在所属节点的原生 DSH 中主动恢复后才能打开。目录不会自动取消归档。可打开的目录行链接至所属节点的 `/_hub/open-session`，携带明确的 Runtime、连接代次和会话身份。Gateway 经操作者认证及一次性节点认证票据打开目标，并保留导航意图。
2. 票据关联有界、仅内存保存的 intent。已认证节点页面获得不透明 `gatewayIntent` 键；`/_hub/session-intent` 仅向相同节点、仍在线且 Runtime/代次匹配的访问返回意图。有效期 5 分钟，最多 512 项。意图数据不进入数据库。
3. 额外的节点客户端模块通过官方 `dsh.client` 元数据及 `window.__ModuleLoader__` 注册。它等待公开的 `sessions.list`、`workspaces.list` 就绪快照，刷新原生列表、检查成员和归档状态，并保留精确会话/地址，直到原生历史打开完成。
4. 再次校验归档状态、intent 和原生连接代次，通过 `layout.beginNavigation()` 取代启动时的工作区导航，再调用已导出的 `ctx.uiWorkspace.openSession(target)`，确认目标拥有 `mainView`。不写私有 store、不用 DOM 模拟切换会话、不修改上游。
5. 成功后移除临时查询参数，刷新页面由官方客户端恢复已保存的选择。会话不存在、票据/意图过期、Runtime/代次变化、断线或打开失败均明确报错。仅负责导航的阻挡提示防止启动时其他对话被误认为目标；它不是聊天界面。确认选择后显示完整原生编辑器和历史。

Host 激活对可选的 `appReady`、`webServer` 使用公开 `ctx.get()`；受作用域约束的 Cordis Context 会拒绝未声明的直接属性访问。已测试同一个 Runtime 中两个命名 Host 插件实例与一个共享浏览器模块。

## 验证与测量

```sh
pnpm run check
pnpm run build
DSH_NATIVE_ROOT=/path/to/installed-rc2 DSH_NATIVE_BROWSER=chromium pnpm run gateway:session:native
DSH_NATIVE_ROOT=/path/to/installed-rc2 DSH_NATIVE_BROWSER=webkit pnpm run gateway:session:native
pnpm exec tsx packages/hub/gateway-session-directory/src/benchmark-cli.ts
```

原生验证需要包含 `node_modules/@deepseek-ai/dsh` 且版本为 `0.1.7-rc.2` 的目录。CI 安装该精确发布版本，构建发行包，再执行浏览器验证；可用 `DSH_DIRECTORY_REPORT` 指定 JSON 报告路径。不发生付费模型调用。

真实验证复用了原生网关 smoke test 的完整 Runtime 设置，启动两个隔离的发布版 Runtime；每个加载完整官方浏览器插件组、一个实验客户端模块、**两个真实命名 Gateway 插件激活实例及独立 connectionFile**，并发连接基线/实验 Hub。仅将 overlay 网络拨号和推理替换为本机 WebSocket 通道与模型 fixture。Runtime 服务、原生 RPC、打包的客户端插件、浏览器、权限/模型控件及持久历史均为真实实现。

覆盖归档首行不生成深链、旧归档链接明确拒绝且不修改归档状态、随后正常会话跳转、多节点相同会话 ID、目录/票据认证、错误目标与旧 intent 拒绝、原生响应大小/取消限制、缺失会话显式报错、Full access/模型选择、fixture 消息、多次精确历史点击和刷新、手机布局、离线部分结果及五轮重连。节点基线与实验版使用相同 Runtime 对、浏览器视口和 fixture 历史测量。基线是同一候选服务端/节点包的功能关闭模式（含未触发的导航模块），不是已部署初版发行物的基准。单元/集成测试还覆盖全局准入、协议/请求关联校验、安装共存、缓存和传输隔离。40,000 会话的合成工具仍单独标记，不能称为真实 DSH 延迟。

私有交付证据记录精确时间、样本数、检查结果和环境。这些是**经 loopback 的真实本地 Runtime/浏览器测量**，不是生产 Tailscale/Tailcat 或 NAS 数据。首次浏览器和历史样本较少，结果是观测，不是生产 SLO。真实 overlay 稳定性、生产数据规模和部署验收仍需根工作流后续验证。

## 维护成本

不需要持久 Hub 会话索引：按需原生列表加短期元数据缓存，消除了索引迁移、同步对账、删除标记和历史保留。代价是完整列表读取、扇出尾延迟、没有离线目录或稳定全局游标，以及小型固定版本原生载体适配器和官方客户端导航插件。浏览器直接扇出会将跨源认证、CORS 和生命周期复杂度转移至浏览器。保持本实验明确标记，并与维护成本更低的节点基线分开。

## 基础版同步与当前限制

实验版已纳入基础 Gateway `fd110b2fe4`：带有超时上限与校验和检查的流式安装器下载、运行镜像 CA 证书、实际安装原生客户端的 Chromium/WebKit CI、符合条件的静态代码 gzip，以及仅用于原生版本化资源的私有不可变缓存。命名实例安装、会话意图和目录鉴权继续保留。CI 同时在 Chromium 与 WebKit 运行基础原生浏览器测试和实验双 Runtime 测试。

双实例测试现在拒绝重复客户端图 ID，并要求恰好一个实验导航模块。两个命名 Gateway 激活均不注册 HMR 服务。测试禁用了官方 `client-hmr` 的 host 文件监听。基础修复 `4720972a83` 直接通过共享的公共 `clientModules.graph/onGraphChanged/onRebuilt` registry 提供 `/plugins/events`。每条 SSE 自行持有订阅、有界队列和清理逻辑；没有新增 host watcher 或 Web listener。已固定发布版 rc.2 `PluginsEventFrame` 类型开发依赖及 lockfile。

WebKit 保留与 Chromium 相同的手机宽度、精确会话、浏览器零错误及五轮重连断言。其可选目录截图改存 HTML 证据，因为 Playwright 的 WebKit 截图准备会注入内联样式，被目录 CSP 拒绝。产品 CSP 保持不变。本地实测结果及其与真实覆盖网络、部署性能的区别记录在私有交接报告中。

基础版同步后的本地复验：两种浏览器均通过，浏览器错误为零，重连各为 5/5；每次使用两个真实 rc.2 Runtime，每个 Runtime 有两个命名连接。完整 check 通过 284 项测试（跳过 3 项可选测试），build 通过。下表为本地回环 p95 毫秒，模型推理为 fixture；样本较少且本地同时运行其他检查，不能据此声称生产性能或加速。

| 指标 / Metric | n | Chromium p95 ms | WebKit p95 ms |
|---|---:|---:|---:|
| 目录页面 / Directory page | 15 | 23.00 | 24.77 |
| 双节点并发 listing / Two-node concurrent listing | 15 | 3.93 | 8.02 |
| 关闭功能的历史打开 / Feature-disabled history open | 6 | 222.22 | 475.58 |
| 指定历史点击 / Exact history click | 6 | 355.66 | 555.66 |
| 重连后历史点击 / History click after reconnect | 5 | 401.27 | 570.99 |

SSE gate 使用两个真实 Runtime 和各自同时连接的两个 Hub tunnel，检查初始 graph 一致、实际临时产物重建通知、取消与断线隔离，以及重连后的完整当前 graph。另一个真实 carrier 测试使用缩短为 150 ms 的时限验证生产 HTTP deadline 路径：到期只释放该流，重新打开会发送 graph。生产仍保留 120 秒 HTTP deadline；原生 EventSource 重连后获取最新完整 graph，不保留事件重放缓冲。本地 gate 未等待完整 120 秒，也不声称实测了原生浏览器自动重连时间。端到端文件监听仍由既有 Runtime 负责。

SSE 同步后的 Chromium 与 WebKit 复验均通过：两份报告的 `sseIsolationPassed=true`，浏览器错误为零，目录各完成五轮重连。双 Runtime / 双 Hub SSE 隔离场景耗时分别为 49.33 ms (chromium) / 78.47 ms (webkit)。这是单样本本地场景耗时，不是单个事件延迟，也不是真实覆盖网络测量。
