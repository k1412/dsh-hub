# 部署 DSH Hub

[English](deployment.md) | 中文

本教程使用 Docker Compose 安装一个 Hub，将其置于 Cloudflare Access 和受信任反向代理之后，并注册一个现有 DSH Profile。示例只使用通用名称和路径；环境特定的主机名、地址、Token 和邮箱地址必须保存在仓库之外。

## 前置条件

- 一台安装 Docker Engine 和 Compose v2 的 Linux Docker 主机。
- 一个通过 Cloudflare Access 路由到受信任反向代理的 HTTPS 主机名。
- 一个同时配置人员策略和 Service Token 策略的 Cloudflare Access Self-hosted Application。
- 每个节点安装 Node.js 22.19 或更高版本、`pnpm` 和 DSH。目标 DSH 组合必须提供与传输无关的 `@deepseek-ai/dsh-host-apiproxy` Service；标准 Web Profile 已提供该 Service。安装 Node Agent 前，还应安装 `node-pty` 在该平台所需的 C/C++ 构建工具链和 Python。
- 反向代理到 Hub Origin 的私有路径，可以是回环、私有网络或经过认证的 Overlay Network。

## 1. 配置 Cloudflare Access

为 Hub 主机名创建一个 Self-hosted Access Application。添加允许操作员身份提供方的 Allow Policy，并添加包含节点 Service Token 的 Allow Policy。记录 Application Audience、Team Domain，并为每个节点创建一个不同的 Service Token。

按照 Cloudflare 当前的 [Self-hosted Access Application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)、[Access JWT 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)和 [Service Token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)指南配置。Application Audience 与 Service Token 身份必须和 Hub 自己的注册及 Ed25519 身份相互独立。

Hub 会独立验证 Access JWT。浏览器 JWT 必须携带白名单邮箱，节点 JWT 必须携带 Service Token `common_name`。有效的 Cloudflare Session 不能绕过 Hub 白名单或节点注册。

## 2. 配置受信任 Origin 路径

配置反向代理删除客户端提交的所有 `X-DSH-Origin-Secret` Header，并添加自己的固定随机值。转发 HTTP Upgrade，并对 SSE 禁用响应缓冲。Origin 只能通过回环或私有网络路由，其防火墙只允许代理访问。

直接访问 Hub IP 和端口的请求不包含代理持有的密钥，因此只会收到 Not Found。即使防火墙或 Overlay Network 已限制可达范围，仍必须启用 Origin Secret 检查。

## 3. 启动 Hub

将 [`deploy/hub/compose.yaml`](../../deploy/hub/compose.yaml)和 [`.env.example`](../../deploy/hub/.env.example)复制到部署目录，把 `.env.example` 重命名为 `.env`，并填写所有必需值。Origin Secret 必须独立生成，不能复用任何 Cloudflare 凭据。

```sh
chmod 600 .env
mkdir -p backups
chown 10001:10001 backups
docker compose pull
docker compose up -d
docker compose ps
```

随附 Compose 定义绑定回环地址。反向代理位于另一台受信任主机时，应把发布端口绑定到私有接口地址，并在主机防火墙中只允许代理地址。不得把 Origin 端口作为不受限制的互联网服务发布。

在隐私浏览器窗口中验证公共主机名。Cloudflare Access 必须在 Hub UI 加载前完成认证。直接向 Origin 发送且不含注入 Header 的请求不得公开 `/healthz`、UI、REST、SSE 或 WebSocket Upgrade。

## 4. 创建节点注册

通过 Hub UI 或已认证 REST Endpoint 创建短期注册授权。选择稳定的节点 ID 和清晰的显示名称。一次性注册代码只返回一次，Hub 仅保存其哈希。无人值守部署也可以先停止 Hub，再通过同一 Compose 项目执行离线管理命令；不得让离线命令与 Hub Server 并发写入状态 Volume：

```bash
docker compose stop hub
docker compose run --rm hub node /app/hub-server.mjs create-enrollment \
  --node-id workstation-1 --display-name "Workstation 1" --expires-in 900
docker compose up -d hub
```

命令输出包含一次性代码，必须直接写入目标节点的仅所有者可读配置，不得进入 Shell 历史、日志、工单或 Git。离线创建操作会以 `local-admin` 身份进入审计链。

为该节点创建独立的 Cloudflare Access Service Token。不要在多个节点间复用 Token：逐节点 Token 可以独立轮换和吊销，Hub 还会将 Service Token 身份永久绑定到已注册的 Ed25519 节点密钥。

## 5. 安装节点包

从同一个 Release 下载 Node Agent、Connector 和校验和清单，并在安装前验证两个制品。以下示例不会把机密放入命令参数；请在隐藏提示中输入两个值。

