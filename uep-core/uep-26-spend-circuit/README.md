# UEP Spend Circuit (UEP-27.2)

**Proof-system hardening. Test keys only — no production ceremony.**

## Freeze

| | |
|---|---|
| Tag | `UEP-27-SPEND-POSEIDON-D32-v2-domain` |
| Constraints | 153_098 (D=32, measured 2026-10-01) |
| Public inputs | 13 (domain_id is input 13) |
| circuit_hash | `0x246ac9fafaef8b814f31ed9b86ee731f9cee9a7c14e9b35ca4b13ff7b1237a0a` |

## API

`setup` / `prove` / `verify` / `serialize_*` / `verify_independent`

D=4 measures 45_802. The previous D=32 count, 152_621, is the 12-input circuit and is no longer current.
