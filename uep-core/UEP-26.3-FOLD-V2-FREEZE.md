# UEP-26.3 — SpendCircuit fold freeze (hFoldV2)

**Status:** FROZEN  
**Date:** 2026-10-08  
**Version:** 0.5.5  
**Circuit tag:** `UEP-27-SPEND-POSEIDON-D32-v5-foldv2`

This freeze covers only the SpendCircuit transaction commitment. It does not
move the UEP-26 leaf encoding, note commitments, nullifiers, Merkle nodes, or
the wallet `canonicalTxCommitment` used by testnet transaction ids.

## Frozen formula

Domain tag `D_FOLD_V2 = 6`. Fold version `FOLD_V2_VERSION = 2`.

```text
acc0 = H(D_FOLD_V2, FOLD_V2_VERSION, domain)
acc1 = H(D_FOLD_V2, acc0, length)
acc  = H(D_FOLD_V2, acc, item)   for each item, including the empty list
```

`H` is the UEP-26 domain composition already frozen in UEP-26.2:

```text
H(d, a, b) = Poseidon(Poseidon(Fr(d), a), b)
```

Poseidon remains BN254, width 3, alpha 5. Poseidon2 is not used.

The commitment items, in order, are unchanged from v4:

```text
ENCODING_VERSION, old_state_root, new_state_root, old_nullifier_root,
new_nullifier_root, sender_id, recipient_id, treasury_id, asset_id,
amount, fee, nullifier, domain_id
```

`ENCODING_VERSION` stays 2. It is an item, not the fold version.

## What stays on hFold

`hFold` (singleton identity, no length) remains the historical fold for
settlement roots already returned by `settlementRoot` and for any pre-v5
proof. Note commitments stay `H_LEAF`.

## Migration

- v4 tag `UEP-27-SPEND-POSEIDON-D32-v4-assetkey` proofs do not verify under the v5 key.
- A prover must recompute `transaction_commitment` with `hFoldV2` / `h_fold_v2` and re-prove.
- No snapshot field is rewritten. Format 10 already records `foldVersion: 2`.
- `CIRCUIT_CONSTRAINTS` is still the v4 measurement (155393). Re-measure with `uep-zk count-constraints` before a ceremony. The v5 circuit adds the version and length hashes.

## Implementations

- Rust: `uep-core/uep-26-spend-circuit/hash_gadget.rs` (`h_fold_v2`, `h_fold_v2_gadget`, `tx_commitment`)
- TypeScript: `src/core/hash.ts` (`hFoldV2`) and `src/core/spend-circuit-freeze.ts`
