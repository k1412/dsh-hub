#!/usr/bin/env bash
set -euo pipefail

# Forward a device-allowlisted tunnel to loopback. Hub application login and
# Origin checks still apply; this script does not mint an operator session.
tailcat_bin="${TAILCAT_BIN:-tailcat}"
client_key="${TAILCAT_CLIENT_KEY:-client-default}"
tailcat_address="${TAILCAT_ADDRESS:-}"
remote_port="${DSH_HUB_PORT:-3000}"
local_port="${DSH_HUB_LOCAL_PORT:-3000}"

if [[ -z "$tailcat_address" ]]; then
  echo "TAILCAT_ADDRESS is required (the address printed by serve-hub.sh)" >&2
  exit 2
fi

exec "$tailcat_bin" --key="$client_key" forward --bind=127.0.0.1 "$tailcat_address" "${local_port}:${remote_port}"
