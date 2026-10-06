# Settlement Bridge and Layered Value Conservation

This document clarifies the operating model of the UEP repository: the ledger and the Marketplace are distinct layers.

## Core principle

Value conservation is not globally assumed across all layers.

- Ledger conservation is the invariant for the testnet ledger: inputs, outputs and fees match for a ledger transaction.
- Marketplace conservation is the invariant for the Marketplace layer: buyer debit, provider credit, fees and refunds must balance within the Marketplace state.
- A settlement bridge is the mechanism that translates Marketplace settlement into ledger state when the project chooses to represent a settlement through the ledger.

If no bridge is used, then the Marketplace and ledger operate as separate conservation domains. The project must explicitly model that boundary.

## Why the bridge matters

The project currently documents the Marketplace and the ledger as separate layers. That is a sound design boundary, but it creates a risk of partial settlement if a bridge is not clearly defined.

A bridge should make the following explicit:

1. The marketplace order transitions to a settlement intent.
2. The bridge records the exact settlement atom and its source order.
3. The bridge submits the ledger transfer or issuance step.
4. The bridge records the resulting ledger transaction hash or reference.
5. The marketplace is marked `SETTLED` only after bridge confirmation succeeds.
6. Failed or partial bridge attempts remain `PENDING` and are recoverable.

## Recommended settlement atom model

```ts
interface SettlementAtom {
  id: string;
  marketplaceOrderId: string;
  status: 'PENDING' | 'BRIDGE_SUBMITTED' | 'LEDGER_CONFIRMED' | 'COMPLETED' | 'FAILED';
  buyerDebit: bigint;
  providerCredit: bigint;
  fee: bigint;
  ledgerTxId?: string;
}
```

A bridge must treat the ledger as a finalization mechanism, not as proof that the Marketplace state itself was already conserved.

## Recovery and auditability

The bridge should store enough metadata to recover from interruption:

- original order id;
- gross value, fee and provider share;
- ledger submission status;
- transaction hash if a ledger transfer succeeded;
- timestamps and versioned bridge state.

Recovery must be explicit and idempotent. A replayed bridge operation must not double-apply settlement.

## Boundary discipline

This design is intentionally conservative:

- it does not claim global value conservation without a bridge;
- it does not claim that the Marketplace is automatically a ledger settlement network;
- it documents the necessary translation layer instead of pretending one does not exist.

The bridge is a safety and clarity feature, not a claim that the project is a production payment network.
