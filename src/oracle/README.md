# Oracle policy layer (`src/oracle`)

| Field | Value |
|---|---|
| Status | Implemented (testnet) |
| Since | 0.5.2 (gate 0.5.3) |
| Tests | npm run test:oracle |
| Depends on | core only |

## Purpose

Source registry with key rotation, signed quotes domain-separated with the networkId, verifier, aggregator with per-key weight caps, risk policy and signed settlement authorizations; `OraclePolicyGate` checks Marketplace prices, IoT tariffs and hashlock-swap rates and fails closed.

## Notes

- Never holds balances and is not on the spend or consensus path.
- FX reference rates (ECB, BIS) are display-only. Data-source policy: `docs/ORACLE.md`.

Full module map: [`docs/MODULES.md`](../../docs/MODULES.md).
