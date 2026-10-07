#!/usr/bin/env bash
# Rust/ZK lab crates (uep-core). Shared target dir: uep-core/target.
#
# Tested crates:
#   uep-21-poseidon        Poseidon BN254 (t=3, alpha=5) native + R1CS gadget
#   uep-25-prototype       UEP-25 reference state machine (fee, nullifier, transition)
#   uep-26-spend-circuit   UEP-26 spend circuit + Groth16 (DEV keys) + uep-zk CLI
#   uep-23-state-transition  UEP-22/23 one-leaf transition (ported to the pinned arkworks 0.3 API in v0.5.3)
#   uep-24-atomic          UEP-24 atomic sender/recipient/treasury model (ported in v0.5.3; SMT is an interface)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/uep-core/target}"
for crate in uep-21-poseidon uep-25-prototype uep-26-spend-circuit uep-23-state-transition uep-24-atomic; do
  echo "== cargo test --release --locked ($crate)"
  # uep-21: tests/print_vectors.rs is a vector-printing helper written against a
  # newer arkworks API; the library and the R1CS test suite are tested instead.
  if [[ "$crate" == "uep-21-poseidon" ]]; then
    (cd "$ROOT/uep-core/$crate" && cargo test --release --locked --lib --test poseidon_r1cs)
  else
    (cd "$ROOT/uep-core/$crate" && cargo test --release --locked)
  fi
done
echo "Rust lab crates: OK"
