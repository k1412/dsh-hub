# DSH Hub

[English](README.md) | 中文

DSH Hub 是一个自托管控制平面，用于从同一个浏览器管理多个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Runtime。每个节点保留自己的 DSH Runtime、会话、工作区文件、凭据和本地客户端。Node Agent 主动向 Hub 建立经过认证的出站连接，进程内 Cordis Connector 则使用本地 Web 与桌面客户端到达的同一个与传输无关的 Host Gateway。

## 功能

- 在本地 Web、桌面客户端或 Hub 之间交替继续同一个会话。
- 通过适配移动端的单用户界面浏览所有已注册节点和会话。
- 使用 Node Agent 的操作系统账户运行会话命令、工作区文件操作和交互式终端。
- 按精确版本和制品哈希锁定、暂存、盘点及回滚 DSH Profile 插件。
- 创建和恢复节点本地的配置、依赖、数据及机群快照，同时排除已知机密文件类别与符号链接。
- 通过持久序列号、确认、重放、幂等和连接代际隔离恢复出站 WSS 连接。

## 架构

Hub 是控制平面，不是 DSH Runtime。它不运行 agent 或节点插件，也没有本地执行模式。节点始终是实时会话、工作区、受管插件制品和快照的权威来源；Hub 只持久化控制状态、最小会话索引、命令交付状态和审计记录，不提供透明的节点内容或对象缓存。

浏览器请求通过 REST 执行命令，通过 SSE 接收实时状态，并使用专用 WebSocket 传输 PTY 流量。Node Agent 只建立出站 WSS 连接，并使用 Cloudflare Access Service Token 与固定的 Ed25519 节点身份进行认证。人员访问使用 Cloudflare Access 和 Hub 内部的邮箱白名单。

详见[架构参考](docs/hub/architecture.md)与[安全参考](docs/hub/security.md)。

## 运行

本 fork 保留完整的上游 DSH Runtime 和开发界面。

### 从 `npm` 运行

安装 Node.js，然后运行上游 Web UI：

```sh
npx @deepseek-ai/dsh web
```

Web UI 默认监听 `http://127.0.0.1:3080`。详见 [Web UI 指南](docs/user/guide/index.md)。

### 从源码运行

```sh
git clone https://github.com/k1412/dsh-hub.git
cd dsh-hub
pnpm install
pnpm run build
pnpm dsh web
```

## 部署

Hub 支持使用经过加固的 [Docker Compose 定义](deploy/hub/compose.yaml)部署。节点安装发行版 Node Agent 和 DSH Connector Bundle。Connector 加入提供 DSH Host Gateway 的现有 Composition，不安装或代理 DSH Web 传输。

先按照[部署指南](docs/hub/deployment.md)完成安装，再通过[运维指南](docs/hub/operations.md)执行注册、备份、恢复、升级和吊销。

## 开发

Hub 包位于 [`packages/hub`](packages/hub)，浏览器应用位于 [`apps/hub-web`](apps/hub-web)。贡献需遵循 [CONTRIBUTING.md](CONTRIBUTING.md)以及仓库已有的包、文档、测试和双语配对规范。

## 上游与许可证

本仓库是 DeepSeek Harness 的 fork。上游 DSH 代码、Hub 新增代码和完整仓库均采用 [MIT License](LICENSE) 分发，第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。DSH Hub 是独立社区项目，不将 DeepSeek 品牌用作自身产品标识。
