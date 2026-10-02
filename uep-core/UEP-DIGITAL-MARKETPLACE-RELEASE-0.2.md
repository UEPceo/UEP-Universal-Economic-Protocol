# UEP Digital Marketplace 0.2 — Security/UX Release

Date: 2026-10-01

## Scope

This release hardens the business-layer marketplace without modifying UEP consensus, ZK or SMT.

## Implemented

- Atomic in-process inventory reservation with a documented production DB requirement for `SELECT ... FOR UPDATE` or an equivalent conditional update.
- Mandatory-capable `Idempotency-Key` flow for order creation and HTTP mutation metadata.
- 10-minute reservation TTL with automatic capacity release on expiry.
- Buyer/provider/admin order access checks through caller identity.
- Transparent checkout quote endpoint and fee/net estimates before payment.
- Bayesian seller reputation with settled-value, age and bond weighting; self-review and repeated-order review protections.
- Seller listing rate limiting (10/hour default).
- Exact catalog fingerprinting plus normalized title similarity protection for textual listings.
- Optional delivery validator hook for automated license/API/result validation before settlement.
- Marketplace Sentinel UI available from Wallet → More → Marketplace.
- 20/20 marketplace unit/security tests pass in the available Node runtime.

## Economic policy

Marketplace fee remains **3.00% of SETTLED gross service value**. The 3% business fee remains separate from the planned 0.10% UEP protocol fee.

Treasury allocation remains:

- 40% Operations
- 25% Risk Reserve
- 20% Product Development
- 15% Distributable Profit

## Production boundary

The current marketplace remains a business-layer/testnet ledger. It does not claim custody of real EUR/USD/BTC. A production deployment must use a durable transactional database, real authentication/RBAC, durable idempotency constraints and an appropriate regulated payment/custody rail where applicable.
