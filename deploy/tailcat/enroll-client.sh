#!/usr/bin/env bash
set -euo pipefail

# Generate a persistent client identity. Give the printed nodekey (public
# value) to the Hub operator; the private key stays on this device.
tailcat_bin="${TAILCAT_BIN:-tailcat}"
client_key="${TAILCAT_CLIENT_KEY:-client-default}"

exec "$tailcat_bin" genkey --client --key="$client_key"
