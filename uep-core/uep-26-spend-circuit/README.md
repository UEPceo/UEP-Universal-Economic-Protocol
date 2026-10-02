# UEP Spend Circuit (UEP-27.2)

**Proof-system hardening. Test keys only — no production ceremony.**

## Freeze

| | |
|---|---|
| Tag | `UEP-27-SPEND-POSEIDON-D32-v3-feefloor` |
| Constraints | 153_956 (D=32, `uep-zk count-constraints`) |
| Public inputs | 13 (domain_id is input 13) |
| circuit_hash (= circuit_metadata_id) | `0x421950477d1a7899a01050404db3ffa86ddd95540df116cb6226969f43f20822` |

## API

`setup` / `prove` / `verify` / `serialize_*` / `verify_independent`

D=4 measures 46_660. v3 adds the protocol fee floor: fee = max(1, floor(amount / 1000)) and amount > 0, the same rule as the public core (`src/core/fee.ts`). Earlier counts (153_098 for v2-domain, 152_621 for the 12-input circuit) are no longer current.
