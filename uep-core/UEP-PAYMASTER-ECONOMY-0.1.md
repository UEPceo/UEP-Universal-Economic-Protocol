# UEP Marketplace Paymaster Economy v0.1

## Decision
The Marketplace does not introduce a native UEP gas token. The buyer pays network execution gas in the same asset used for the purchase.

## Flow
1. The checkout requests a gas quote for a bounded number of execution units.
2. The quote is denominated in the purchase asset and has a 10-minute expiry.
3. The Paymaster must hold a reserve in that asset before it can sponsor the operation.
4. The buyer sees `service price + gas fee` before funding.
5. The buyer funds the complete amount into escrow.
6. At settlement, the Marketplace fee (3%) is allocated to Marketplace Treasury and the quoted gas amount is captured by the Paymaster.
7. The provider receives `gross service price - Marketplace fee`; gas is not silently charged to the provider.
8. If the order fails before execution, the Paymaster sponsorship is released. A consumed execution fee is never hidden as a Marketplace fee.

## Why this is fair
- No native token is required.
- No hidden FX conversion occurs inside checkout.
- The gas quote is explicit, bounded and expires.
- The buyer, rather than the seller, pays for the buyer-initiated network execution.
- The Paymaster cannot sponsor more gas than its reserve.
- The Marketplace fee remains 3% of the service value only.

## Production oracle requirement
Production deployment must use a signed multi-source gas-cost oracle or a governance-approved deterministic fee schedule. The local implementation is deliberately deterministic and does not claim real-world FX or gas prices.
