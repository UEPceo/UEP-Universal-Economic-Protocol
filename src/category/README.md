# Category modules: hashlock swap, relay, dispute, drip (`src/category`)

| Field | Value |
|---|---|
| Status | Implemented (testnet) |
| Since | 0.5.2 (hardened 0.5.3) |
| Tests | npm run test:category |
| Depends on | Marketplace ports, core |

## Purpose

Hashlock swap (bilateral, SHA-256 hashlock; not an AMM), paid relay with chunk fraud proofs, k-of-n dispute quorum with bonds, drip subsidies bound to the settlement index. v0.5.3: V52-01/02/03 fixes, per-asset bond minimum, ported tests and a deterministic fuzz test (`category-hardening.test.ts`).

## Notes

- Residual limits (arbiters, Sybil, liveness, IoT attestation, HPKE, SHA-256 commitments) are listed in `docs/CATEGORY-MODULES.md`.

Full module map: [`docs/MODULES.md`](../../docs/MODULES.md).
