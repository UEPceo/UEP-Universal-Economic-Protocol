# Settlement engine and ledger anchors (`src/settlement`)

| Field | Value |
|---|---|
| Status | Implemented (testnet) |
| Since | 0.5.2 (anchors 0.5.3) |
| Tests | npm run test:settlement |
| Depends on | core, Marketplace types |

## Purpose

Single payout executor (plan, then commit) with value conservation checks; canonical receipts (v2 binds the networkId, v1 verifies through a versioned alias); RFC 9162 receipt batches, inclusion proofs and, since v0.5.3, a cumulative receipt log with consistency proofs; `anchor.ts` builds and checks the anchors the ledger stores.

## Notes

- Anchors record settled value; they do not move ledger balances (`docs/SETTLEMENT-BRIDGE.md`).

Full module map: [`docs/MODULES.md`](../../docs/MODULES.md).
