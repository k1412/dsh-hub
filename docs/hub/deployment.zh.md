# 部署 DSH Hub

[English](deployment.md) | 中文

本教程使用 Docker Compose 安装一个 Hub，将其置于 Cloudflare Access 和受信任反向代理之后，并注册一个现有 DSH Profile。示例只使用通用名称和路径；环境特定的主机名、地址、Token 和邮箱地址必须保存在仓库之外。

## 先选择拓扑

DSH Hub 的认证模型在三种拓扑中保持一致。区别只在 Cloudflare 与 Hub Origin 之间怎样到达，不能因为使用内网或 VPN 就删除 Access、Hub 邮箱白名单或 Origin Secret。

| 拓扑 | 流量路径 | 主机入站端口 | 推荐场景 |
|---|---|---:|---|
| 单机域名 | Cloudflare → 反向代理 → 回环 Hub | 443 | 云服务器、最少组件 |
| Cloudflare Tunnel | Cloudflare → 出站 `cloudflared` → 本机反向代理 → 回环 Hub | 0 | NAS、家庭网络、无公网 IP |
| 入口与 Hub 分离 | Cloudflare → VPS 反向代理 → Tailscale/WireGuard → NAS Hub | VPS 443；NAS 0 | VPS 只做入口，Hub 与数据在 NAS |

