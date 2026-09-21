# DSH 版本兼容性

Hub Connector 是 DSH Host/Remote 接口的适配层。DSH 的版本不会自动保持线协议兼容：0.1.x 系列已经改变了 Host API、Session 持久化 API、插件加载方式和 Web 组合方式。

## 当前发布线

Hub 1.0.4 最初基于 `0.1.0-rc.7` Host API 家族构建并测试。当前 Connector 已不再打包已经删除的旧 Host ApiProxy/Session 依赖：现有节点仍走旧的进程内路径，新版本则通过 Typert Remote 适配当前 Session 和 Settings 接口。

当前上游发布线已经超出这个适配器：

| DSH 系列 | 上游状态 | Hub 状态 |
| --- | --- | --- |
| `0.1.0-rc.7` | 旧 Host API / ApiProxy 接口 | Hub 1.0.4 支持 |
| `0.1.5-rc.2` | Remote 网关和 Session API 已变化 | 已有 Remote 适配；Web/事件兼容性仍在验证 |
| `0.1.6-alpha.2` | 最新预发布版，包含插件管理器和 Session 变化 | 已有 Remote 适配；完整 Web/事件兼容性仍在验证 |

不要把新版 DSH Profile 安装到运行 1.0.4 Connector 的节点后，就认为 Web 页面能打开代表兼容。节点设置页必须同时显示 DSH 版本、Connector 版本和已协商能力。升级节点后，只有通过[运维文档](operations.zh.md)中的金丝雀功能检查才算完成。

## 升级策略

每个 Hub 发布版都记录 Connector 实际构建和测试所用的 DSH 包家族。未来版本可以同时支持多个家族，但每个家族都必须拥有独立适配测试，覆盖会话列表、历史、回答提交、工具/Skill 执行、提问卡片、取消、设置和事件流。上游删除导入包或改变 Remote 方法后，在这些测试通过前都不能宣称兼容。

节点显示的版本只用于诊断；能力协商才是权威依据。即使 DSH 版本字符串看起来更新，Hub 仍必须拒绝不支持的能力版本或 Schema 哈希。
