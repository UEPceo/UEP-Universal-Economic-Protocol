# UEP-ECON-03 — Client escrow / hold (lab)

## Rationale

1. **Problem:** in ECON-02 a client could accept several obligations against the
   same balance.
2. **Autonomy:** providers can rely on the payment being *reserved* until delivery
   or cancellation.
3. **Sanity:** hold = price + fee; settlement still follows ECON-01
   (conservation + treasury).
4. **Relation to real use:** economic capacity is committed before the service.
5. **Why now:** it closes the over-commitment gap left by ECON-02.
6. **Complexity:** a lab `EscrowBook`; **no** new BFT, ZK or Poseidon work; no token.

## Flow

```
acceptWithEscrow
  → canHold(available >= price + fee)
  → Obligation OPEN + Hold HELD

submitDelivery → planSettlement → multi-node BatchTx
  → completeSettlement → Hold CONSUMED + SETTLED

cancel OPEN → Hold RELEASED
DISPUTED → releaseDisputed → Hold RELEASED (lab; no automatic refund transaction)
```

## Available balance

`available(client) = chain.balance(client) − Σ holds HELD`

## Tests

`src/lab/uep-econ-03.test.ts` (7 tests). Run with `npm run test:lab -- uep-econ-03`,
or `npm run test:lab -- uep-econ` for all economic labs including the ECON-01
and ECON-02 regressions.

## Limitations

- A hold does **not** move funds on-chain (there is no escrow account in the SMT);
  it is a logical reservation over the balance view.
- On-chain escrow (a dedicated leaf) is explored in ECON-04.
- The fee policy is still experimental.
