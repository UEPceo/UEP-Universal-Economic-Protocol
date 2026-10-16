/**
 * Poseidon spend request for Rust prove-spend-json (UEP-28.6/28.7).
 * Economic integers as strings to avoid JS Number limits.
 */
import { Fr } from "../core/field.ts";
import { creatorFee } from "../core/fee.ts";

export type PoseidonSpendRequestJson = {
  depth: 4 | 32 | 64;
  /** 0.5.83: 5 = legacy circuit (default), 6 = depth-64 rotation circuit (depth 4 or 64). */
  circuit_version?: 5 | 6;
  /** Lab callers set this; ignored by the current prover request. */
  domain_id?: number;
  recipient_slot_empty?: boolean;
  treasury_slot_empty?: boolean;
  /** Test-only reproducible RNG; omit in production. */
  seed?: number;
  sender_secret: string;
  sender_salt: string;
  recipient_id: string;
  treasury_id: string;
  asset_id: string;
  /** Decimal string or number (compat). */
  amount: string | number;
  fee: string | number;
  sender_old_balance: string | number;
  recipient_old_balance?: string | number;
  treasury_old_balance?: string | number;
  note_blinding: string;
  recipient_blinding: string;
  treasury_blinding: string;
  extra_state_leaves?: Array<[number | string, string]>;
  existing_nullifiers?: string[];
  network_profile?: string;
  expected_old_state_root?: string;
  expected_old_nullifier_root?: string;
};

export function frToDecimalOrHex(f: Fr): string {
  if (f.n <= 0xffff_ffff_ffff_ffffn) return f.n.toString();
  return "0x" + f.toHex();
}

export function buildPoseidonSpendRequest(opts: {
  depth?: 4 | 32;
  seed?: number;
  senderSecret: Fr;
  senderSalt: Fr;
  recipientId: Fr;
  treasuryId: Fr;
  assetId: Fr;
  amount: bigint;
  senderOldBalance: bigint;
  recipientOldBalance?: bigint;
  treasuryOldBalance?: bigint;
  noteBlinding: Fr;
  recipientBlinding: Fr;
  treasuryBlinding: Fr;
  fee?: bigint;
}): PoseidonSpendRequestJson {
  const amount = opts.amount;
  const fee = opts.fee ?? creatorFee(amount);
  if (opts.senderOldBalance < amount + fee) {
    throw new Error("insufficient sender_old_balance");
  }
  return {
    depth: opts.depth ?? 4,
    seed: opts.seed,
    sender_secret: frToDecimalOrHex(opts.senderSecret),
    sender_salt: frToDecimalOrHex(opts.senderSalt),
    recipient_id: frToDecimalOrHex(opts.recipientId),
    treasury_id: frToDecimalOrHex(opts.treasuryId),
    asset_id: frToDecimalOrHex(opts.assetId),
    amount: amount.toString(),
    fee: fee.toString(),
    sender_old_balance: opts.senderOldBalance.toString(),
    recipient_old_balance: (opts.recipientOldBalance ?? 0n).toString(),
    treasury_old_balance: (opts.treasuryOldBalance ?? 0n).toString(),
    note_blinding: frToDecimalOrHex(opts.noteBlinding),
    recipient_blinding: frToDecimalOrHex(opts.recipientBlinding),
    treasury_blinding: frToDecimalOrHex(opts.treasuryBlinding),
  };
}
