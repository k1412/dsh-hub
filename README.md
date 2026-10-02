# DSH Hub Gateway · 会话目录实验

中文 | [English](README.en.md)

[![Gateway 分支 CI](https://github.com/k1412/dsh-hub/actions/workflows/hub-ci.yml/badge.svg?branch=experiment%2Fsession-directory)](https://github.com/k1412/dsh-hub/actions?query=branch%3Aexperiment%2Fsession-directory)
[![License](https://img.shields.io/github/license/k1412/dsh-hub)](LICENSE)

**一个节点列表，打开各台机器原来的 DSH。**

电脑、NAS 或服务器上的节点主动连接 Hub。浏览器打开节点后，使用该节点安装的官方前端、插件和现有 Runtime；无需公开本地 Web 端口，也不会为远程访问启动第二套 DSH。

本实验分支额外提供可运行的[会话目录与精确原生导航](docs/hub/session-directory-experiment.zh.md)，由 `DSH_GATEWAY_SESSION_DIRECTORY=1` 显式开启；默认仍为节点入口。同 Runtime 双 Hub 安装、真实 rc.2 浏览器验证及测量边界见实验文档。

## 三层各负责什么

| 层 | 负责 | 数据与权限 |
| --- | --- | --- |
| Hub | 登录、节点列表、邀请、撤销和网络设置；转发已认证流量；可选会话目录 | 保存身份、邀请和操作者会话，短暂缓存少量目录元数据，不存模型凭据、历史或项目索引 |
| 网络 | Tailscale 或 Tailcat 提供节点主动出站连接 | Hub 镜像包含两种工具；覆盖网络不能替代 Hub 配对认证 |
| 节点 | 官方前端、插件、API、模型、会话和文件 | 全部来自同一个现有 Runtime；每节点独立浏览器源 |

面向个人或单一可信操作者。登录后拥有节点 Runtime 的完整权限，包括文件和终端；不是多人分权服务。

## 快速开始

### 1. 部署 Hub

这是**从源码构建**的 Compose 应用；不依赖已公开发布的 Gateway npm 包或容器镜像。

在仓库根目录准备配置：

```sh
cp deploy/gateway/.env.example deploy/gateway/.env
chmod 600 deploy/gateway/.env
```

编辑 `deploy/gateway/.env`：

- 填写 `DSH_GATEWAY_PUBLIC_URL`，选择未占用的浏览器端口。
- 选择至少 16 字符的独立密码，或完整填写 Cloudflare Access 配置；Access 模式不提供密码绕过。
- 配置管理域名、每节点子域名、HTTPS 证书和反向代理。
- Access 保护管理入口时，提供命令行安装器可访问的 `DSH_GATEWAY_DOWNLOAD_URL`。

```sh
docker compose --env-file deploy/gateway/.env \
  -p dsh-gateway-v2 -f deploy/gateway/compose.yaml up -d --build
```

默认浏览器端口只发布到宿主回环地址。**不要发布私有 agent 端口 `8081`。** 使用独立应用和状态卷，保留现有服务。部署边界见[设计文档](docs/hub/gateway-design.zh.md)。

### 2. 邀请节点

在 Hub“连接设置”准备网络，再点击“添加节点”：

- **Tailscale：**适合已有 tailnet；可在 Hub 完成托管登录配置。
- **Tailcat：**无需账号，通过加密通道配对；直连不可用时可中继。

以运行现有 DSH 的用户执行邀请命令。安装器验证下载并装入原 profile，保留配对身份；重复安装不会用同一运行中 Tailcat 身份另起冲突进程。

### 3. 打开原生 DSH

节点在线后点击“打开 DSH”，选择工作区并继续原生会话。每个节点的模型、历史和文件仍由它自己的 Runtime 管理。

首次安装已实测可 HMR 激活。**插件更新安装成功不等于运行代码已更新**：官方 rc2 的更新可能遇到嵌套 HMR 事务限制，需要检查活动任务后受控重载现有 Runtime；不能启动第二个 Runtime。

## 已验证与当前限制

以下真实生产验收属于基础 Gateway，不代表实验目录已部署验收。实验版的双 Runtime、双 Hub、精确历史导航与 SSE 隔离已有 Chromium/WebKit fixture 和 CI 证据，详见[实验记录](docs/hub/session-directory-experiment.zh.md)。

- 两个真实节点分别经 Tailscale／Tailcat 在线，原生工作区、Full access、模型菜单及 Chromium／WebKit 手机交互通过。
- 每节点一次真实模型回复与刷新历史通过；65,537 字节原生上传／下载 SHA-256 一致，跨节点归属检查通过。
- 完整安装的 rc2、63 个官方插件、正式安装包、实际 Tailcat 重复安装与插件事件 SSE 均有测试记录。
- JS／CSS 支持流式 gzip；只有确切版本 URL 且原生声明 immutable 的代码允许私有浏览器缓存。API、历史和文件仍为 no-store，无 Hub 共享缓存。
- 历史生产冷加载曾约 94 秒；功能成功不代表速度达标。最终部署、冷／热缓存与恢复数据见[分阶段验收记录](docs/hub/gateway-design.zh.md#10-当前实现与验收证据)，不作 SLA 承诺。
- “Open in App”是本地桌面功能，远程不支持；其 404 不能写成“零网络错误”。

## 版本与兼容范围

| 对象 | 本版边界 |
| --- | --- |
| Gateway | `2.0.0-alpha.1`；以源码修订和对应验收记录为准，不把同版本号的后续改动当作已验证 |
| DSH | 安装器准入 `0.1.7-rc.2`；前端与插件来自该节点匹配的 Runtime |
| 网络工具 | Tailscale `1.102.4`、Tailcat `0.7.0`；自动安装覆盖 Linux amd64／arm64，macOS 需预装所选工具，shell 不支持 Windows |

## 文档与 legacy 维护

- [Gateway 架构、端点、认证、更新／回滚及验收](docs/hub/gateway-design.zh.md)
- 本分支：[会话目录与精确原生导航](docs/hub/session-directory-experiment.zh.md)，默认关闭；设置 `DSH_GATEWAY_SESSION_DIRECTORY=1` 开启。双 Hub 请使用同 Runtime 的独立命名实例与状态目录。另一个[节点管理与互联实验](https://github.com/k1412/dsh-hub/tree/experiment/node-control)不属于本分支。
- [源码构建配置模板](deploy/gateway/.env.example) · [Compose](deploy/gateway/compose.yaml) · [安全报告](SECURITY.md)
- **仅旧版 v1 维护：**[旧文档目录](docs/hub/index.zh.md)、[旧控制台](docs/hub/console.zh.md)、[旧部署](docs/hub/deployment.zh.md)、[旧工作台截图](docs/assets/overview.png)。旧版聚合与模型同步不属于本分支 Gateway。
