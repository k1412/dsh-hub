# 将 DSH Hub Node Agent 作为服务运行

[English](node-services.md) | 中文

Node Agent 必须使用拥有受管 DSH Profile 的同一个操作系统账户运行。它会有意获得该账户对 DSH 插件、快照、文件和终端的全部权限。服务安装不得额外授予管理员或 root 权限。

创建服务前应完成[节点注册](deployment.md)。把示例中的所有路径替换为 `dsh-hub-node init` 输出的绝对路径，以及通过 `command -v dsh-hub-node` 查到的路径。

## Linux systemd 用户服务

创建 `~/.config/systemd/user/dsh-hub-node.service`：

```ini
[Unit]
Description=DSH Hub Node Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/absolute/path/to/dsh-hub-node --config /absolute/path/to/node.json
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
UMask=0077

[Install]
WantedBy=default.target
```

加载并验证服务：

```sh
systemctl --user daemon-reload
systemctl --user enable --now dsh-hub-node.service
systemctl --user status dsh-hub-node.service
journalctl --user --unit dsh-hub-node.service --follow
```

除非管理员为该账户启用 lingering，否则用户会话结束时用户服务也会停止。也可以使用系统服务，但必须设置显式的非特权 `User=`、相同的主目录和相同的绝对配置路径。

## macOS LaunchAgent

创建 `~/Library/LaunchAgents/top.example.dsh-hub-node.plist`。它必须是 LaunchAgent 而不是系统 LaunchDaemon，确保服务以 DSH Profile 所有者身份运行。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>top.example.dsh-hub-node</string>
  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/to/dsh-hub-node</string>
    <string>--config</string>
    <string>/absolute/path/to/node.json</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>/absolute/path/to/logs/node-agent.log</string>
  <key>StandardErrorPath</key>
  <string>/absolute/path/to/logs/node-agent-error.log</string>
</dict>
</plist>
```

验证、加载并检查服务：

```sh
plutil -lint ~/Library/LaunchAgents/top.example.dsh-hub-node.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/top.example.dsh-hub-node.plist
launchctl enable "gui/$(id -u)/top.example.dsh-hub-node"
launchctl kickstart -k "gui/$(id -u)/top.example.dsh-hub-node"
launchctl print "gui/$(id -u)/top.example.dsh-hub-node"
```

LaunchAgent 不会继承交互式 Shell 的 `PATH`。必须使用真实的可执行文件绝对路径，并确保升级后对应 Node.js Runtime 仍然存在。Plist 和日志目录应仅允许所有者访问。

## Windows Task Scheduler

为 DSH Profile 所有者创建一个在登录时启动、失败后重启且不启用最高权限选项的任务。Program 使用 `dsh-hub-node.cmd` 的绝对路径，参数使用 `--config C:\absolute\path\to\node.json`。不得把 Service Token 或注册机密写入任务参数或环境变量。

Connector 与 Node Agent 在 Windows 上使用经过 HMAC 认证的 Named Pipe。应确保 DSH 进程和计划任务使用同一个用户身份运行，并以仅所有者可访问的文件权限保护共享密钥。

## 与本地客户端共存

Connector 是现有 DSH Cordis Context 中的插件。它使用本地 Web UI 和桌面客户端到达的同一个与传输无关的 `ApiProxy` Host Service；它不会启动第二个 DSH Runtime、代理 DSH Web，也不会成为会话所有者。每个需要在 Hub 中显示的 DSH Runtime 加载一个 Connector，并为每个独立运行的 Runtime 设置唯一的 `DSH_HUB_RUNTIME_ID`。

新安装的 Connector 只需重启一次 DSH 以完成加载，之后按照以下顺序验收：

1. 在桌面客户端创建对话并发送一条具有唯一标识的消息。
2. 在本地 Web UI 打开同一个对话并继续发送消息。
3. 在 Hub 中打开对应节点和对话，验证前两个事件，然后再次继续对话。
4. 返回两个本地客户端，确认 Hub 事件已经出现且没有创建重复对话。
5. 停止 Node Agent，然后分别从桌面客户端和本地 Web UI 继续对话。两个本地界面都必须正常工作。
6. 启动 Node Agent，确认 Hub 重新连接、协调会话索引和事件 Cursor，只显示一次本地变更且不会重复执行命令。

如果桌面应用和 Web 应用分别拥有独立的 DSH 进程，应把它们视为不同的 Runtime。不得让并发 DSH 进程写入同一个会话数据库或 Profile Directory；Hub 会在节点层组合 Runtime，而不是合并它们的存储。

## 升级与移除

停止 Node Agent 服务，验证新 Release 的校验和，升级全局 Node Agent 包，然后启动服务。Connector 升级由 Node Agent 的精确版本插件协调机制应用，需要重启 DSH Profile 才能加载新插件代码。

移除 Hub 接入时，应先在 Hub 中吊销节点，停止并禁用节点服务，从 DSH Profile 删除 Connector 配置项，最后删除仅所有者可访问的 Node Agent 状态目录。吊销会立即阻止旧节点密钥和 Service Token 身份继续控制该 Hub 注册。
