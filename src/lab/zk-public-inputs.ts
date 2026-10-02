/**
 * UEP-28.7 — Canonical ZK public-input binding.
 *
 * Authority: SpendCircuit / Rust Groth16 public-input order (SPEC §3).
 * The circuit transaction_commitment is:
 *   H_TX(ENCODING_VERSION=1, old_state_root, new_state_root,
 *        old_nullifier_root, new_nullifier_root,
 *        sender_id, recipient_id, treasury_id, asset_id,
 *        amount, fee, nullifier)
 * (Poseidon domain fold — computed in Rust; TS consumes the result.)
 *
 * Legacy UEP-25 `computeTxCommitment` (network + notes) remains for MAC path only.
 * ZK path MUST use the circuit publics from the prover: 12 economic publics plus
 * domain_id (index 12) since UEP-38.34 (circuit tag ...-D32-v2-domain).
 */

import { Fr } from "../core/field.ts";
import type { SpendPublicInputs } from "../core/spend-proof.ts";
import { SPEND_PUBLIC_INPUT_NAMES, publicInputsOrdered } from "../core/spend-proof.ts";
import type { ZkSpendProof } from "./zk-spend-provider.ts";

export const ZK_PUBLIC_INPUT_COUNT = 13;
/** Economic publics mapped onto SpendPublicInputs (indices 0..11). */
export const ZK_ECONOMIC_PUBLIC_COUNT = 12;

export const ZK_TX_COMMITMENT_FORMULA =
  "Poseidon H_TX(ENCODING_VERSION=1 || old_state_root || new_state_root || old_nullifier_root || new_nullifier_root || sender_id || recipient_id || treasury_id || asset_id || amount || fee || nullifier)";

/** Normalize hex to 64 lowercase chars without 0x. */
export function normalizeFrHex(h: string): string {
  let s = h.trim().toLowerCase();
  if (s.startsWith("0x")) s = s.slice(2);
  if (s.length > 64) s = s.slice(s.length - 64);
  while (s.length < 64) s = "0" + s;
  return s;
}

export function frFromHex(h: string): Fr {
  return Fr.fromBytesBE(
    Uint8Array.from(
      normalizeFrHex(h)
        .match(/.{1,2}/g)!
        .map((b) => parseInt(b, 16)),
    ),
  );
}

export function publicInputsFromHex(hexes: string[]): SpendPublicInputs {
  // 13 = circuit vector (12 economic + domain_id); 12 = economic publics only.
  if (hexes.length !== ZK_PUBLIC_INPUT_COUNT && hexes.length !== ZK_ECONOMIC_PUBLIC_COUNT) {
    throw new Error(`need ${ZK_PUBLIC_INPUT_COUNT} (or ${ZK_ECONOMIC_PUBLIC_COUNT}) public input hex strings`);
  }
  const f = hexes.map(frFromHex);
  return {
    oldStateRoot: f[0]!,
    newStateRoot: f[1]!,
    oldNullifierRoot: f[2]!,
    newNullifierRoot: f[3]!,
    senderId: f[4]!,
    recipientId: f[5]!,
    treasuryId: f[6]!,
    assetId: f[7]!,
    amount: f[8]!,
    fee: f[9]!,
    nullifier: f[10]!,
    transactionCommitment: f[11]!,
  };
}

export function publicInputsToHex(pub: SpendPublicInputs): string[] {
  return publicInputsOrdered(pub).map((x) => normalizeFrHex(x.toHex()));
}

/**
 * Compare two public-input vectors (hex). Returns list of mismatched indices.
 */
export function diffPublicInputHex(a: string[], b: string[]): number[] {
  const bad: number[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (normalizeFrHex(a[i] ?? "") !== normalizeFrHex(b[i] ?? "")) bad.push(i);
  }
  return bad;
}

/**
 * Ensure proof object is self-consistent: publicInputs ↔ publicInputsHex.
 */
export function reconcileProofPublicInputs(proof: ZkSpendProof): ZkSpendProof {
  if (
    !proof.publicInputsHex ||
    (proof.publicInputsHex.length !== ZK_PUBLIC_INPUT_COUNT &&
      proof.publicInputsHex.length !== ZK_ECONOMIC_PUBLIC_COUNT)
  ) {
    // Fallback: serialize from structured fields
    return {
      ...proof,
      publicInputsHex: publicInputsToHex(proof.publicInputs),
    };
  }
  const fromHex = publicInputsFromHex(proof.publicInputsHex);
  return {
    ...proof,
    publicInputs: fromHex,
    publicInputsHex: proof.publicInputsHex.map(normalizeFrHex),
  };
}

/**
 * Bind tx economic fields to proof publics.
 * Checks sender, recipient, treasury, asset, amount, fee, nullifier match.
 * Roots and commitment are owned by the circuit/prover (Poseidon).
 */
export type TxFieldBinding = {
  senderId: Fr;
  recipientId: Fr;
  treasuryId: Fr;
  assetId: Fr;
  amount: bigint;
  fee: bigint;
  nullifier: Fr;
};

export function assertProofBindsTxFields(
  proof: ZkSpendProof,
  tx: TxFieldBinding,
): { ok: true } | { ok: false; errors: string[] } {
  const p = reconcileProofPublicInputs(proof).publicInputs;
  const errors: string[] = [];
  if (!p.senderId.eq(tx.senderId)) errors.push("sender_id mismatch");
  if (!p.recipientId.eq(tx.recipientId)) errors.push("recipient_id mismatch");
  if (!p.treasuryId.eq(tx.treasuryId)) errors.push("treasury_id mismatch");
  if (!p.assetId.eq(tx.assetId)) errors.push("asset_id mismatch");
  if (p.amount.n !== tx.amount) errors.push(`amount mismatch ${p.amount.n} vs ${tx.amount}`);
  if (p.fee.n !== tx.fee) errors.push(`fee mismatch ${p.fee.n} vs ${tx.fee}`);
  if (!p.nullifier.eq(tx.nullifier)) errors.push("nullifier mismatch");
  return errors.length ? { ok: false, errors } : { ok: true };
}

export { SPEND_PUBLIC_INPUT_NAMES };
