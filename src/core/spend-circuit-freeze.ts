/**
 * UEP-26.3 SpendCircuit fold freeze.
 *
 * The circuit transaction commitment is hFoldV2(Domain.Transaction, items).
 * Note commitments and the wallet canonicalTxCommitment are not this function.
 * v4 proofs (tag UEP-27-SPEND-POSEIDON-D32-v4-assetkey) do not verify under v5.
 */
import { Fr } from "./field.ts";
import { Domain, hFoldV2 } from "./hash.ts";

export const SPEND_CIRCUIT_TAG = "UEP-27-SPEND-POSEIDON-D32-v5-foldv2";
export const SPEND_CIRCUIT_FOLD = "hFoldV2";
export const SPEND_CIRCUIT_ENCODING_VERSION = 2;
export const PRE_FREEZE_CIRCUIT_TAG = "UEP-27-SPEND-POSEIDON-D32-v4-assetkey";

export type SpendCircuitCommitmentInput = {
  oldStateRoot: Fr;
  newStateRoot: Fr;
  oldNullifierRoot: Fr;
  newNullifierRoot: Fr;
  senderId: Fr;
  recipientId: Fr;
  treasuryId: Fr;
  assetId: Fr;
  amount: Fr;
  fee: Fr;
  nullifier: Fr;
  domainId: Fr;
};

/** Frozen public-input binding. Item order matches hash_gadget.rs tx_commitment. */
export function spendCircuitTxCommitment(input: SpendCircuitCommitmentInput): Fr {
  return hFoldV2(Domain.Transaction, [
    new Fr(SPEND_CIRCUIT_ENCODING_VERSION),
    input.oldStateRoot,
    input.newStateRoot,
    input.oldNullifierRoot,
    input.newNullifierRoot,
    input.senderId,
    input.recipientId,
    input.treasuryId,
    input.assetId,
    input.amount,
    input.fee,
    input.nullifier,
    input.domainId,
  ]);
}
