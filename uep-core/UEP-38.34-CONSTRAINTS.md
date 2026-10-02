# UEP-38.34 — measured constraint count

Measured 2026-10-01 with `uep-zk count-constraints` on the domain circuit.

| Depth | Constraints | Public inputs |
|---|---|---|
| D=4 | 45_802 | 13 |
| D=32 | 153_098 | 13 |

Tag: `UEP-27-SPEND-POSEIDON-D32-v2-domain`.

Public input 13 is `domain_id`. Inputs 1–12 are unchanged. The domain is also folded into the transaction commitment. Encoding version is 2.

The previous D=32 count, 152_621, belongs to the 12-input circuit. Documents dated before this measurement describe that circuit. They are not the current count.

The proving key remains DEV-TEST-KEYS. This measurement is not a ceremony.
