# UEP Marketplace — Paymaster + Browser ZK Worker Release 0.1

## Implemented

### Paymaster
- No native UEP token introduced.
- Gas is quoted in the same asset as the purchase.
- Quote TTL defaults to 10 minutes.
- Paymaster requires a funded per-asset reserve.
- Checkout exposes service price, 3% Marketplace fee, gas fee and buyer total before funding.
- Buyer funds `gross + gas`; seller payout remains `gross - 3% Marketplace fee`.
- Paymaster sponsorship is repaid from buyer escrow only at settlement.
- Cancellation/expiry releases an unused sponsorship.
- Capture is idempotent.
- Production requires a signed multi-source gas oracle or deterministic governance-approved schedule.

### Browser ZK proving
- Added a dedicated module WebWorker boundary.
- Main-thread client owns one request/promise and terminates stale workers.
- Abort/cancel is explicit.
- Worker dynamically loads a browser-compatible prover module and returns structured success/error responses.
- Existing Node Rust CLI remains explicitly non-browser; no false claim of browser Groth16 support was introduced.

## Verification

Marketplace + worker tests: **27/27 PASS**.

Global TypeScript check could not run in the materialized environment because `@types/node` is absent. This is recorded rather than treated as a pass.
