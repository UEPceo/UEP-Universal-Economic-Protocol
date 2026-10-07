# Economic Model

This document summarizes the public testnet economic model without claiming a production financial system.

## Protocol fee

The public reference testnet fee remains a testnet parameter:

```text
fee = max(1, floor(amount × 10 / 10,000))
```

This is a 0.1% protocol fee. The minimum fee is deliberately kept as a compatibility and safety parameter for the reference network. This parameter should be evaluated against IoT/M2M micropayments and future asset-specific adjustments.

## Marketplace fee

The Marketplace applies a business-layer fee of 3.0 % (`MARKETPLACE_FEE_BPS = 300`,
`MIN_MARKETPLACE_FEE = 1`, `src/marketplace/economy.ts`) on the **part of an
escrow that is actually released to a provider**. The fee is computed once, by the
settlement engine, on the provider amount; whatever returns to the payer carries
no fee.

| Event | Marketplace fee |
|---|---|
| Marketplace order `SETTLED` | 3.0 % of the settled value (min 1 unit) |
| Marketplace dispute resolved as SPLIT | 3.0 % of the part released to the provider only |
| Category swap settled (`swap.settle`) | 3.0 % of the `fromAsset` leg paid to the market maker |
| Category relay settled / finalized / dispute verdict | 3.0 % of the price part paid to the provider (custody tranche included) |
| Category dispute verdict with releaseBps between 0 and 10 000 | 3.0 % of the released part only |
| Cancelled / expired / refunded order or leg | No fee |
| Bonds (relay provider bond, dispute bond) | Never charged a fee; slashed or forfeited shares move as transfers (see below) |

Bond transfers are not fees: a proven relay fraud pays 80 % of the provider bond to
the buyer and 20 % to `RISK_RESERVE`; a frivolous dispute pays 80 % of the bond to the
respondent and 20 % to `RISK_RESERVE`; since v0.5.3 a wrong key or no key pays 20 %
of the provider bond to the buyer, and a dispute that times out pays 20 % of the
claimant's bond to the respondent (`faultBondSlashBps`, `timeoutBondToRespondentBps`).

## Treasury allocation

Each collected Marketplace fee is split into four buckets (`DEFAULT_TREASURY_ALLOCATION_BPS`
in `src/marketplace/economy.ts`). The names below are the code names.

| Bucket (code name) | Allocation | Use in the reference code |
|---|---:|---|
| `OPERATIONS` | 40 % | operating costs (accounting only) |
| `RISK_RESERVE` | 25 % | reserve; also receives the treasury share of slashed / forfeited bonds |
| `PRODUCT_DEVELOPMENT` | 20 % | development (accounting only) |
| `DISTRIBUTABLE_PROFIT` | 15 % | funds the drip subsidy budget for nodes (an administrator-signed allowance, `allocateDripBudget`) |

Earlier versions of this document called the 15 % bucket an "operational buffer";
the code has always named it `DISTRIBUTABLE_PROFIT`, and in the reference code it is
spent only on drip subsidies paid to nodes for verified swap / relay work. The name is
a code identifier: it is **not** a dividend, investor right, token allocation,
profit-sharing scheme or any form of legal promise, and no holder of any asset has a
claim on it. These allocations are for testnet modelling and system design discussion
only.

## What the model does not include

- No native token and no common currency: fees are charged in the asset of the payment.
- No external payment rail: balances are testnet ledger entries.
- FX reference rates (ECB, BIS) are display-only and never move value (see `docs/ORACLE.md`).

## Important limit

The public reference does not claim that the current fee model is suitable for all economic use cases, especially very small or machine-to-machine micropayments. Future work should explicitly review fee granularity, decimal scale and asset-specific units before any production claim is made.

See also [`docs/LEGAL-DISCLAIMER.md`](./LEGAL-DISCLAIMER.md).
