# 选择接入方式：Tailcat 配对与浏览器入口

[English](access-options.md) | 中文

先区分两件事：**浏览器怎样到达 Hub**，以及 **Hub 怎样确认你有操作权限**。Tailcat 和 Tailscale 可以解决前者；当前 Hub 的完整登录实现仍是 Cloudflare Access JWT、精确邮箱白名单和受信任代理的 Origin Secret。

## 按场景选，不从网络术语开始

| 你希望怎样使用 | 推荐方式 | 仓库当前支持程度 |
|---|---|---|
| 自己的一两台电脑，配对后连接个人 Hub | **Tailcat 设备配对：主推的轻量方向** | 有配对／转发脚本；设备免登录认证待实现 |
| 手机或任意浏览器打开域名就能登录 | **Cloudflare Access + 反向代理** | 已实现的完整生产路径，见[部署指南](deployment.zh.md) |
| NAS 没有公网 IP，也不想开入站端口 | 在上述路径中使用 Cloudflare Tunnel | 已有部署步骤，保留现有登录 |
| 多台设备已经使用 Tailscale | 用 Tailnet 连接反向代理和 Hub；Serve 可提供私有入口 | 私网传输可用；Hub 尚未把 Serve 身份 Header 当作操作员登录 |
| 想自行维护设备网络控制面 | 评估 Headscale，再接入受支持的 Hub 认证入口 | 外部网络选项，没有随仓库提供一键集成 |

**现在就要部署可用服务：走 Cloudflare Access 教程。想评估不依赖账号系统的个人设备接入：从下面的 Tailcat 脚本开始。** 不应仅设置端口转发就删除 Hub 的现有认证配置。

## Tailcat 为什么值得主推

对少量固定设备，理想的操作流程很短：设备自己保管私钥，Hub 主机只登记公开 `nodekey`；以后复用身份运行连接脚本。无需为每台浏览器设备维护一套公网反向代理配置，也不需要改动 DSH 的本地 Web 服务。

这三个脚本围绕这个流程组织：

| 脚本 | 在哪台机器运行 | 做什么 |
|---|---|---|
| [`enroll-client.sh`](../../deploy/tailcat/enroll-client.sh) | 操作员电脑 | 生成并保存客户端密钥，打印可交给 Hub 管理者的公钥 |
| [`serve-hub.sh`](../../deploy/tailcat/serve-hub.sh) | Hub 所在主机 | 把一个本地 TCP 端口交给 Tailcat，只允许配置的客户端公钥 |
| [`connect-hub.sh`](../../deploy/tailcat/connect-hub.sh) | 操作员电脑 | 使用保存的客户端密钥，把远端端口转发到本机 `127.0.0.1` |

Hub 放在 Docker 中也可以使用：让容器端口只发布到 NAS 宿主机的回环地址，再在宿主机运行 Tailcat。容器不需要安装 VPN 客户端、访问 TUN 设备或获得额外权限。节点仍通过原有 Node Agent 连接 Hub。

