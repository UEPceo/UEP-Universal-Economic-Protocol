# Economic Model

This document summarizes the public testnet economic model without claiming a production financial system.

## Protocol fee

The public reference testnet fee remains a testnet parameter:

```text
fee = max(1, floor(amount × 10 / 10,000))
```

This is a 0.1% protocol fee. The minimum fee is deliberately kept as a compatibility and safety parameter for the reference network. This parameter should be evaluated against IoT/M2M micropayments and future asset-specific adjustments.

## Marketplace fee

The Marketplace applies a business-layer fee on successful settlement only:

| Rule | Value |
|---|---:|
| Marketplace fee | 3.0% of successfully settled service value |
| Minimum fee | 1 unit |
| Trigger | `SETTLED` only |
| Cancelled/expired order | No Marketplace fee |

## Treasury allocation

The treasury allocation described in the public reference is a simulation model, not a legal or commercial claim.

| Bucket | Allocation |
|---|---:|
| Operations | 40% |
| Risk reserve | 25% |
| Development | 20% |
| Operational buffer | 15% |

These allocations are for testnet modelling and system design discussion only. They do not constitute a dividend, investor right, token allocation, profit-sharing scheme, or any form of legal promise.

## Important limit

The public reference does not claim that the current fee model is suitable for all economic use cases, especially very small or machine-to-machine micropayments. Future work should explicitly review fee granularity, decimal scale and asset-specific units before any production claim is made.

See also [`docs/LEGAL-DISCLAIMER.md`](./LEGAL-DISCLAIMER.md).
