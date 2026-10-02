# 会话目录实验

英文镜像：[Session directory experiment](session-directory-experiment.md)。

本可选实验在最小节点网关上增加服务端渲染的元数据目录，保留单操作者完整权限、Tailscale/Tailcat 接入、节点主动出站传输，以及每个节点已有的唯一 Runtime。每个节点的完整官方 Web 客户端仍使用独立网关源站，不暴露本地 DSH Web 监听端口。不实现自定义聊天、权限、模型、凭据或历史界面，不提交提示词，不建立持久会话索引或历史快照。

## 已检查的原生契约

兼容范围是**严格的 `0.1.7-rc.2`**，还必须显式声明 `sessionList` 能力。其他版本在审查前拒绝使用。这是实验兼容范围，不保证预发布 API 稳定。

- `@deepseek-ai/dsh-api-session-controller` 发布 Typert `session/list`，也可通过 `remote.session.list({}, signal)` 调用。远程返回 `RemoteResult<SessionListValue>`，由网关适配器解包成功值或抛出失败；`SessionListValue` 包含 `items`。
- 声明中存在 `SessionListRequest.cursor`，但已检查的实现忽略请求并返回全部可见会话；**没有响应续页游标，也没有有效的原生分页**。列表读取不会恢复 Agent。原生 `session/page` 是对话历史分页，目录不得使用。
- 每项提供 `sessionId`、`updatedAt`、`running`、`agentAvailable`；可选的 `projections.values.title` 为字符串或 null。缺失标题保持未知，界面显示会话 ID。投影提示可能来自缓存或已经过时；目录不会补读投影或历史。
- 目录仅保留上述字段，丢弃路径、其他投影、提示词、凭据和完整历史。运行中、空闲、无存活 Agent 对应原始标志；无存活 Agent 不代表已归档。

证据来自已发布包的 `lib/typert.remote-client.d.ts`、`lib/types/types.d.ts`、`lib/index.js`，`@deepseek-ai/dsh-session-title` 的标题类型，以及官方 Web 启动和客户端导航源码。上游稀疏源码只作补充证据，不作为版本权威。

## 导航的确切限制

在已检查的发布版前端和可用官方源码中，没有找到原生会话 URL 路由。官方客户端确实提供 `ctx.uiWorkspace.openSession(target: SessionTarget): void`，声明位于 `@deepseek-ai/dsh-client-ui-workspace` 的 `lib/types/client/navigation.d.ts`。这是客户端插件服务，**不是 HTTP URL 契约**。布局的 `selectPanel` 也不是会话路由。

因此默认目录不声称点击会话就能打开该会话，而是显示“Native session link unavailable”和明确标注的“Open node”链接；操作者需要在原生节点页面选择会话。不猜测 hash/query 路径，不隐式重定向目标，不回退至其他 Runtime，也不自动创建会话。此限制意味着完整的一键会话体验尚未实现。

后续可通过一个随节点打包的官方客户端小插件，在正确 Runtime 连接就绪后校验节点、Runtime 和会话导航意图，再调用 `uiWorkspace.openSession`。声明固定版本能力前，必须测试会话不存在、子代理地址、导航被替代、启动选择竞态、Runtime 更换及重连。本包不提供该插件。`Gateway.sessionUrl` 仅为可选集成接口，必须配合明确验证过的 `nativeNavigation` 修订标识才启用。拒绝跨源或带 URL 凭据的链接；根工作流必须保证链接打开精确目标，并能通过现有节点授权流程。

## 注入式网关集成

实现：[目录包](../../packages/hub/gateway-session-directory/src/index.ts)。本包不打开监听器，也不导入网关实现或 DSH Runtime。

