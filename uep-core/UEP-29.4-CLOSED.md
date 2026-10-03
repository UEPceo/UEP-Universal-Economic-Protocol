> Historical: describes the 12-input circuit with 152_621 constraints. The current circuit (v3, with `domain_id` and the fee floor) measures 153_956 constraints at D=32 and 46_660 at D=4; see `uep-26-spend-circuit/README.md`.

# UEP-29.4 CLOSED

Closed 2026-09-26 after reproducible Groth16 evidence.

## Evidence

| File | Content |
|---|---|
| `artifacts/uep-29.4-evidence/benchmark-d4-prove-x3.json` | 3/3 OK, real prove_ms |
| `artifacts/uep-29.4-evidence/benchmark-d32-prove-x2.json` | 2/2 OK, real prove_ms |
| `artifacts/uep-29.4-evidence/circuit-id.txt` | tag, 152621, metadata ids |
| `uep-core/target/release/uep-zk` | release binary, built from source (`npm run build:uep-zk`) |

## Fixes in this closure

1. Cargo: build from the official crates.io registry
2. ark-ff 0.3: `into_repr` + `BigInteger`
3. Sequential nullifiers: hex parse without requiring `0x`
4. Benchmark: real CLI clocks (no 95/5)
5. Tests: no SKIP; FAIL if binary missing

## Reproduce

```bash
# if rebuilding:
./scripts/build-uep-zk.sh
# or use packaged binary:
export PATH="$PWD/uep-core/uep-26-spend-circuit/bin:$PATH"
node --experimental-strip-types --import ./scripts/register-ts-alias.mjs --test \
  src/core/poseidon-lab-benchmark.test.ts
```
