# UEP-26 Test Vector Plan

Status: candidate vectors; values become normative only after the hash/encoding freeze.

## Vector V-001 — valid transfer

- sender balance: 100000
- recipient balance: 0
- treasury balance: 0
- amount: 100000
- fee: 100
- sender new: 0
- recipient new: 100000
- treasury new: 100

Expected: arithmetic transition valid and conserved.

## Vector V-002 — insufficient sender

- sender balance: 99
- amount: 100

Expected: reject.

## Vector V-003 — fee manipulation

Use V-001 but expose fee `101`.

Expected: reject.

## Vector V-004 — nullifier replay

Generate two spends with identical sender secret and nonce.

Expected: same nullifier; second insertion rejected.

## Vector V-005 — wrong owner

Keep all public inputs from V-001 but alter sender secret.

Expected: ownership constraint fails.

## Vector V-006 — wrong Merkle sibling

Alter one sender path sibling while keeping the public old root unchanged.

Expected: membership constraint fails.

## Vector V-007 — wrong direction bit

Flip one sender path direction bit.

Expected: membership constraint fails.

## Vector V-008 — amount wraparound

Provide a field value representing an integer outside the allowed 64-bit range.

Expected: range constraint fails.

## Vector V-009 — transaction commitment mutation

Change amount while retaining the original transaction commitment.

Expected: transaction-binding constraint fails.

## Vector V-010 — cross-network contamination

Attempt to use a TESTNET state root/nullifier root in a GLOBAL-domain transaction.

Expected: domain-separated commitment/transition rejected.
