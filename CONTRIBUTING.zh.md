# 贡献

[English](CONTRIBUTING.md) | 中文

DSH Hub 接受聚焦的问题和 Pull Request。本仓库是 DeepSeek Harness 的 Fork：Hub 代码在这里维护；准备贡献给上游 DSH 的变更应与 Hub 专用工作隔离，并按照上游项目的贡献策略提交。

## 产品不变式

贡献必须保留以下边界：

- Hub 是单用户完整权限控制平面，已注册节点不增加第二层交互式批准。
- Hub 不是 DSH Runtime，没有本地执行模式或 Hub 侧 DSH 插件宿主。
- 节点主动建立出站连接；Connector 不公开也不代理 DSH Web 监听器。
- Connector、本地 Web 和桌面客户端共享现有 DSH Runtime 与会话所有者。
- 节点数据保持权威；Hub 保存控制状态和显式制品，而非透明内容镜像。
- 节点绝不会向经过认证的 Hub 浏览器 Origin 提供可执行 JavaScript。

有意改变完整权限合约、增加节点确认或在 Hub 内运行 DSH 的产品，应维护为独立 Fork，而不应作为本仓库的行为变更提交。

## 提交 Pull Request 前

行为变更应先创建或关联 Issue。从当前 `master` 创建主题分支，将无关的上游变更和 Hub 变更放入不同 Commit 或 Pull Request，并按照对应工作流处理生成或 Vendor 内容。

不得提交凭据、注册代码、Access Token、私钥、个人标识或部署特定的主机名和地址。公开文档和 `.env.example` 使用通用示例；实时配置保存在部署 Secret Store 中。

每项非平凡变更都要新增或更新一份 [Agent Note](.agents/notes/README.md)。中英文文档必须同时变更，保持相同结构和链接目标，并刷新对应 `.i18n.yaml` 记录。

## 验证

开发时运行最小相关包测试，在请求 Review 前运行 Hub Gate：

```sh
pnpm install --frozen-lockfile
pnpm run hub:typecheck
pnpm run hub:lint
pnpm run hub:test
pnpm run hub:web:build
pnpm run test:gui
DSH_SNAPSHOT=replay pnpm run test:web
pnpm run hub:release:pack
pnpm run hub:release:verify
pnpm run doc-sync
```

协议、认证、存储、插件事务、快照、终端或恢复变更除了成功路径外，还必须测试畸形输入和失败行为。Connector 变更必须包含真实 Cordis Loader Composition 测试，并保留本地 Web 与桌面客户端共存。部署变更必须构建 Linux AMD64 容器并执行 Origin 隔离冒烟测试。

节点集合路由或传输调度变更还必须包含多节点同时运行的集成测试。测试应使用彼此独立的签名节点身份与 Journal，并发执行按所有者路由的 Web 和控制请求，证明一个停滞或断线节点不能阻塞另一个节点或收到其结果，并验证重连只恢复所属节点自身的积压。

## Pull Request 与 Review

按照 Pull Request Template 填写 Issue、用户可见结果、验证证据、安全影响、兼容性影响和文档变更。保持 Diff 易于审查，保留仓库格式和包边界，并通过新 Commit 响应 Review，直到获得批准。

`Hub CI` 的 Linux、macOS、Windows Type-check、官方 Web 回归、文档和 Linux AMD64 容器 Job 必须全部通过。Hub 协议、认证、节点权限、部署和 Release Workflow 路径需要 CODEOWNERS Review。批准后使用 Squash 合并，使 `master` 中每个 Pull Request 对应一项经过审查的变更。

本 Fork 将继承的上游 Harness CI、DSH／Vendor 发布、真实 API E2E、文档部署、Sandbox 与 Landlock Workflow 保持为仅手工触发。不得仅为增加检查就恢复其 PR、Push 或 Schedule 触发；应在 `hub-ci.yml` 中加入有明确边界的 Hub 自有门禁，或记录本 Fork 为何有意接管某个上游发布系列。

## Release

Hub Release 使用 `hub-v<package-version>` 格式的 Tag。Release Workflow 会验证测试和打包安装，发布带校验和的 Node Agent 与 Connector 制品，并发布包含 Provenance 的 Linux AMD64 镜像。Release Tag 只能从经过 Review 的 `master` Commit 创建。
