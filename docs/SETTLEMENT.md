# Settlement engine (v0.5.2)

Status: **IMPLEMENTED (testnet reference)**. Business-layer payout accounting only.
Not a production settlement network, not a throughput claim, not ZK-ready.

The settlement engine (`src/settlement/engine.ts`) is the **single payout executor**
behind the Marketplace and the swap / relay categories. It closes one escrow into
provider net, Marketplace fee, captured gas and buyer refund. Order state stays
with the Marketplace (or the category that owns the hold).

- Amounts are `bigint` (ADR 0001). Height comes from an injected `HeightSource`
  (ADR 0002); the engine never reads a wall clock.
- Plan (pure) then commit. Re-entry and double execute are refused.
- Receipts are canonically hashed; batches use RFC 9162 over receipt hashes
  (`src/core/rfc9162-merkle.ts`). The incoming settlement batch that duplicated
  odd nodes and measured wall-clock throughput was not kept.
- The incoming `reference-ledger` duplicate was removed; the Marketplace balance
  maps are the ledger port.

Residual limits: in-process only; no consensus finality; no native token.
