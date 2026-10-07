# Digital services Marketplace (`src/marketplace`)

| Field | Value |
|---|---|
| Status | Implemented (testnet) |
| Since | 0.3.0 |
| Tests | npm run test:marketplace, npm run simulate:20k |
| Depends on | core, settlement, oracle (optional gate), service (content hash), network, testnet, identity |

## Purpose

Listings, capacity, orders, HOLD and reservation lifecycle, delivery hashing, reputation, signed order actions, disputes, paymaster, Marketplace treasury buckets (3 % fee), category escrow ports. v0.5.3: snapshot / restore with settlement receipts (format 2), `anchorSettlements(ledger)`, optional oracle reference prices on listings.

## Notes

- Accounting only: no real-world funds move.
- Fees are charged in the asset of the payment; there is no native token.

Full module map: [`docs/MODULES.md`](../../docs/MODULES.md).
