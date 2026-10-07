#!/usr/bin/env bash
set -euo pipefail

EXPECTED_BTC="bc1qd5mffpv02peagseacxc0g8xv38j3t9xw7h9wgf"
ACTUAL_BTC="$(grep -Eo 'bc1[a-z0-9]+' README.md docs/*.md 2>/dev/null | head -n 1 || true)"

if [[ -z "${ACTUAL_BTC}" ]]; then
  echo "❌ No BTC donation address found in public docs."
  exit 1
fi

if [[ "${ACTUAL_BTC}" != "${EXPECTED_BTC}" ]]; then
  echo "❌ BTC donation address mismatch!"
  echo "Expected: ${EXPECTED_BTC}"
  echo "Found:    ${ACTUAL_BTC}"
  exit 1
fi

echo "✅ Donation address matches expected public reference."