```sh
VERSION=0.1.0-rc.5
RELEASE="https://github.com/k1412/dsh-hub/releases/download/hub-v${VERSION}"
curl --fail --location --remote-name "${RELEASE}/SHA256SUMS"
curl --fail --location --remote-name "${RELEASE}/k1412-dsh-hub-node-agent-${VERSION}.tgz"
curl --fail --location --remote-name "${RELEASE}/k1412-dsh-hub-connector-${VERSION}.tgz"
if command -v sha256sum >/dev/null; then
  sha256sum --check SHA256SUMS
else
  shasum -a 256 --check SHA256SUMS
fi
npm install --global "./k1412-dsh-hub-node-agent-${VERSION}.tgz"
read -rsp "Access Client Secret: " DSH_HUB_ACCESS_CLIENT_SECRET; echo
read -rsp "Enrollment Code: " DSH_HUB_ENROLLMENT_CODE; echo
export DSH_HUB_ACCESS_CLIENT_SECRET DSH_HUB_ENROLLMENT_CODE
dsh-hub-node init \
  --hub https://hub.example.com \
  --node workstation-1 \
  --access-client-id replace-with-service-token-client-id \
  --profile web \
  --runtime-id default \
  --profile-directory "${DSH_HOME:-$HOME/.dsh}/profiles/web" \
  --install-connector "$(pwd)/k1412-dsh-hub-connector-${VERSION}.tgz"
unset DSH_HUB_ACCESS_CLIENT_SECRET DSH_HUB_ENROLLMENT_CODE
```

`init` 使用 Service Token 获取并固定 Hub 公钥，写入仅所有者可读的 Node Agent 配置，创建持久节点身份和 Connector IPC 密钥，并可选择把 Connector 安装到指定 DSH Profile。Connector Bundle 只贡献一条 Cordis 配置项，使用现有 Host Gateway，不修改 Web 监听器或前端 Bundle。

通过平台 Service Manager 使用与 DSH 相同的操作系统账户运行 Node Agent。使用命令输出的配置路径执行 `dsh-hub-node --config <path>`。配置自动重启和私有主目录，不要提升权限。[节点服务指南](node-services.md)提供 Linux、macOS 和 Windows 示例。

## 6. 重启现有 DSH Profile

重启现有 DSH 进程一次，使 Cordis 加载新安装的 Connector Bundle。本地 Web 和桌面客户端仍连接同一组 DSH 服务与持久化。Connector 只连接本机 Node Agent Socket。

同一台机器上每个独立运行的 DSH 进程都应设置不同的 `DSH_HUB_RUNTIME_ID`。一个进程可以服务多个本地客户端界面，只需一个 Connector 实例。

Node Agent 使用非默认 State Directory 或 IPC Endpoint 时，应在 DSH 进程中配置相同的 `DSH_HUB_STATE_DIRECTORY`，或显式配置 Connector 的 `ipcEndpoint` 与 `secretFile`。使用非默认 Runtime ID 时，应在对应 DSH 进程中设置 `DSH_HUB_RUNTIME_ID`。Connector Runtime ID 必须与对应的 `management.profiles[].runtimeId` 完全一致。

## 7. 验证共存

在本地 Web UI 创建会话并发送消息，确认该会话出现在 Hub 对应节点下。从 Hub 继续同一会话，确认本地 Web UI 收到事件。对桌面客户端重复该流程。断开 Hub 或停止 Node Agent，确认两个本地客户端仍可继续工作。

只有在 Node Agent 的 Profile Management Directory 指向预期 DSH Profile 后，才验证终端、文件、插件和快照控制。这些操作使用 Node Agent 账户的全部权限执行，不会请求第二次本地批准。

## 多 Profile 与多节点

对每台机器重复注册并签发不同的 Service Token。为同一 Node Agent 增加本地 Profile 时，不要再次注册。应在该 Profile 中安装 Connector Bundle，为 Connector 配置唯一 Runtime ID；如果需要让 Hub 为其提供文件、终端、插件与快照能力，还应在仅所有者可访问的 Node Agent 配置中向 `management.profiles` 添加匹配项：

```json
{
  "management": {
    "profiles": [
      {
        "runtimeId": "default",
        "profileDirectory": "/absolute/path/to/profiles/web",
        "profileName": "web",
        "dshExecutable": "/absolute/path/to/dsh",
        "snapshotPaths": ["/absolute/path/to/approved/data"]
      }
    ]
  }
}
```

同一机器上的多个 DSH Profile 可以共享 Node Agent Socket，但每个独立运行的进程都必须使用唯一 Runtime ID 和 Profile Directory。没有匹配管理配置项的 Runtime 只公开 Connector 能力。不得让两个并发 DSH 进程指向同一个会话存储目录。
