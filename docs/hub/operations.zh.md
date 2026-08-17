# 运维 DSH Hub

[English](operations.md) | 中文

本指南介绍 Hub 和至少一个节点安装完成后的日常生命周期操作。

## 注册节点

以操作员身份认证后创建短期注册授权，签发不同的 Cloudflare Access Service Token，并在目标节点运行 `dsh-hub-node init`。无人值守场景可使用[部署指南](deployment.md)中的离线 `create-enrollment` 命令，但必须先停止 Hub，避免两个进程并发写入状态 Volume。只有 Hub 已记录节点公钥和 Service Token 身份，且一次性代码已从仅所有者可读的 Node Agent 配置中消失，注册才算完成。

在机群视图中验证节点、Runtime、DSH 版本、Connector 版本和声明能力。启用插件、文件、快照或终端工作流前，先测试读取操作。

## 吊销节点

在 Hub 中吊销节点，并删除或禁用其 Cloudflare Access Service Token。Hub 会隔离活动连接并拒绝后续代际。只有在确认调查不再需要该身份和排队结果后，才停止 Node Agent 并删除其私有状态。

吊销不会删除节点上的会话或工作区数据，也不会删除 Hub 审计历史。除非有意复用与 Hub 记录匹配的已保留仅所有者可读状态，否则重新注册同一台机器会创建新的节点身份。

## 备份 Hub

生产镜像可以在不停止 Hub 的情况下创建在线 SQLite 备份。目标必须是挂载备份 Volume 中的新目录。

```sh
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker compose run --rm hub node /app/hub-server.mjs backup \
  --destination "/backup/${STAMP}"
docker compose run --rm hub node /app/hub-server.mjs verify-backup \
  --source "/backup/${STAMP}"
```

将验证通过的目录复制到独立故障域，进行加密，并保留多个世代。有效备份包含 `hub.db` 和 `manifest.json`；验证过程会检查数据库哈希和审计链。在备份旁记录容器镜像 Digest 和 Release 版本。Manifest 是完整性记录，不是外部签名，因此必须与备份一起保护。插件回退事务与快照在各节点的 Node Agent 状态目录中，需要另行备份。

## 恢复 Hub

停止 Hub，保留损坏 Volume，创建新状态 Volume，并恢复 `hub.db`，将所有权设为 `10001:10001`，且禁止 Group 或 World Access。先使用备份记录的精确镜像 Digest 启动，再考虑应用升级。

把文件复制到新 Volume 前先运行 `verify-backup`。首次启动应使用隔离的反向代理路由；Hub 会在监听前验证审计链。确认节点记录存在，并确保恢复实例不能与生产 Hub 竞争同一批节点。原 Hub 永久停止后才能提升该路由。

## 升级 Hub

创建并导出新备份，阅读 Release Notes，固定新的不可变镜像 Digest，拉取镜像并重新创建容器。验证健康状态、人员登录、节点重连、会话基线加载、一次读取命令、SSE 刷新以及一次终端打开和关闭。

Hub 在启动时只执行已知的顺序数据库迁移。Schema v1 到 v2 会保留所有会话索引行并增加可空的项目工作目录字段；v2 到 v3 删除未投入使用的 Hub 对象缓存表，节点文件、插件制品和快照继续留在节点。迁移后的数据库不能由旧镜像打开。需要回滚镜像时，应停止 Hub，并恢复升级前使用该旧镜像创建和验证过的完整备份；不得让旧镜像直接写入已迁移 Volume。

Hub 协议采用精确协商。新的 Hub 不再接受节点的协议或能力版本时，应升级节点。Hub Release 不得静默重新解释旧能力描述符。为了让节点可以逐台更新，Hub 1.0 在协商层同时接受 `dsh.plugins` 2.0 与 3.0：2.0 只保留原有的“是否有更新”响应，3.0 才能区分 Registry、外部来源和单插件查询失败。Hub 只向新连接声明当前的 3.0 合约，不会把 2.0 响应伪装成 3.0。

推荐滚动顺序是：先备份并升级 Hub，再逐台升级 Node Agent，最后在不会中断重要任务的维护窗口内升级 Connector 并重启对应 DSH Profile。旧 Node Agent 在兼容窗口内仍可使用原有插件合约；新 Node Agent 重连后自动启用更完整的来源与错误状态，Connector 无需为此重启。完成整个机群升级并确认没有旧 Agent 后，后续大版本才可以移除旧能力合约。

## 升级节点