1. `targets()` 同步返回已授权、未撤销的描述符：节点 ID、Runtime ID、连接代次、名称、HTTPS 源站、精确版本、在线状态及能力。每次重连都必须更换代次，包括重连至同一个 Runtime。每个节点使用不同源站。
2. `list(target, {}, signal)` 通过现有出站网关传输及同一 Runtime 的插件连接调用原生列表。派发和响应时均校验完整的节点、Runtime、连接代次；解包 `RemoteResult`，传递取消。不转发至节点本地 Web 监听器，也不启动另一 Runtime。适配器必须在解码前限制响应字节数，因为 rc.2 原生接口返回完整列表。
3. 断开、重连、撤销及可用的原生会话变更事件发生时调用 `invalidate(nodeId)`；关闭或适当的注销时调用 `dispose()`。失效处理会保守地使正在进行的页面快照失效，可刷新已变更页面。本包不打开控制流或历史流。
4. 在网关已有操作者授权后挂载 `page({offset, limit, signal})` 和 `directoryResponse(page)`。解析并约束查询参数，将 HTTP 断开关联到取消。响应使用 `no-store`、禁止 referrer 和无脚本 CSP。根工作流还需限制请求准入与频率；并发限制按页面生效，不是所有调用者共享的全局限制。
5. 根工作流负责传输适配器、认证/票据、生命周期接线和可选的已验证导航插件。不会自动修改初始节点网关。本实验是已测试的注入式服务，不是完整在线部署。

默认边界：64 个目标，每页最多并发 8 个节点调用，每个已派发调用超时 800 毫秒，元数据缓存 2 秒（上限 5 秒），每节点最多保留 10,000 行，显示分页默认 50 行（上限 200）。全部节点挂起时，整页大约受 `ceil(nodes / concurrency) * timeout` 加本地处理及事件循环延迟约束。请求取消会拒绝整页并中止活动调用，即使注入的 Promise 忽略取消也能返回；实际远端资源关闭仍由适配器负责。超时不代表节点永久离线。

缓存身份包含节点、Runtime、连接代次、版本、源站、在线状态及能力。缓存由定时器到期删除，不必等待下次访问。返回前重新检查目标成员关系，防止已撤销或替换的目标，以及旧代次完成的响应混入后续页面。不写磁盘，不记录标题日志，不保留历史快照。断连节点只贡献状态，不显示旧会话行。错误仅显示固定的节点状态，避免泄露敏感异常详情。

分页按活动时间和明确的目标/会话身份排序。这是**显示分页**，不会减少原生网络读取量。明确显示每节点保留数量的截断，总数表示保留行数。活动变化或缓存过期后 offset 页可能移动，不提供快照一致性保证。保留前验证完整冷响应；解析和临时内存分配仍随完整原生结果增长。健康行旁同时显示各节点失败状态。

## 维护成本与测量

可以消除持久 Hub 会话索引：按需扇出原生列表，仅短暂缓存所需元数据。这样不再需要迁移、同步/对账、删除标记或保留会话内容。代价是完整列表原生 I/O、扇出尾延迟、缺少离线目录和稳定全局游标，以及小型版本约束适配器和可选导航插件。浏览器直接扇出也可省去服务端目录，但跨源授权、CORS 和生命周期处理会把复杂度移到浏览器。节点网关仍是维护成本更低的基线。

[可导入的基准工具](../../packages/hub/gateway-session-directory/src/benchmark.ts) 导出 `runSyntheticBenchmark` 和 `measureProbe`。根工作流可向 `measureProbe` 注入原生页面加载、重连探针，不需要提交提示词。在仓库根目录执行：

```sh
pnpm exec tsc -p packages/hub/gateway-session-directory/tsconfig.json --noEmit
pnpm exec vitest run packages/hub/gateway-session-directory/tests
pnpm exec tsx packages/hub/gateway-session-directory/src/benchmark-cli.ts
pnpm run check
pnpm run build
```

合成基准比较节点索引夹具、冷目录扇出加 SSR、热目录加 SSR、断开/重连刷新、部分超时及取消。结构化 JSON 提供样本数、成功/失败数、p50/p95/最大值和明确延迟预算；失败时 CLI 返回失败退出码。测试还覆盖多节点相同 ID、所有权变更、节点撤销、畸形响应、转义、跨源链接拒绝、分页及 TTL 到期。不发生真实模型调用。

**已执行的合成测量保存在私有实验报告中**，包括环境和精确配置，与本通用指南分开。真实网关传输延迟、实际持久会话列表延迟、原生浏览器加载/使用稳定性、Tailscale/Tailcat 重连可靠性及精确会话导航均**不在本实验测量范围内**。部署前，根工作流必须对节点基线与启用目录的版本分别执行这些验证，不能用合成数据代替。本包不部署，也不修改旧实现。
