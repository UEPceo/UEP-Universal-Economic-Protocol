/**
 * Wallet-layer Note (UTXO-shaped) prepared for UEP Crypto Core ZK Spend.
 *
 * Protocol state in UEP-25 is account-balance SMT. Notes are the local
 * spendable openings that sum to those balances. A future ZK spend circuit
 * will prove note opening + nullifier without revealing the note.
 *
 * Frozen leaf encoding (UEP-26.2, see uep-core/UEP-26-HASH-PARAMETERS-FREEZE.md §4):
 *   amount_fr       = Fr(amount)
 *   inner_asset     = H_LEAF(asset_id, amount_fr)
 *   payload         = H_LEAF(owner, inner_asset)
 *   note_commitment = H_LEAF(payload, blinding)
 *   note_nonce      = H_LEAF(note_commitment, blinding)
 *
 * Live public hash backend is the ordered SHA-256-to-BN254-field reference backend.
 * UEP-26 circuit design uses Poseidon domain composition (same formulas).
 *
 * Status: IMPLEMENTED / TESTED (native openings). ZK spend: CONCEPTUAL.
 */
import { Fr } from "./field.ts";
import { hLeaf } from "./hash.ts";
import { u64ToFr } from "./encoding.ts";

export type Note = {
  assetId: Fr;
  amount: bigint;
  owner: Fr;
  blinding: Fr;
  commitment: Fr;
  nonce: Fr;
  spent: boolean;
};

export function notePayload(owner: Fr, assetId: Fr, amount: bigint): Fr {
  return hLeaf(owner, hLeaf(assetId, u64ToFr(amount)));
}

export function noteCommitment(owner: Fr, assetId: Fr, amount: bigint, blinding: Fr): Fr {
  return hLeaf(notePayload(owner, assetId, amount), blinding);
}

export function openNote(note: Note): boolean {
  if (note.amount < 0n || note.amount >= 2n ** 64n) return false;
  return note.commitment.eq(noteCommitment(note.owner, note.assetId, note.amount, note.blinding));
}

/**
 * Bind a note-specific nonce so two notes of the same owner never share a nullifier.
 * nonce = H_LEAF(commitment, blinding)
 */
export function noteNonce(commitment: Fr, blinding: Fr): Fr {
  return hLeaf(commitment, blinding);
}

export function makeNote(owner: Fr, assetId: Fr, amount: bigint, blinding: Fr): Note {
  const commitment = noteCommitment(owner, assetId, amount, blinding);
  return {
    assetId,
    amount,
    owner,
    blinding,
    commitment,
    nonce: noteNonce(commitment, blinding),
    spent: false,
  };
}

export function serializeNote(note: Note) {
  return {
    assetId: note.assetId.toHex(),
    amount: note.amount.toString(),
    owner: note.owner.toHex(),
    blinding: note.blinding.toHex(),
    commitment: note.commitment.toHex(),
    nonce: note.nonce.toHex(),
    spent: note.spent,
  };
}

export function deserializeNote(data: ReturnType<typeof serializeNote>): Note {
  return {
    assetId: new Fr(data.assetId),
    amount: BigInt(data.amount),
    owner: new Fr(data.owner),
    blinding: new Fr(data.blinding),
    commitment: new Fr(data.commitment),
    nonce: new Fr(data.nonce),
    spent: data.spent,
  };
}
