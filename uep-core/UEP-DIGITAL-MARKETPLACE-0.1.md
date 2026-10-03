# UEP Digital Services Marketplace v0.2

## Purpose

The Marketplace is a business-layer service built on top of UEP. It enables providers and buyers to discover and contract digital services while keeping marketplace economics separate from UEP consensus, ZK, SMT and protocol treasury logic.

No native marketplace or UEP token is introduced.

## Lifecycle

```text
LISTING
  -> ACCEPTED
  -> HELD
  -> DELIVERED
  -> SETTLED
```

Alternative terminal paths:

```text
ACCEPTED -> CANCELLED
HELD     -> CANCELLED
ACCEPTED -> EXPIRED
HELD     -> EXPIRED
```

A marketplace fee is created **only at SETTLED**.

## Service categories

- COMPUTE
- STORAGE
- API
- DATA

The model is intentionally generic so additional categories can be added without changing the settlement accounting model.

## Settlement semantics

For a service order:

1. Provider publishes a listing with asset, unit price and capacity.
2. Buyer accepts a quantity; capacity is reserved atomically within the process and receives a 10-minute reservation TTL by default. Production database adapters MUST use a transactional conditional update or row lock (for example SELECT ... FOR UPDATE).
3. Buyer funds the exact gross amount into the marketplace HOLD ledger.
4. Provider delivers bytes/results; the marketplace records a SHA-256 content hash and can run an optional automated delivery validator (for example, a license webhook/validator).
5. Optional expected-hash verification can reject tampered delivery before settlement.
6. Settlement consumes the HOLD and creates exactly one marketplace fee event.
7. Provider payout is gross minus marketplace fee.
8. Repeated settlement is idempotent and cannot create a second fee.
9. Cancellation/expiry releases HOLD and reserved capacity without generating marketplace revenue.

The current HOLD and treasury implementation is an accounting/testnet business ledger. API callers must supply caller identity for order access and mutation; HTTP adapters use `X-UEP-Caller-Id` and `Idempotency-Key`. It is **not a bank account, custody system or proof of external payment**.

## Marketplace economics

- Marketplace fee: **300 bps = 3.00%** of SETTLED gross service value.
- Checkout quote exposes the fee before payment; there is no late fee surprise.
- No marketplace fee for listing, search, ACCEPTED, HOLD, cancellation, expiry or failed delivery.
- Provider net: 97.00% before external payment-rail costs.

Fee allocation:

| Bucket | Share of marketplace fee | Purpose |
|---|---:|---|
| Operations | 40% | hosting, support, compliance, payment rails, monitoring |
| Risk Reserve | 25% | refunds, disputes, fraud and contingencies |
| Product Development | 20% | engineering, security, integrations, research |
| Distributable Profit | 15% | owner/entity profit pool after costs, liabilities, tax and approval |

Example for €100 SETTLED:

- Provider payout: €97.00
- Marketplace fee: €3.00
- Operations: €1.20
- Risk reserve: €0.75
- Product development: €0.60
- Distributable profit: €0.45

All accounting is per asset. Amounts are represented as integer atomic units; production integrations must define the asset's decimal precision.

## Treasury

Treasury ID:

`marketplace-treasury`

The treasury is segregated from any UEP protocol treasury. It records balances, fee entries and authorized withdrawals per asset.

Withdrawals require:

- unique withdrawal ID;
- beneficiary;
- reason;
- authorization reference;
- sufficient bucket balance;
- replay protection.

The software does not embed a founder private key. The production operating entity should control real funds through appropriate corporate accounts, regulated payment/custody providers and suitable authorization controls.

## UEP protocol fee separation

The UEP testnet protocol fee (0.1%, minimum 1 unit) must remain a separate protocol accounting event. It must not silently be mixed with the Marketplace 3.00% business fee.

## API surface

When a `DigitalServicesMarketplace` instance is attached to `UepServiceApi`, the HTTP layer exposes:

- `POST /v1/marketplace/listings`
- `GET /v1/marketplace/listings`
- `POST /v1/marketplace/orders`
- `GET /v1/marketplace/orders/:orderId`
- `POST /v1/marketplace/orders/:orderId/fund`
- `POST /v1/marketplace/orders/:orderId/deliver`
- `POST /v1/marketplace/orders/:orderId/settle`
- `POST /v1/marketplace/orders/:orderId/cancel`
- `GET /v1/marketplace/treasury/:asset`

HTTP responses serialize integer atomic amounts as decimal strings so JSON transport cannot lose precision.

## Production boundary

The Marketplace module does not claim that an external EUR/USD/BTC transfer occurred. A production payment adapter/custodian must be attached to turn the business ledger events into actual payment-rail movements.

The current implementation deliberately keeps that boundary explicit rather than pretending the test ledger is real custody.
