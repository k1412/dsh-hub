# DSH 版本兼容性

Hub Connector 是 DSH Host/Remote 接口的适配层。DSH 的版本不会自动保持线协议兼容：0.1.x 系列已经改变了 Host API、Session 持久化 API、插件加载方式和 Web 组合方式。

## 当前发布线

Hub 1.0.4 最初基于 `0.1.0-rc.7` Host API 家族构建并测试。当前 Connector 已不再打包已经删除的旧 Host ApiProxy/Session 依赖：现有节点仍走旧的进程内路径，新版本则通过 Typert Remote 适配当前 Session 和 Settings 接口。

下面区分发布版基线与当前主分支适配覆盖。主分支修复不会自动出现在已发布的安装包或镜像中，部署时须核对实际源提交与制品。

这张表描述已覆盖的版本，不声称列出了上游最新版本：

| DSH 系列 | 上游状态 | Hub 状态 |
| --- | --- | --- |
| `0.1.0-rc.6` / `0.1.0-rc.7` | 旧 Host API / ApiProxy 接口 | Hub 1.0.4 支持；等待 ApiProxy 依赖激活后再启动 Connector，避免错误地进入新版 Remote 路径 |
| `0.1.5-rc.2` / `0.1.5-rc.3` | Remote 网关和 Session API 已变化 | 已覆盖 Connector Remote 适配、事件桥接和 `$events/result` 回答路径；页面级 target bridge 也会把 Hub 选择带入 `/api/*`；内置 Web UI 仍是 rc.7 组合 |
| `0.1.6-alpha.2` / `0.1.7-alpha.1` | 已覆盖的 alpha 版本，包含插件管理器和 Session 变化 | 已覆盖 Connector Remote 适配、工具/Skill 路由、问题/取消、事件桥接和 `$events/result` 回答路径；target bridge 覆盖了变化后的 HTTP/WebSocket 载体，但内置 Web UI 仍是 rc.7 组合 |
| `0.1.7-rc.2` | 当前已验证的 DSH Runtime | Connector 继续桥接 Session 和事件，将内置 rc.7 Web UI 的 `host.listDirectory`、`host.createDirectory`、`host.pickDirectory` 转到新版 `directoryPicker` Remote，并把工作区写入请求包装为新版 `workspace` Remote 所需的 `request` 参数。Hub 内置 Web UI 仍是 rc.7 组合，新版 DSH Web 功能不会自动出现在 Hub 页面。 |

不要把新版 DSH Profile 安装到运行 1.0.4 Connector 的节点后，就认为 Web 页面能打开代表兼容。Connector 当前 Remote 路径和页面级 target bridge 已独立于内置 rc.7 Web artifact 完成测试；最新 DSH Web 组合更换了客户端包名，仍需要单独执行 [bundle 迁移](https://github.com/k1412/dsh-hub/issues/40)。节点设置页必须同时显示 DSH 版本、Connector 版本和已协商能力。升级节点后，只有通过[运维文档](operations.zh.md)中的金丝雀功能检查才算完成。

## 升级策略

内置模型选择器的 `session.models` 调用会适配为新版 `session.modelCatalog` 与 `session.projections` 读取。适配层保留每个 Session 的下一次模型选择，未配置的会话使用所属 Runtime 的部署默认模型，并保留提供方分组、推理参数和单独提供方的失败信息。模型切换继续使用 `session.selectModel`，由适配层包装命名的 `request` 参数。已有的旧版 ApiProxy 模型服务仍是权威来源。

内置历史界面的 `session.history` 调用会适配为新版 `session.page`，使用先读取的 `session.projections.asOfSeq` 作为有效日志截点，并保留向前分页和尾页的投影基线。旧版 ApiProxy 历史服务仍是权威来源。Connector 等待所属版本的依赖初始化；本地 IPC 即使正常关闭也会退避重连，避免启动失败产生通知风暴。

新版工作区没有 `workspace.list` 单次读取接口。适配层从 `workspace.follow` 读取完整初始快照后立即关闭该流，保留节点各自的工作区顺序、归档和置顶集合；旧版节点继续使用原生列表接口。

归档浏览、回收站、恢复和永久删除属于 Hub 扩展，通过协商后的 `dsh.session-lifecycle` 能力提供。JSONL 存储和写锁约定已针对 `0.1.7-rc.2` 验证，不会假定旧版 DSH 支持删除。使用此新约定时应一起更新 Hub、Node Agent 和 Connector。没有此能力的节点仍可正常使用，并在[会话管理](session-management.zh.md)中显示升级提示。

每个 Hub 发布版都记录 Connector 实际构建和测试所用的 DSH 包家族。未来版本可以同时支持多个家族，但每个家族都必须拥有独立适配测试，覆盖会话列表、历史、回答提交、工具/Skill 执行、提问卡片、取消、设置和事件流。上游删除导入包或改变 Remote 方法后，在这些测试通过前都不能宣称兼容。

节点显示的版本只用于诊断；能力协商才是权威依据。即使 DSH 版本字符串看起来更新，Hub 仍必须拒绝不支持的能力版本或 Schema 哈希。
