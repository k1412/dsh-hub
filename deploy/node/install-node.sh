#!/usr/bin/env bash

# Install one released Hub Connector plugin and its persistent Node Agent
# without requiring root. Secrets are read from the controlling terminal so
# the long-lived Cloudflare credential does not enter shell history.

set -euo pipefail

readonly DSH_HUB_RELEASE_VERSION='@VERSION@'
readonly DSH_HUB_RELEASE_ROOT="https://github.com/k1412/dsh-hub/releases/download/hub-v${DSH_HUB_RELEASE_VERSION}"

hub_url="${DSH_HUB_URL:-}"
node_id="${DSH_HUB_NODE_ID:-}"
profile_name="${DSH_HUB_PROFILE:-web}"
state_directory="${DSH_HUB_STATE_DIRECTORY:-${HOME}/.dsh-hub}"
install_service=true
upgrade_existing=false

usage() {
  printf '%s\n' 'usage: install-node.sh --hub https://hub.example.com --node node-id [--profile web] [--no-service]'
  printf '%s\n' '       install-node.sh --upgrade [--profile web] [--state-directory PATH] [--no-service]'
}

while (($# > 0)); do
  case "$1" in
    --hub) hub_url="${2:-}"; shift 2 ;;
    --node) node_id="${2:-}"; shift 2 ;;
    --profile) profile_name="${2:-}"; shift 2 ;;
    --state-directory) state_directory="${2:-}"; shift 2 ;;
    --upgrade) upgrade_existing=true; shift ;;
    --no-service) install_service=false; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'install-node: unknown option %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$upgrade_existing" == false ]]; then
  if [[ ! "$hub_url" =~ ^https://[^/?#]+/?$ ]]; then
    printf '%s\n' 'install-node: --hub must be an HTTPS origin without a path, query, or fragment' >&2
    exit 2
  fi
  hub_url="${hub_url%/}"
  if [[ ! "$node_id" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then
    printf '%s\n' 'install-node: --node must contain 1-64 letters, digits, dots, underscores, or hyphens' >&2
    exit 2
  fi
fi
if [[ ! "$profile_name" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then
  printf '%s\n' 'install-node: --profile contains unsupported characters' >&2
  exit 2
fi

for required in node npm dsh curl mktemp; do
  if ! command -v "$required" >/dev/null 2>&1; then
    printf 'install-node: required command is missing: %s\n' "$required" >&2
    exit 1
  fi
done

if [[ "$install_service" == true ]]; then
  case "$(uname -s)" in
    Linux)
      command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1 \
        || { printf '%s\n' 'install-node: a working systemd user manager is required; use --no-service only when another supervisor is ready' >&2; exit 1; }
      ;;
    Darwin)
      for required in launchctl plutil; do
        command -v "$required" >/dev/null 2>&1 \
          || { printf 'install-node: required macOS command is missing: %s\n' "$required" >&2; exit 1; }
      done
      ;;
    *) printf '%s\n' 'install-node: this installer supports Linux and macOS; use install-node.ps1 on Windows' >&2; exit 1 ;;
  esac
fi

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 19) || major === 23) process.exit(1)' \
  || { printf '%s\n' 'install-node: Node.js 22.19+ or 24+ is required' >&2; exit 1; }

read_terminal() {
  local variable_name="$1"
  local prompt="$2"
  local secret="${3:-false}"
  local value
  if [[ ! -r /dev/tty ]]; then
    printf 'install-node: %s must be provided through the environment when no terminal is attached\n' "$variable_name" >&2
    exit 1
  fi
  if [[ "$secret" == true ]]; then
    IFS= read -r -s -p "$prompt" value </dev/tty
    printf '\n' >/dev/tty
  else
    IFS= read -r -p "$prompt" value </dev/tty
  fi
  printf -v "$variable_name" '%s' "$value"
}

access_client_id=""
access_client_secret=""
enrollment_code=""
if [[ "$upgrade_existing" == false ]]; then
  access_client_id="${DSH_HUB_ACCESS_CLIENT_ID:-}"
  access_client_secret="${DSH_HUB_ACCESS_CLIENT_SECRET:-}"
  enrollment_code="${DSH_HUB_ENROLLMENT_CODE:-}"
  [[ -n "$access_client_id" ]] || read_terminal access_client_id 'Cloudflare Access Client ID: '
  [[ -n "$access_client_secret" ]] || read_terminal access_client_secret 'Cloudflare Access Client Secret: ' true
  [[ -n "$enrollment_code" ]] || read_terminal enrollment_code 'Hub one-time enrollment code: ' true
  if [[ -z "$access_client_id" || -z "$access_client_secret" || -z "$enrollment_code" ]]; then
    printf '%s\n' 'install-node: credentials cannot be empty' >&2
    exit 1
  fi
fi

umask 077
mkdir -p "$state_directory"
chmod 700 "$state_directory"
temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/dsh-hub-install.XXXXXXXX")"
cleanup() {
  rm -rf -- "$temporary_directory"
  unset access_client_secret enrollment_code DSH_HUB_ACCESS_CLIENT_SECRET DSH_HUB_ENROLLMENT_CODE
}
trap cleanup EXIT HUP INT TERM

agent_asset="k1412-dsh-hub-node-agent-${DSH_HUB_RELEASE_VERSION}.tgz"
connector_asset="k1412-dsh-hub-connector-${DSH_HUB_RELEASE_VERSION}.tgz"
for asset in SHA256SUMS "$agent_asset" "$connector_asset"; do
  curl --fail --silent --show-error --location \
    --output "${temporary_directory}/${asset}" "${DSH_HUB_RELEASE_ROOT}/${asset}"
done

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$temporary_directory" && sha256sum --check SHA256SUMS)
elif command -v shasum >/dev/null 2>&1; then
  (cd "$temporary_directory" && shasum -a 256 --check SHA256SUMS)
else
  printf '%s\n' 'install-node: sha256sum or shasum is required to verify release assets' >&2
  exit 1
fi

runtime_prefix="${state_directory}/runtime/${DSH_HUB_RELEASE_VERSION}"
mkdir -p "$runtime_prefix"
printf '%s\n' '{"private":true,"allowScripts":{"node-pty":true}}' >"${runtime_prefix}/package.json"
npm install --prefix "$runtime_prefix" --no-package-lock --omit=dev --legacy-peer-deps \
  "${temporary_directory}/${agent_asset}"
if [[ "$(uname -s)" == Darwin ]]; then
  while IFS= read -r -d '' helper; do
    chmod 755 "$helper"
  done < <(find "${runtime_prefix}/node_modules/node-pty/prebuilds" -name spawn-helper -type f -print0)
fi
node -e 'require(process.argv[1])' "${runtime_prefix}/node_modules/node-pty" \
  || { printf '%s\n' 'install-node: node-pty native runtime validation failed' >&2; exit 1; }
agent_executable="${runtime_prefix}/node_modules/.bin/dsh-hub-node"
dsh_executable="$(command -v dsh)"
profile_directory="${DSH_HOME:-${HOME}/.dsh}/profiles/${profile_name}"
config_path="${state_directory}/node-agent.json"
package_directory="${state_directory}/packages"
mkdir -p "$package_directory"
connector_package="${package_directory}/${connector_asset}"
cp -- "${temporary_directory}/${connector_asset}" "$connector_package"
chmod 600 "$connector_package"

if [[ "$upgrade_existing" == true ]]; then
  [[ -f "$config_path" ]] \
    || { printf 'install-node: existing private config not found: %s\n' "$config_path" >&2; exit 1; }
  "$agent_executable" upgrade-connector \
    --config "$config_path" \
    --profile "$profile_name" \
    --connector "$connector_package"
else
  DSH_HUB_ACCESS_CLIENT_SECRET="$access_client_secret" \
  DSH_HUB_ENROLLMENT_CODE="$enrollment_code" \
    "$agent_executable" init \
      --hub "$hub_url" \
      --node "$node_id" \
      --access-client-id "$access_client_id" \
      --profile "$profile_name" \
      --runtime-id default \
      --profile-directory "$profile_directory" \
      --dsh-executable "$dsh_executable" \
      --install-connector "$connector_package"
fi

install_systemd_user_service() {
  local service_directory="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
  local service_path="${service_directory}/dsh-hub-node.service"
  mkdir -p "$service_directory"
  {
    printf '%s\n' '[Unit]'
    printf '%s\n' 'Description=DSH Hub outbound Node Agent'
    printf '%s\n' 'After=network-online.target'
    printf '%s\n' 'Wants=network-online.target'
    printf '\n%s\n' '[Service]'
    printf '%s\n' 'Type=simple'
    printf 'ExecStart="%s" --config "%s"\n' "${agent_executable//\\/\\\\}" "${config_path//\\/\\\\}"
    printf '%s\n' 'Restart=always' 'RestartSec=5' 'NoNewPrivileges=true' 'PrivateTmp=true' 'UMask=0077'
    printf '\n%s\n' '[Install]'
    printf '%s\n' 'WantedBy=default.target'
  } >"$service_path"
  chmod 600 "$service_path"
  systemctl --user daemon-reload
  systemctl --user enable --now dsh-hub-node.service
  systemctl --user restart dsh-hub-node.service
  if command -v loginctl >/dev/null 2>&1 && [[ "$(loginctl show-user "$(id -u)" -p Linger --value 2>/dev/null || true)" != yes ]]; then
    printf '%s\n' 'install-node: note: this user service stops after logout unless your administrator enables user lingering.'
  fi
}

xml_escape() {
  printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g; s/'"'"'/\&apos;/g'
}

install_macos_launch_agent() {
  local launch_directory="${HOME}/Library/LaunchAgents"
  local log_directory="${HOME}/Library/Logs/DSH Hub"
  local plist_path="${launch_directory}/top.k1412.dsh-hub-node.plist"
  mkdir -p "$launch_directory" "$log_directory"
  cat >"$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>top.k1412.dsh-hub-node</string>
  <key>ProgramArguments</key><array>
    <string>$(xml_escape "$agent_executable")</string>
    <string>--config</string>
    <string>$(xml_escape "$config_path")</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$(xml_escape "${log_directory}/node-agent.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "${log_directory}/node-agent-error.log")</string>
</dict></plist>
EOF
  chmod 600 "$plist_path"
  plutil -lint "$plist_path" >/dev/null
  launchctl bootout "gui/$(id -u)/top.k1412.dsh-hub-node" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist_path"
  launchctl enable "gui/$(id -u)/top.k1412.dsh-hub-node"
  launchctl kickstart -k "gui/$(id -u)/top.k1412.dsh-hub-node"
}

if [[ "$install_service" == true ]]; then
  case "$(uname -s)" in
    Linux) install_systemd_user_service ;;
    Darwin) install_macos_launch_agent ;;
  esac
fi

if [[ "$upgrade_existing" == true ]]; then
  printf '\n%s\n' "Node Agent and Connector are upgraded to ${DSH_HUB_RELEASE_VERSION}. Restart DSH profile ${profile_name} once to activate the Connector."
else
  printf '\n%s\n' "Node ${node_id} is installed. Restart DSH profile ${profile_name} once so it loads the Hub Connector plugin."
fi
if [[ "$install_service" == false ]]; then
  printf 'Start the Node Agent with: %q --config %q\n' "$agent_executable" "$config_path"
fi