Tailcat 使用加密隧道和 NAT 穿透，不需要 Tailscale 账号；它与 `tailscaled` 是独立工具。更多底层说明见 [Tailcat 官方介绍](https://tailscale.com/tailcat)。

## 当前脚本能做什么，不能做什么

| 能力 | 状态 |
|---|---|
| 生成持久客户端身份、仅允许指定公钥、复用服务端身份 | 已由脚本提供 |
| 默认只在客户端回环地址监听，指定本地和远端端口 | 已由脚本提供 |
| 在 NAS 宿主机转发容器映射端口 | 可用的部署方式，前提是宿主机能访问该端口 |
| 将 Tailcat 对端公钥映射为 Hub 操作员，并签发浏览器会话 | **尚未实现** |
| 用 Tailcat 替换 Node Agent 的 Access Service Token 和注册流程 | **尚未实现** |
| 在 Hub 页面管理 Tailcat 设备或即时撤销其浏览器会话 | **尚未实现** |

因此以下步骤是**设备隧道验证**，不是免登录 Hub 的完整安装教程。原始 Hub 端口仍要求 Origin Secret 与应用认证；浏览器 Origin 和 Cookie 也不能仅靠改为 `localhost` 就自动迁移。

## 试用：一次配对，以后运行连接脚本

### 准备

在 Hub 主机与操作员电脑分别按[官方安装指南](https://github.com/tailscale/tailcat/blob/main/INSTALL.md)安装 Tailcat，确认 `tailcat --help` 可运行。以下 Bash 脚本面向 Linux／macOS；Windows 的 Hub 节点安装器已有 PowerShell 版本，但仓库尚未提供 Tailcat 配对脚本的 PowerShell 版本。

以下命令均在本仓库根目录运行。示例假定 Hub 已按[部署指南](deployment.zh.md)启动，宿主机回环端口为 `8080`，客户端选择 `18080` 避免冲突。若部署端口不同，两端的 `DSH_HUB_PORT` 都要相应修改。

### 1. 在操作员电脑生成身份（只需一次）

```bash
bash deploy/tailcat/enroll-client.sh
```

默认保存名为 `client-default` 的客户端密钥。将输出的 **`nodekey:…` 公钥**交给 Hub 主机配置；不要复制私钥文件，也不要在每次连接时重新生成密钥。

### 2. 在 Hub 主机允许这个设备

首次使用先保存服务端密钥：

```bash
tailcat genkey --key=default --fixed-region
```

然后填写上一步的完整公钥并启动隧道：

```bash
export TAILCAT_ALLOWED_NODEKEY='nodekey:<替换为完整客户端公钥>'
export DSH_HUB_PORT=8080
bash deploy/tailcat/serve-hub.sh
```

保存服务端打印的 `tc…` 地址，并保持进程运行。脚本不创建后台系统服务。它拒绝在未设置公钥白名单时启动；底层 Tailcat 负责校验实际公钥。服务端密钥与固定中继区域的说明见[官方密钥管理](https://github.com/tailscale/tailcat/blob/main/README.md#key-management)。

### 3. 在操作员电脑连接

```bash
export TAILCAT_ADDRESS='tc<替换为服务端打印的地址>'
export DSH_HUB_PORT=8080
export DSH_HUB_LOCAL_PORT=18080
bash deploy/tailcat/connect-hub.sh
```

脚本在前台保持连接，并只绑定 `127.0.0.1`。以后连接时复用这一步，无需重新注册设备。

### 4. 验证隧道，不把网络连通误认为登录成功

在操作员电脑另开终端：

```bash
curl --include http://127.0.0.1:18080/healthz
```

对标准 Hub Origin，预期是 **HTTP 404**：请求已通过隧道到达 Hub，但没有受信任代理注入的 Origin Secret。还应在 Hub 主机直接请求 `http://127.0.0.1:8080/healthz`，核对相同行为与服务日志；单个 404 本身不能证明公钥白名单有效。

设备拒绝验证应使用另一台未获准设备或独立的新客户端密钥发起连接，确认不能取得来自 Hub 的 HTTP 响应。不要把同一份获准私钥复制过去测试。隧道超时或拒绝连接时，先检查两端进程、地址、公钥和端口，不要通过移除 `--allow` 来“修好”访问。

**此时打开 `http://127.0.0.1:18080` 还不能直接使用 Hub。** 日常浏览器继续访问已经配置好的 HTTPS 登录入口。不要在浏览器中注入 Origin Secret，也不要关闭 Hub JWT 校验。

### 可调参数

| 变量 | 默认值 | 作用 |
|---|---|---|
| `TAILCAT_BIN` | `tailcat` | 自定义 Tailcat 可执行文件路径 |
| `TAILCAT_CLIENT_KEY` | `client-default` | 客户端保存的密钥名；生成与连接时必须相同 |
| `TAILCAT_SERVER_KEY` | `default` | 服务端保存的密钥名；临时试验可显式设为 `new` |
| `TAILCAT_ALLOWED_NODEKEY` | 无，必填 | 服务端允许的客户端公开身份 |
| `TAILCAT_ADDRESS` | 无，必填 | 客户端使用的服务端地址 |
| `DSH_HUB_PORT` | `3000` | 两端约定的服务端本地端口；标准 Compose 请显式设为 `8080` |
| `DSH_HUB_LOCAL_PORT` | `3000` | 客户端回环监听端口；上述示例设为 `18080` |

## 设备信任认证方案：下一阶段的目标

我们希望最终的体验是：**明确批准自己的设备后，它可以进入具有全部操作权限的个人 Hub，不必每次再做账号登录。** 这是设计目标，不能用当前脚本宣称已经完成。

实现时应增加独立的私有认证入口：从经过验证的 Tailcat 连接取得对端公钥，查询批准设备，把它映射到唯一操作员并签发 Hub 会话。公网入口继续使用原有 Cloudflare Access 策略，两条路径分别验证，不能因为请求来自 localhost 或带有自报 Header 就认为它可信。

现有 `serve` TCP 转发不会给普通 HTTP 请求附加可被 Hub 直接信任的对端身份。身份桥接需要使用 Tailcat 提供的受信任连接上下文或专用适配器，并与现有浏览器同源检查、Cookie、WebSocket 和审计一起实现、测试。完成标准至少包括：

- 获准设备可进入、未获准设备被拒绝，复制普通请求 Header 不能绕过认证；
- 每次登录与关键操作能追溯到设备公钥；
- 撤销设备后，已有 HTTP 会话和 WebSocket 也失效；
- 公网 Access 入口与节点注册机制保持原有验证；
- 支持明确的浏览器 Origin，并通过桌面和移动端完整交互验证。

## 撤销与密钥保管

当前隧道层撤销方法：停止服务端进程以中断连接，删除该公钥配置或改为另一获准公钥，再重启服务。不要简单取消白名单后继续启动。密钥文件是软件身份，可被复制；设备丢失时应视为其私钥也可能泄露。

Tailcat 公钥、服务端 `tc…` 地址和私钥不是同一类数据。公钥用于配对，地址仍应通过私密渠道分享，私钥留在设备私有存储。Tailcat 没有集中设备管理服务，CLI／线协议也没有稳定性承诺；运行前固定并核对所用版本。公共中继为尽力服务，见[上游约束](https://github.com/tailscale/tailcat/blob/main/README.md)。

**撤销 Tailcat 隧道不等于吊销 Hub 节点**，也不等于撤销通过公网 Access 建立的登录。停止使用某台 DSH 机器时，在“Hub 节点”吊销其身份，并另行撤销它的 Service Token，参阅[运维手册](operations.zh.md)。

## 已有 Tailscale 时怎么选

若多台设备已经在同一个 Tailnet，先复用现有网络，把反向代理到 Hub 的私有连接放在 Tailnet 上即可。Tailscale Serve 还能为 Tailnet 提供私有 HTTPS 入口和身份 Header，但当前 Hub 尚未实现基于这些 Header 的登录适配。不能把 Serve 开通等同于 Hub 认证已完成。参见 [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)。

对于现有可用的公网 Hub，添加设备隧道应是独立的接入试验，不需要改变原域名的验证策略。这样可先验证网络路径，再逐步交付设备认证，而不是让一个尚未完成的方案中断日常使用。
