#!/usr/bin/env bash
set -euo pipefail

# Tunnel a localhost port to one allowlisted client key. This controls network
# access only: Hub still requires its application authentication. The private
# client key stays on the device; only the public nodekey is configured here.
tailcat_bin="${TAILCAT_BIN:-tailcat}"
hub_port="${DSH_HUB_PORT:-3000}"
tailcat_key="${TAILCAT_SERVER_KEY:-default}"
allowed_nodekey="${TAILCAT_ALLOWED_NODEKEY:-}"

if [[ -z "$allowed_nodekey" ]]; then
  echo "TAILCAT_ALLOWED_NODEKEY is required (for example nodekey:abc123...)" >&2
  exit 2
fi
if [[ "$allowed_nodekey" != nodekey:* || "${#allowed_nodekey}" -lt 16 ]]; then
  echo "TAILCAT_ALLOWED_NODEKEY must be a nodekey:... public key" >&2
  exit 2
fi
if [[ ! "$hub_port" =~ ^[0-9]+$ ]]; then
  echo "DSH_HUB_PORT must be a numeric local Hub port" >&2
  exit 2
fi

cat >&2 <<'EOF'
Tailcat access is device-bound to the allowlisted nodekey.
Keep the printed tailcat address private, and stop this process to revoke the
current connection. Remove the nodekey and restart this process to revoke the
device permanently.
EOF

exec "$tailcat_bin" serve \
  --key="$tailcat_key" \
  --allow="$allowed_nodekey" \
  "$hub_port"
