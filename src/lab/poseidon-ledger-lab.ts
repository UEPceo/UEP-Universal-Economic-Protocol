/**
 * Poseidon Ledger Lab (UEP-28.11) — experimental single-domain Poseidon state.
 *
 * Status: 🟠 DESIGN + TS harness; roots of truth for ZK are produced by Rust Poseidon SMT.
 * This module does NOT reimplement Poseidon; it orchestrates requests to uep-zk and
 * records economic transitions for the lab log.
 *
 * Network profile: "local" (Poseidon Ledger Lab) — DEV test keys only.
 */

import { createHash } from "node:crypto";
import { Fr } from "../core/field.ts";
import { creatorFee } from "../core/fee.ts";
import {
  buildPoseidonSpendRequest,
  type PoseidonSpendRequestJson,
} from "./poseidon-spend-request.ts";
import { findUepZkBinary, zkProveSpendJson, type PoseidonSpendProofResult } from "./zk-bridge.ts";
import {
  publicInputsFromHex,
  assertProofBindsTxFields,
  normalizeFrHex,
} from "./zk-public-inputs.ts";
import { LAB_ZK_DOMAIN_ID, verifyZkSpendProofAgainstExpected, type ZkSpendProof } from "./zk-spend-provider.ts";

export const LAB_NETWORK_ID = "uep-poseidon-lab-1";
export const LAB_DOMAIN_ID = "LAB";
export const LAB_PROFILE = "local" as const;

export type LabSpendParams = {
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
  /** Extra state leaves as [index, leafHex] for multi-leaf trees. */
  extraStateLeaves?: Array<[number | bigint, string]>;
  existingNullifiers?: string[];
};

export type LabTransitionRecord = {
  networkId: string;
  domainId: string;
  profile: typeof LAB_PROFILE;
  depth: number;
  keys: "DEV-TEST-KEYS";
  amount: string;
  fee: string;
  oldStateRoot: string;
  newStateRoot: string;
  oldNullifierRoot: string;
  newNullifierRoot: string;
  nullifier: string;
  transactionCommitment: string;
  senderId: string;
  recipientId: string;
  proofOk: boolean;
  /** Economic identity of the transition (not proof bytes). */
  transitionId: string;
  raw?: string;
};

/**
 * Transition identity: hash of the 12 public input hex strings (economic content),
 * independent of proof randomness. Two different proofs of the same transition
 * share the same transitionId (idempotency key).
 */
export function transitionIdFromPublics(publicInputsHex: string[]): string {
  const joined = publicInputsHex.map(normalizeFrHex).join("|");
  const digest = createHash("sha256").update(joined, "utf8").digest("hex");
  return "tid-" + digest;
}

export function labProveSpend(params: LabSpendParams): {
  request: PoseidonSpendRequestJson;
  result: PoseidonSpendProofResult;
  record?: LabTransitionRecord;
  proof?: ZkSpendProof;
} {
  const depth = params.depth ?? 4;
  const fee = creatorFee(params.amount);
  const req = buildPoseidonSpendRequest({
    depth,
    seed: params.seed,
    senderSecret: params.senderSecret,
    senderSalt: params.senderSalt,
    recipientId: params.recipientId,
    treasuryId: params.treasuryId,
    assetId: params.assetId,
    amount: params.amount,
    fee,
    senderOldBalance: params.senderOldBalance,
    recipientOldBalance: params.recipientOldBalance,
    treasuryOldBalance: params.treasuryOldBalance,
    noteBlinding: params.noteBlinding,
    recipientBlinding: params.recipientBlinding,
    treasuryBlinding: params.treasuryBlinding,
  }) as PoseidonSpendRequestJson & {
    extra_state_leaves?: Array<[number, string]>;
    existing_nullifiers?: string[];
    network_profile?: string;
  };
  req.network_profile = LAB_PROFILE;
  if (params.extraStateLeaves) {
    req.extra_state_leaves = params.extraStateLeaves.map(([i, l]) => [
      Number(i),
      l,
    ]);
  }
  if (params.existingNullifiers) {
    req.existing_nullifiers = params.existingNullifiers;
  }

  if (!findUepZkBinary()) {
    return {
      request: req,
      result: {
        ok: false,
        publicInputsHex: [],
        raw: "",
        error: "uep-zk binary not found",
      },
    };
  }

  const result = zkProveSpendJson(req);
  if (!result.ok || result.publicInputsHex.length !== 13) {
    return { request: req, result };
  }

  const pub = publicInputsFromHex(result.publicInputsHex);
  const proof: ZkSpendProof = {
    kind: "zk-spend",
    protocolVersion: "UEP-28.11-lab",
    circuitTag: `poseidon-d${depth}-DEV-TEST-KEYS`,
    vkId: result.vkId,
    vkHex: result.vkHex,
    proofHex: result.proofHex,
    publicInputsHex: result.publicInputsHex,
    publicInputs: pub,
    backend: "poseidon-ledger-lab",
  };

  const record: LabTransitionRecord = {
    networkId: LAB_NETWORK_ID,
    domainId: LAB_DOMAIN_ID,
    profile: LAB_PROFILE,
    depth,
    keys: "DEV-TEST-KEYS",
    amount: params.amount.toString(),
    fee: fee.toString(),
    oldStateRoot: normalizeFrHex(result.publicInputsHex[0]!),
    newStateRoot: normalizeFrHex(result.publicInputsHex[1]!),
    oldNullifierRoot: normalizeFrHex(result.publicInputsHex[2]!),
    newNullifierRoot: normalizeFrHex(result.publicInputsHex[3]!),
    nullifier: normalizeFrHex(result.publicInputsHex[10]!),
    transactionCommitment: normalizeFrHex(result.publicInputsHex[11]!),
    senderId: normalizeFrHex(result.publicInputsHex[4]!),
    recipientId: normalizeFrHex(result.publicInputsHex[5]!),
    proofOk: true,
    transitionId: transitionIdFromPublics(result.publicInputsHex),
    raw: result.raw,
  };

  return { request: req, result, record, proof };
}

/**
 * Verify lab proof against its own publics and economic field binding.
 */
export function labVerify(
  proof: ZkSpendProof,
  economic: {
    senderId: Fr;
    recipientId: Fr;
    treasuryId: Fr;
    assetId: Fr;
    amount: bigint;
    fee: bigint;
    nullifier: Fr;
  },
  depth: 4 | 32 = 4,
): boolean {
  if (!assertProofBindsTxFields(proof, economic).ok) return false;
  // Verified under the pinned verifying key for `depth` (the proof's key is not used).
  return verifyZkSpendProofAgainstExpected(proof, proof.publicInputs, LAB_ZK_DOMAIN_ID, depth);
}
