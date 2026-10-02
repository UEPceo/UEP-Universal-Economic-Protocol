# UEP-28.1 — Public-input alignment + ledger swaps

## Argument for touching the TS proof interface (pillar-adjacent)

The live wallet still uses **Development MAC**, not Groth16. The MAC previously folded **10** fields, while the frozen SpendCircuit exposes **12** public inputs (`treasury_id`, `asset_id` missing).

**Why change:** any future `ZkSpendProofProvider` must share the same public surface as Rust. Aligning now avoids a second breaking MAC migration later. 

**What changed:**
- `SpendPublicInputs` + MAC fold include `treasuryId` and `assetId` in SPEC §3 order.
- `SPEND_PUBLIC_INPUT_NAMES` length 12.
- Ledger `prepareSpend` / `submit` MAC verification updated.

**Not changed:** Poseidon, SMT, fee formula, R1CS, constraint count.

## Ledger swaps

`swapOnLedger` (TESTNET):

1. `simulateSwap` (AMM + optional oracle skew)
2. User `prepareSpend` → pool account (`tokenIn`)
3. `submit` (policy + nullifier + MAC)
4. Commit AMM reserves
5. Credit `tokenOut` via TESTNET faucet surface (virtual inventory)

Pool payout without `allowFaucet` remains blocked until signed pool legs exist.

## Tests

- `security-liquidity.test.ts` (schema + AMM)
- `swap.test.ts` (energy → EUR through pool)
- Existing ledger adversarial suite green
