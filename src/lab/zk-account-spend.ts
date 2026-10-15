/**
 * 0.5.83 lab/wallet helper: prove a zk account spend against a ledger with the
 * `uep-zk` helper (circuit v6) and build the transaction. Inputs come from the
 * public ledger state (projection leaves, blindings, nullifiers); the secret
 * and salt never leave the caller.
 */
import { Fr } from "../core/field.ts";
import { creatorFee } from "../core/fee.ts";
import { TREASURY_ID } from "../network/profiles.ts";
import { zkAccountIdOf } from "../core/zk-account.ts";
import type { UepLedger } from "../testnet/ledger.ts";
import type { UepTransaction } from "../core/transaction.ts";
import { zkProveSpendJson } from "./zk-bridge.ts";
import type { PoseidonSpendRequestJson } from "./poseidon-spend-request.ts";

export type ZkAccountSpendResult =
  | { ok: true; tx: UepTransaction; publicInputsHex: string[]; proofHex: string; vkHex: string; senderNextBlinding: Fr }
  | { ok: false; error: string };

export function zkAccountSpendRequest(l: UepLedger, id: { secret: Fr; salt: Fr }, recipientId: Fr, assetId: Fr, amount: bigint, depth: 4 | 64): PoseidonSpendRequestJson {
  const sender = zkAccountIdOf(id.secret, id.salt);
  const { state, nullifiers } = l.zkCircuitProjection(6);
  const keyOf = (a: Fr) => l.zkSlotKey(a, assetId);
  const party = new Set([sender, recipientId, TREASURY_ID].map((a) => keyOf(a).toHex()));
  const empty = (a: Fr) => state.get(keyOf(a)).isZero();
  const hex = (f: Fr) => f.toHex();
  return {
    depth,
    circuit_version: 6,
    sender_secret: hex(id.secret),
    sender_salt: hex(id.salt),
    recipient_id: hex(recipientId),
    treasury_id: hex(TREASURY_ID),
    asset_id: hex(assetId),
    amount: amount.toString(),
    fee: creatorFee(amount, l.feeFloorOf(assetId)).toString(),
    sender_old_balance: l.balanceOf(sender, assetId).toString(),
    recipient_old_balance: l.balanceOf(recipientId, assetId).toString(),
    treasury_old_balance: l.balanceOf(TREASURY_ID, assetId).toString(),
    note_blinding: hex(l.zkBlindingOf(keyOf(sender))),
    recipient_blinding: hex(l.zkBlindingOf(keyOf(recipientId))),
    treasury_blinding: hex(l.zkBlindingOf(keyOf(TREASURY_ID))),
    recipient_slot_empty: empty(recipientId),
    treasury_slot_empty: empty(TREASURY_ID),
    extra_state_leaves: state.slots().filter((x) => !party.has(x.key.toHex())).map((x) => [x.index.toString(), hex(x.leaf)] as [string, string]),
    existing_nullifiers: nullifiers.slots().map((x) => hex(x.leaf)),
    domain_fr: hex(l.zkDomainId()),
    expected_old_state_root: hex(state.root()),
    expected_old_nullifier_root: hex(nullifiers.root()),
  } as PoseidonSpendRequestJson;
}

export function proveZkAccountSpend(l: UepLedger, id: { secret: Fr; salt: Fr }, recipientId: Fr, assetId: Fr, amount: bigint, depth: 4 | 64 = 4): ZkAccountSpendResult {
  const art = zkProveSpendJson(zkAccountSpendRequest(l, id, recipientId, assetId, amount, depth));
  if (!art.ok) return { ok: false, error: art.error ?? art.raw };
  const nbHex = /sender_new_blinding=(\S+)/.exec(art.raw)?.[1];
  if (!nbHex) return { ok: false, error: "sender_new_blinding missing in prover output" };
  const nb = new Fr(BigInt(nbHex.startsWith("0x") ? nbHex : `0x${nbHex}`));
  const tx = l.zkAccountSpendTx({ recipientId, assetId, amount, publicInputsHex: art.publicInputsHex, proof: art.proofHex!, senderNextBlinding: nb });
  return { ok: true, tx, publicInputsHex: art.publicInputsHex, proofHex: art.proofHex!, vkHex: art.vkHex!, senderNextBlinding: nb };
}
