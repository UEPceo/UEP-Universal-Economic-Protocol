#!/usr/bin/env bash
# Build the uep-zk helper (Groth16 lab tooling, DEV keys only) from source.
# No prebuilt binary is committed to this repository.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/uep-core/uep-26-spend-circuit"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/uep-core/target}"
echo "Building uep-zk (release) into $CARGO_TARGET_DIR ..."
cargo build --release --locked --bin uep-zk
BIN="$CARGO_TARGET_DIR/release/uep-zk"
test -x "$BIN"
echo "OK: $BIN"
"$BIN" circuit-id
