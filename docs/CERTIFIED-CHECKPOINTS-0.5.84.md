# Certified checkpoints for validator synchronization (0.5.84, item 2)

Status: Experimental (lab). "Certified" is the technical term for "signed by a quorum (2f + 1) of the configured validator set".

## Body

`src/node/certified-checkpoint.ts`:

```
{ v: 1, networkId, domainId, height (BFT commit height), blockId, stateRoot,
  validatorSetHash, txCount, ledgerHeight }
```

Signature: Ed25519 over `"uep-certified-checkpoint-v1:" + stableStringify(body)` with the validator's pinned key. A validator signs **only its own head**: the last APPLIED height of its durable journal, whose post-root and block are the current ledger head (`/bft/checkpoint-sign`, authenticated v2 peer envelope). It never signs a body it has not applied.

A checkpoint is certified when at least 2f + 1 distinct validators of the bound set have valid signatures. Unknown signers, duplicates and signatures over another body do not count.

## Rejection rules

| Error | When |
|---|---|
| `CHECKPOINT_MALFORMED` | missing or ill-typed fields |
| `CHECKPOINT_CONTEXT_MISMATCH` | other network, domain or validator set (hash of ids and keys) |
| `CHECKPOINT_QUORUM_MISSING` | fewer than 2f + 1 valid distinct signatures |
| `CHECKPOINT_STALE` | not above the last accepted checkpoint, or behind / equal to the local ledger |
| `CHECKPOINT_CONFLICT` | this node applied the same height with another block or post-root |
| `CHECKPOINT_INCOMPATIBLE` | the offered snapshot does not match the checkpoint (root, ledger height, tx count, last block) |

`PeerNet.requireCertifiedCheckpoint = true` makes snapshot catch-up (`/snapshot`) conditional on a matching certified checkpoint from the same peer (`acceptSnapshotAgainstCheckpoint`), on top of the 0.5.81 rules (signature, height floor, history prefix). Accepted checkpoints are persisted in the unified store and reloaded at start.

## Tests

- `src/node/certified-checkpoint.test.ts`: quorum, duplicates, outsider signer, tampered body, context mismatch, stale, incompatible, conflict, uncertified.
- `src/node/bft-checkpoint-multiprocess.test.ts`: 4 validator processes; partition 2 | 2 (no side can certify, nothing finalizes); heal and converge; certify (4 signatures in the recorded run), every validator fetches, verifies and holds the same root; SIGKILL + restart keeps the checkpoint; 2-signature, stale and tampered checkpoints rejected; the cluster continues.

## Limits (residual)

- Validator processes in the harness hold no snapshot signing key, so the multi-process test exercises checkpoint certification and convergence by journal replay; snapshot installation against a checkpoint is covered by the single-process test only.
- Validator-set changes (epochs) are not handled: a checkpoint binds one fixed set.
- One machine, loopback proxies: no claim about real network conditions or independent operators.
