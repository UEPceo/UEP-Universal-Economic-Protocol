# UEP-28.2 — Signed pool leg (no faucet payout)

## Problem

UEP-28.1 credited `tokenOut` with `ledger.faucet`, which **mints** supply instead of moving pool inventory.

## Solution

1. `derivePoolOperator(poolId)` → real `IdentitySecrets` (`accountId = H(secret, salt)`).
2. `fundPoolInventory` seeds pool notes once (TESTNET faucet only for **bootstrap**).
3. Swap legs:
   - **User → pool**: signed by user (`tokenIn`)
   - **Pool → user**: signed by pool operator (`tokenOut`)
4. Protocol fee applies on **both** legs (treasury receives feeOut on the payout leg).
5. Reject `POOL_INVENTORY` if pool balance < amountOut + feeOut.

## Not changed

Poseidon, SMT, SpendCircuit, fee formula, public-input schema.

## Tests

`src/node/swap.test.ts` — happy path + insufficient inventory.