先升级 Node Agent 包，重启其服务并验证重连。通过 `dsh plugin --profile <name> add <release-asset> --save-exact` 升级每个 DSH Profile 中的 Connector，然后重启对应 DSH 进程并验证其 Runtime Boot ID 已变化。正在运行长任务的 Runtime 可以暂缓 Connector 升级；不要为追求版本一致而中断会话，待任务结束后再补齐。

Node Agent 离线时，本地客户端仍可继续工作。Connector 重启期间，对应 Runtime 在 Hub 中显示离线，排队操作仍受各自幂等类别约束。

## 管理插件

在“设置 → 节点插件”选择 Runtime，即可看到实际插件版本、启用状态和健康状态。点击“检查更新”后选择精确目标版本；更新前 Node Agent 自动保存当前依赖与 Cordis 文件，下载受限于公共 npm Registry 并记录制品 SHA-256。先在 Canary 节点更新，确认插件与 DSH Runtime 健康后，再继续其他节点或批次。

更新失败时 Node Agent 会自动恢复；更新成功后，“更新与回退历史”会显示一个“回退到更新前”按钮。回退会恢复已记录的依赖与 Cordis 文件，并使用冻结锁执行 DSH Profile Package Manager 安装。如果当前锁已经被后续更新改变，操作会停止，避免覆盖更新状态。

## 管理快照

配置快照用于 Cordis 组合，依赖快照用于包 Manifest 和锁，数据快照用于显式配置目录，机群快照用于组合经过过滤的 Profile 状态。每个创建请求都携带稳定的 Mutation ID，因此重连是安全的。

恢复会检查快照制品哈希和已配置根目录。如果调用方必须拒绝并发变化，应提供预期当前哈希。快照恢复会先验检查每个目标、暂存替换文件，并在后续失败时回滚已经提交的替换。它只写入已包含文件，不会删除根目录中的无关文件。

## 调查交付故障

依次检查 Cloudflare Access Policy 和 Service Token 状态、公共 DNS 与 TLS、代理到 Origin 的私有路径、代理 WebSocket 转发、Node Agent 日志和 Hub 审计记录。收集诊断信息时不得打印 Service Token Secret、注册代码、私钥或 Connector Secret。

注册期间来自 Access 的 HTTP 或 HTML 页面不是 Hub JSON 响应。当前安装器会把它报告为“请求在抵达 Hub 前返回非 JSON 页面”，并明确列出 Client ID／Secret、Service Auth Policy 与 `/hub/v1/bootstrap` 检查项，但不会回显响应正文。只粘贴 Client ID 值，绝不要带 `CF-Access-Client-Id:` 标签。成功的 Bootstrap 必须返回 JSON，且其中 `serviceIdentity` 与该 Client ID 精确相等，Node Agent 才会写入固定的 Hub 身份。

“设置 → Hub 节点”每 15 秒显示一次双向可靠队列健康度。节点到 Hub 来自 Node Agent 报告；Hub 到节点直接来自 Hub Journal。正常连接中两侧记录数会回落到接近零，最旧记录时间会消失。`warning` 表示总使用量达到 75%、排队的可重建 Stream Frame 达到 500 条或 4 MiB，或已经抑制过 Frame；`critical` 表示总使用量达到 95% 或控制记录已进入内存应急队列。Agent 服务日志会同时显示记录数和字节数。离线节点可能缺少新的节点侧报告，但 Hub 侧队列、最后心跳和已缓存会话索引仍然可见。

Queue 满载时先保持 Node Agent 服务运行并恢复 Hub WSS 路径。Node Agent 会在重连后先分页重放已有 Journal，并为控制记录保留容量；提问和审批请求使用该控制预留空间，不会被主动抑制。不要删除节点数据库、私钥或 Connector Secret，也不要通过重新注册来跳过序列状态。若页面报告 Stream 中断，Connector 会在不重启 DSH 的情况下替换事件订阅；待处理交互会重放到 Composer，终端等瞬时 Stream 则需要重新打开。已索引会话在此期间仍会按工作目录显示为离线。

确认恢复时同时验证四项：Node Agent 进程没有重启循环；双向队列记录数持续下降；Runtime 重新变为在线；本地 Web 或桌面端原有会话与 Hub 中同一会话均可继续。压力等级恢复会写入 `transport.pressure` 审计记录，累计被抑制 Frame 仍保留为诊断计数。

序列缺口会请求 Runtime 重新同步。`outcome-unknown` 命令要求在再次变更前检查节点权威状态。不得只依据 Hub 命令记录把它改为成功或直接重试。
