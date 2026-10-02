/**
 * Spend proof boundary for UEP Crypto Core.
 *
 * DevelopmentSpendProofProvider: deterministic MAC over public inputs.
 * NOT a zero-knowledge proof.
 *
 * Public-input schema aligned with UEP-27 SpendCircuit (12 fields, SPEC §3):
 *   0 old_state_root
 *   1 new_state_root
 *   2 old_nullifier_root
 *   3 new_nullifier_root
 *   4 sender_id
 *   5 recipient_id
 *   6 treasury_id
 *   7 asset_id
 *   8 amount
 *   9 fee
 *  10 nullifier
 *  11 transaction_commitment
 *
 * Status:
 *   DevelopmentSpendProofProvider  IMPLEMENTED (development only)
 *   ZkSpendProofProvider           CONCEPTUAL (wallet prove)
 *   Local uep-zk demo              IMPLEMENTED (Rust binary)
 */
import { Fr } from "./field.ts";
import { Domain, h } from "./hash.ts";
import { canonicalTxCommitment } from "./encoding.ts";

/** Canonical 12 public inputs (matches Rust `public_inputs_from_circuit`). */
export type SpendPublicInputs = {
  oldStateRoot: Fr;
  newStateRoot: Fr;
  oldNullifierRoot: Fr;
  newNullifierRoot: Fr;
  senderId: Fr;
  recipientId: Fr;
  treasuryId: Fr;
  assetId: Fr;
  nullifier: Fr;
  amount: Fr;
  fee: Fr;
  transactionCommitment: Fr;
};

export const SPEND_PUBLIC_INPUT_NAMES = [
  "old_state_root",
  "new_state_root",
  "old_nullifier_root",
  "new_nullifier_root",
  "sender_id",
  "recipient_id",
  "treasury_id",
  "asset_id",
  "amount",
  "fee",
  "nullifier",
  "transaction_commitment",
] as const;

export type SpendWitness = {
  senderSecret: Fr;
  senderSalt: Fr;
  nonce: Fr;
};

export type SpendProof = {
  kind: "development-mac" | "zk-spend";
  backend: string;
  payload: string;
};

export interface SpendProofProvider {
  readonly name: string;
  readonly isZeroKnowledge: boolean;
  prove(pub: SpendPublicInputs, wit: SpendWitness): SpendProof;
  verify(proof: SpendProof, pub: SpendPublicInputs): boolean;
}

/** Ordered fold matching Rust public-input order (amount/fee before nullifier in circuit list is amount, fee, nullifier). */
export function publicInputsOrdered(pub: SpendPublicInputs): Fr[] {
  return [
    pub.oldStateRoot,
    pub.newStateRoot,
    pub.oldNullifierRoot,
    pub.newNullifierRoot,
    pub.senderId,
    pub.recipientId,
    pub.treasuryId,
    pub.assetId,
    pub.amount,
    pub.fee,
    pub.nullifier,
    pub.transactionCommitment,
  ];
}

function mac(secret: Fr, pub: SpendPublicInputs): Fr {
  const folded = canonicalTxCommitment(publicInputsOrdered(pub));
  return h(Domain.Transaction, secret, folded);
}

export const DevelopmentSpendProofProvider: SpendProofProvider = {
  name: "development-mac",
  isZeroKnowledge: false,
  prove(pub, wit) {
    return {
      kind: "development-mac",
      backend: "UEP-25 algebraic MAC — NOT a ZK proof; 12-field schema (UEP-28.1)",
      payload: mac(wit.senderSecret, pub).toHex(),
    };
  },
  verify(proof, pub) {
    if (proof.kind !== "development-mac") return false;
    return typeof proof.payload === "string" && /^[0-9a-f]{64}$/.test(proof.payload);
  },
};

export function verifyDevelopmentMac(
  proof: SpendProof,
  pub: SpendPublicInputs,
  secret: Fr,
): boolean {
  if (proof.kind !== "development-mac") return false;
  return proof.payload === mac(secret, pub).toHex();
}

export const activeSpendProofProvider: SpendProofProvider = DevelopmentSpendProofProvider;

/** Marker: full witness lives in zk-witness-contract.ts (UEP-28.3). */
export type { ZkSpendInstance, ZkSpendWitness } from "./zk-witness-contract.ts";
