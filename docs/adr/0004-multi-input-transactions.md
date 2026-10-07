# ADR 0004 — Multi-input transactions (UEP-C04)

Status: **IMPLEMENTED (v0.5.3, testnet reference)**

## Context

Up to v0.5.2 a transaction carried one nullifier, so it could consume one note.
Paying from several notes needed `preparePayment()` + `submitBatch()`: an atomic
batch of single-input spends, each paying its own protocol fee (0.1 %, per-asset
floor).

## Decision

A transaction may consume **1 to 8 notes** (`MAX_TX_INPUTS`).

| Field | Single input (unchanged) | Multi-input (new) |
|---|---|---|
| `version` | 1 | 2 (`MULTI_INPUT_TX_VERSION`) |
| `nonce`, `nullifier` | the input's | input 0's |
| `inputNonces`, `inputNullifiers` | absent | one per input, element 0 = `nonce` / `nullifier` |
| commitment | v0.5.2 fields | v0.5.2 fields + tag `UEP-TX-MULTI-INPUT-v1`, count, nonce vector, nullifier vector |
| `txId` | `H(commitment, nullifier)` | same rule (the commitment binds the vectors) |
| fee | `creatorFee(amount)` | **one** `creatorFee(amount)` for the whole transaction |
| outputs | recipient (+ change) | recipient (+ one change note): the inputs are consolidated |

Rules checked by the ledger (submit, pending queue and snapshot restore):

- vector shape: both vectors present, equal length 2..8, equal to the number of
  input commitments, element 0 = primary, no duplicate nullifier, version 2;
  version 2 without vectors is refused;
- each nullifier i is the sender-bound nullifier of nonce i
  (`signedSpendNullifier(sender, nonce_i)`), each nonce i is the nonce of input note i;
- every input note is owned by the sender, in the transaction asset, a member of
  the note tree, unspent; no nullifier already in the set;
- sum(inputs) ≥ amount + fee; outputs are exactly recipient `amount` and change
  `sum − amount − fee` (if > 0);
- multi-input spends are sender-signature spends only (the development MAC covers
  one nullifier);
- all nullifiers are inserted atomically; restore rebuilds the nullifier set from
  every vector and checks the seen-set size against the total number of nullifiers.

Reconciliation (`reconcile`, `markConflicts`): spends are taken in min(TxID) order;
a spend settles only if none of its nullifiers is already taken. For single-input
spends this is the previous "min(TxID) per nullifier" rule.

## Compatibility

- Single-input transactions are byte-for-byte the v0.5.2 form: same commitment,
  same txId, version 1. Old snapshots (formats ≤ 8) restore unchanged; no snapshot
  migration is needed because the new fields are optional and only appear in new
  multi-input transactions.
- A v0.5.2 node does not understand version-2 transactions (it would refuse them:
  more than one input commitment). Mixed-version networks must upgrade before
  creating multi-input spends.
- `preparePayment()` + `submitBatch()` stay available (deprecated in favour of
  `prepareMultiInputSpend()` when one fee per transaction is wanted).

## Not included

- **Self-consolidation** (sender = recipient) is still refused: the ledger rejects
  self-transfers. Notes are consolidated as part of a payment (one change note).
- The UEP-25/26 circuits prove one nullifier; a multi-input ZK statement is not
  implemented (see `docs/SECURITY-COVERAGE.md`, crypto alignment).

Tests: `src/testnet/multi-input.test.ts`.