Tunnel 和 Overlay Network 都只解决 Origin 可达性。Cloudflare 官方将 Tunnel 定义为无需开放入站端口的出站连接，并建议在 Self-hosted Application 上先配置 Access，再发布 Tunnel Route；本项目仍在 Hub 内验证 Application JWT 和操作员邮箱。参阅 [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/)、[发布 Self-hosted Application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)和 [Tunnel Access Origin 参数](https://developers.cloudflare.com/tunnel/advanced/origin-parameters/#access-settings)。

### 最小安全配置

以下六项是生产基线，不是可选增强：

1. 公共请求先通过 Cloudflare Access，人员 Allow Policy 只包含预期账号。
2. Hub 配置精确的操作员邮箱白名单，并独立验证 JWT Issuer、Audience、签名与时间声明。
3. Origin 只绑定回环、私网或 Overlay 接口；防火墙只允许受信任反向代理。
4. 反向代理先删除客户端提交的 Origin Secret Header，再注入只保存在服务器上的随机值。
5. 每个节点独享一个 Service Token、一套 Ed25519 身份和一个短期一次性注册码。
6. 容器镜像固定 Digest，状态目录仅容器 UID 可写，并保留可恢复的加密备份。

## 前置条件

- 一台安装 Docker Engine 和 Compose v2 的 Linux Docker 主机。
- 一个通过 Cloudflare Access 路由到受信任反向代理的 HTTPS 主机名。
- 一个同时配置人员策略和 Service Token 策略的 Cloudflare Access Self-hosted Application。
- 每个节点安装 Node.js 22.19 或更高版本、`npm` 和 DSH。目标 DSH 组合必须提供与传输无关的 `@deepseek-ai/dsh-host-apiproxy` Service；标准 Web Profile 已提供该 Service。安装 Node Agent 前，还应安装 `node-pty` 在该平台所需的 C/C++ 构建工具链和 Python。
- 反向代理到 Hub Origin 的私有路径，可以是回环、私有网络或经过认证的 Overlay Network。

## 1. 配置 Cloudflare Access

为 Hub 主机名创建一个 Self-hosted Access Application。添加允许操作员身份提供方的 Allow Policy，并添加包含节点 Service Token 的 Allow Policy。记录 Application Audience、Team Domain，并为每个节点创建一个不同的 Service Token。

按照 Cloudflare 当前的 [Self-hosted Access Application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)、[Access JWT 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)和 [Service Token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)指南配置。Application Audience 与 Service Token 身份必须和 Hub 自己的注册及 Ed25519 身份相互独立。

Hub 会独立验证 Access JWT。浏览器 JWT 必须携带白名单邮箱，节点 JWT 必须携带 Service Token `common_name`。有效的 Cloudflare Session 不能绕过 Hub 白名单或节点注册。

## 2. 配置受信任 Origin 路径

配置反向代理删除客户端提交的所有 `X-DSH-Origin-Secret` Header，并添加自己的固定随机值。转发 HTTP Upgrade，并对 SSE 禁用响应缓冲。Origin 只能通过回环或私有网络路由，其防火墙只允许代理访问。

直接访问 Hub IP 和端口的请求不包含代理持有的密钥，因此只会收到 Not Found。即使防火墙或 Overlay Network 已限制可达范围，仍必须启用 Origin Secret 检查。

### Nginx 示例

把真实 Secret 放进仅 Root 可读的独立片段，不要直接提交到主配置：

```nginx
# /etc/nginx/snippets/dsh-hub-origin-secret.conf，chmod 600
proxy_set_header X-DSH-Origin-Secret "replace-with-random-secret";
```

站点配置只引用该片段：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    include /etc/nginx/snippets/dsh-hub-origin-secret.conf;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

`proxy_set_header` 会用受保护片段中的固定值覆盖同名客户端 Header。配置审查必须确认没有另一个 `location` 绕过该片段。不同 Nginx 发行版需要自行定义 `$connection_upgrade` Map，或者使用等价的固定 Upgrade 配置。

### Cloudflare Tunnel 内网模式

在 Zero Trust Dashboard 创建 Tunnel，把 `hub.example.com` 的 Published Application Route 指向 `http://127.0.0.1:8443` 上的本机 Nginx/Caddy，而不是直接指向 Hub `8080`。本机反向代理负责注入 Origin Secret，再转发到回环 Hub。启用该 Route 的 **Protect with Access**，填写精确 Team Name 与 Application Audience；Hub 仍执行自己的 JWT 验证。

`cloudflared`、反向代理和 Hub 可以在同一台 NAS 上，主机防火墙拒绝全部互联网入站，只允许必要的出站 DNS、HTTPS/QUIC 与制品下载。Tunnel Token 与 Origin Secret 是不同凭据，不得复用。远程管理的 Tunnel 应在 Dashboard 配置 Route；本地管理的配置必须以一个 `http_status:404` Catch-all 结束。

### VPS 入口、NAS Hub 模式

VPS 的反向代理通过 Tailscale 或 WireGuard 私网地址访问 NAS Hub。NAS 端口只绑定 Overlay 接口，并用主机防火墙限制到 VPS 的确切 Overlay 地址。Origin Secret 只存在于 VPS 反向代理和 NAS Hub 环境中。不要让公网 DNS 解析或 Nginx 配置暴露 NAS 的真实地址，也不要把 Tailscale ACL 当成操作员登录。

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

打开 **设置 → Hub 节点**，输入稳定的节点 ID 和清晰的显示名称，然后生成短期注册授权。一次性注册代码只返回一次，Hub 仅保存其哈希。页面会立即生成 Linux／macOS 和 Windows 两种一键安装命令；选择目标系统并复制对应命令。

无人值守部署也可以先停止 Hub，再通过同一 Compose 项目执行离线管理命令；不得让离线命令与 Hub Server 并发写入状态 Volume：

```bash
docker compose stop hub
docker compose run --rm hub node /app/hub-server.mjs create-enrollment \
  --node-id workstation-1 --display-name "Workstation 1" --expires-in 900
docker compose up -d hub
```

离线命令输出包含一次性代码，必须直接传给目标节点，不得写入日志、工单或 Git。Hub UI 生成的一键命令会把这个 15 分钟有效、只能消费一次的代码放入 Shell 历史；消费后应按本机策略清理该历史项。离线创建操作会以 `local-admin` 身份进入审计链。

为该节点创建独立的 Cloudflare Access Service Token。不要在多个节点间复用 Token：逐节点 Token 可以独立轮换和吊销，Hub 还会将 Service Token 身份永久绑定到已注册的 Ed25519 节点密钥。

## 5. 运行一键安装命令

在目标电脑上以运行 DSH 的同一操作系统账户粘贴并运行 Hub UI 给出的一个命令。安装器会依次：

1. 从不可变的 GitHub Release 下载 Node Agent、Connector 和 `SHA256SUMS`，并在安装前验证两个产物。
2. 把 Node Agent 安装到 `~/.dsh-hub/runtime/<version>`，不会污染全局 npm 目录，也不会请求 Root 权限。
3. 通过 `dsh-hub-node init` 获取并固定 Hub 公钥，创建 Ed25519 节点身份、Connector IPC 密钥和仅所有者可读配置。
4. 把 Connector 作为 DSH Bundle 插件安装进现有 `web` Profile；它只增加一条 Cordis 配置项，不修改 Web 监听器、前端 Bundle 或会话存储。
5. 在 Linux 上安装 systemd User Service，在 macOS 上安装 LaunchAgent，在 Windows 上安装当前用户登录任务，并立即启动 Node Agent。

安装器会普通提示输入该节点的 Cloudflare Access Client ID，并隐藏输入 Client Secret。长期 Service Token Secret 不会出现在复制命令、进程参数或 Shell 历史中。如果 DSH 使用的 Profile 不是 `web`，可在 Linux／macOS 命令末尾增加 `--profile <name>`；高级或自定义进程管理器安装可使用 `--no-service`，并参照[节点服务指南](node-services.md)。

Connector 已经是客户端安装的 DSH 插件。Node Agent 刻意保留为同账户 Sidecar：它在 DSH Profile 重启或暂时停止时仍持有唯一节点身份、WSS 重连和可靠命令 Journal，也能让同一机器上的多个 Profile 共享一条节点连接。它不启动第二个 DSH Runtime，也不开放入站端口。

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

## 推荐安全增强

这些设置不改变产品模型，可按环境逐步增加：

- Cloudflare Access 开启较短 Session Duration、强制 MFA、Instant Auth，并在设备可管理时加入 Device Posture；
- 非回环的反向代理到 Origin 链路使用经过验证的 TLS 或 mTLS，不使用 `noTLSVerify`；
- Hub 与节点账户使用磁盘加密，备份加密后复制到不同故障域，并定期做隔离恢复演练；
- 限制 Hub 容器和 Node Agent 的出站目的地，同时保留 GitHub Release、npm、Cloudflare 和模型提供方所需地址；
- 把 Access、反向代理、Hub 审计与节点服务日志送到独立日志系统，监控连续认证失败、节点撤销、连接代次频繁变化、可靠队列压力和备份过期；
- 对节点工作区做操作系统级隔离。Hub 的“最高权限”指 Node Agent 账户的全部权限，不要求该账户拥有整台机器的管理员权限。

## 上线验收清单

- 隐私窗口访问域名时先进入 Cloudflare 登录，非白名单账号被拒绝；
- 直接访问 Origin IP/端口，`/healthz`、首页、REST、SSE 和 WebSocket 均不会泄露；
- 删除反向代理注入 Header 后公共入口失效，恢复后重新可用；
- 两个节点使用不同 Service Token，同时在线并各自创建会话；
- 停掉其中一个 Node Agent，另一个节点的聊天和设置仍然完成；
- 恢复离线节点后只重放该节点自己的积压，双向队列回落到接近零；
- 本地 Web、桌面端与 Hub 能交替继续同一会话；
- 备份文件权限、Manifest、SQLite 完整性和一次隔离恢复均已验证。
