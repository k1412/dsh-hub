#!/usr/bin/env bash
set -euo pipefail

# Forward the authenticated Tailcat port to localhost for a browser. The
# client automatically uses the saved client-default key when present.
tailcat_bin="${TAILCAT_BIN:-tailcat}"
tailcat_address="${TAILCAT_ADDRESS:-}"
remote_port="${DSH_HUB_PORT:-3000}"
local_port="${DSH_HUB_LOCAL_PORT:-3000}"

if [[ -z "$tailcat_address" ]]; then
  echo "TAILCAT_ADDRESS is required (the address printed by serve-hub.sh)" >&2
  exit 2
fi

exec "$tailcat_bin" forward "$tailcat_address" "${local_port}:${remote_port}"
