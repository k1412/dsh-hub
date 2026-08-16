# Run the DSH Hub Node Agent as a service

English | [中文](node-services.zh.md)

The Node Agent must run as the same operating-system account that owns the managed DSH profile. It intentionally receives that account's full authority over DSH plugins, snapshots, files, and terminals. Service installation must not add administrator or root privileges.

Complete [node enrollment](deployment.md) before creating a service. Replace every example path with the absolute paths printed by `dsh-hub-node init` and discovered with `command -v dsh-hub-node`.

## Linux systemd user service

Create `~/.config/systemd/user/dsh-hub-node.service`:

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

Load and verify the service:

```sh
systemctl --user daemon-reload
systemctl --user enable --now dsh-hub-node.service
systemctl --user status dsh-hub-node.service
journalctl --user --unit dsh-hub-node.service --follow
```

A user service stops when the user session ends unless the administrator enables lingering for that account. A system service is also supported when it sets an explicit unprivileged `User=`, the same home directory, and the same absolute configuration path.

## macOS LaunchAgent

Create `~/Library/LaunchAgents/top.example.dsh-hub-node.plist`. Keep this as a LaunchAgent, not a system LaunchDaemon, so it runs as the DSH profile owner.

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

Validate, load, and inspect the service:

```sh
plutil -lint ~/Library/LaunchAgents/top.example.dsh-hub-node.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/top.example.dsh-hub-node.plist
launchctl enable "gui/$(id -u)/top.example.dsh-hub-node"
launchctl kickstart -k "gui/$(id -u)/top.example.dsh-hub-node"
launchctl print "gui/$(id -u)/top.example.dsh-hub-node"
```

LaunchAgents do not inherit an interactive shell's `PATH`. Use the real absolute executable path and ensure its Node.js runtime remains present across upgrades. Keep the plist and log directory owner-only.

## Windows Task Scheduler

Create a task for the DSH profile owner that starts at sign-in, restarts on failure, and does not use the highest-privilege option. Set the program to the absolute `dsh-hub-node.cmd` path and arguments to `--config C:\absolute\path\to\node.json`. Do not embed Service Token or enrollment secrets in task arguments or environment variables.

The Connector and Node Agent use an HMAC-authenticated named pipe on Windows. Ensure the DSH process and the scheduled task run under the same user identity and protect the shared secret with owner-only file permissions.

## Coexistence with local clients

The Connector is a plugin in the existing DSH Cordis Context. It consumes the same transport-independent `ApiProxy` Host service reached by the local Web UI and desktop client; it does not start a second DSH runtime, proxy DSH Web, or become the session owner. Load one Connector in each DSH runtime that should be visible in Hub and assign every independently running runtime a unique `DSH_HUB_RUNTIME_ID`.

After the one required DSH restart that loads a newly installed Connector, use this acceptance sequence:

1. Create a conversation in the desktop client and send a uniquely identifiable message.
2. Open the same conversation in the local Web UI and continue it.
3. Open the node and conversation in Hub, verify both earlier events, and continue it again.
4. Return to both local clients and verify the Hub event appears without creating a duplicate conversation.
5. Stop the Node Agent, then continue the conversation from the desktop client and local Web UI. Both local surfaces must continue operating.
6. Start the Node Agent and verify that Hub reconnects, reconciles the session index and event cursor, and shows the local changes once without replaying a command twice.

If a desktop application and Web application own separate DSH processes, treat them as separate runtimes. Never make concurrent DSH processes write the same session database or profile directory; Hub composes runtimes at the node level instead of merging their storage.

## Upgrade and removal

Stop the Node Agent service, verify the new release checksum, upgrade the global Node Agent package, and start the service. Connector upgrades are applied by Node Agent's exact-version plugin reconciliation and require a DSH profile restart to load the new plugin code.

To remove Hub access, revoke the node in Hub first, stop and disable its service, remove the Connector row from the DSH profile, and then remove the owner-only Node Agent state directory. Revocation immediately prevents the old node key and Service Token identity from controlling the Hub enrollment.
