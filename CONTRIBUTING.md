# 参与 DSH Hub

中文 | [English](CONTRIBUTING.en.md)

欢迎提交聚焦、可验证的 Issue 和 Pull Request。DSH Hub 是独立的社区项目：这里只维护多节点控制面；适用于所有 DeepSeek Harness 用户的改动应优先提交到上游。

## 不可破坏的产品边界

- Hub 是单操作员、节点账户最高权限的控制面；节点不再增加第二层交互确认。
- Hub 不是 DSH Runtime，不提供本地执行模式，也不在 Hub 内托管 DSH 插件。
- 节点只主动出站连接；Connector 不暴露或反向代理节点的本地 Web 端口。
- Connector、本地 Web 和桌面端共享同一个现有 DSH Runtime 与会话存储。
- 节点数据是事实来源；Hub 不透明镜像会话全文或节点文件。
- 节点不能向 Hub 浏览器 Origin 注入临时 JavaScript。

如果你的产品希望改变“Hub 拥有节点账户全部权限”、增加逐节点批准或在 Hub 内执行 DSH，请维护独立 Fork，不要直接改变本项目默认模型。

## 开发流程

1. 行为变更先建立或关联 Issue，从最新 `master` 创建主题分支。
2. 一个 PR 解决一个问题；不要混入无关格式化或上游同步。
3. 不得提交密钥、注册码、Token、私钥、私人邮箱、真实域名、IP 或目录。文档使用 `hub.example.com` 等通用示例。
4. 用户可见行为、部署和安全边界同时更新中文主文档与完整英文镜像。
5. PR 填写用户结果、测试证据、安全影响、兼容性影响和文档变化。

仓库目前可以由维护者直接推进；有第二位贡献者后，协议、认证、完整节点权限、部署和发布工作流的变更至少需要一位非作者 Review。所有必需 CI 通过后 Squash Merge。不要为了绕开安全不变量而降低检查或自行合并争议改动。

## 本地验证

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
```

协议、认证、存储、插件事务、快照、终端和恢复变更必须覆盖非法输入与失败路径。机群路由或传输变更还必须通过真实的同时多节点集成测试：两套独立身份与 Journal 并发请求、单节点断连隔离、重连后只恢复各自积压。

官方 Web 制品快照位于 `third_party/official-web`，更新时必须固定上游提交、提交可复现补丁、更新许可证说明，并通过生产 CSP、桌面和 390px 手机回归测试。不要手工修改压缩后的 JavaScript。

CI 按证据边界拆分：Ubuntu/macOS 运行完整核心检查；双节点 Job 验证隔离与恢复；性能 Job 保存控制面指标；Web Job 运行真实官方组合的桌面/390px 交互；Windows Job 只保留 Windows 安装器解析、可移植协议/客户端测试和 Web 构建；文档 Job 检查双语、链接、隐私与仓库边界；容器 Job 必须实际启动只读、非 Root 镜像并验证健康检查与 Origin Secret 隔离。不要保留只重复其他平台、却不能证明平台行为的空泛 Job。

## 发布

正式版本使用 `hub-v<version>` 标签。发布工作流会重复类型检查、Lint、单元与多节点测试、Web 回归、打包安装验证，并发布带 SHA-256、SBOM 和 Provenance 的制品。
