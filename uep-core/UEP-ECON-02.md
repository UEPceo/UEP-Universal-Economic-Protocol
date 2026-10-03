# UEP-ECON-02 — Service settlement (lab)

## Rationale

1. **Problem:** ECON-01 moves value; the payment still had to be tied to
   *something that happens* (a service).
2. **Autonomy:** providers can offer work and get paid through UEP economic state.
3. **Sanity:** settlement is an ECON-01 `BatchTx` (fee + treasury + conservation);
   no token.
4. **Relation to real use:** obligation → verifiable delivery → payment finalized
   on the multi-node lab.
5. **Why now:** the next link in the chain after ECON-01.
6. **Complexity:** a lab registry plus the existing transaction; **no** new
   BFT, ZK or Poseidon work.

## Flow

```
Provider registers an Offer (price, expectedResultDigest)
        ↓
Client accepts → Obligation OPEN
        ↓
Provider submitDelivery(resultDigest)
        ↓
planSettlement: digest match → BatchTx client → provider
        ↓
MultiNodeCluster propose/finalize (ECON-01)
        ↓
markSettled
```

## Verification (lab)

`resultDigest === expectedResultDigest` (SHA-256 of the agreed payload).

Oracles, ZK attestations and similar mechanisms are future work and are **not**
part of ECON-02.

## Rejections

| Case | reason |
|------|--------|
| No delivery | NOT_DELIVERED |
| Wrong digest | DIGEST_MISMATCH → DISPUTED |
| Not the provider | NOT_PROVIDER |
| Double settlement | ALREADY_SETTLED |
| Cancelled | CANCELLED |

## Fee

The same rule as ECON-01: `creatorFee(price)` from `src/core/fee.ts`
(0.1% with a 1-unit floor). This is a testnet rule, **not** a final fee model.

## Tests

`src/lab/uep-econ-02.test.ts` (7 tests: version, happy path, settlement without
delivery, digest mismatch, non-provider delivery, multi-node meaningful
settlement, cancellation). Run with `npm run test:lab -- uep-econ-02`.

## Not covered

- On-chain escrow / locking funds before delivery (see ECON-03 and ECON-04)
- Consensus about the service itself
- Automatic remuneration of network provers or relayers
- A production oracle
