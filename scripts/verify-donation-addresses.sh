#!/usr/bin/env bash
# Compatibility wrapper (v0.5.3): the check moved to scripts/verify-donation-address.mjs,
# which also verifies the bech32 checksum offline (no dependencies, no network).
set -euo pipefail
exec node "$(dirname "$0")/verify-donation-address.mjs" "$@"
