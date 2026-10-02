/**
 * UepTransaction bound to UEP-25 public-input contract + UEP-009 lifecycle.
 * Status: IMPLEMENTED / TESTED
 */
import { Fr } from "./field.ts";
import { canonicalTxCommitment, encodeStringToFr, u64ToFr } from "./encoding.ts";
import { hAccount } from "./hash.ts";
import type { SpendProof } from "./spend-proof.ts";

export type TxPhase =
  | "LOCAL_VALID"
  | "LOCAL_FINAL"
  | "CROSS_DOMAIN_LOCK"
  | "SETTLED"
  | "INVALIDATED";

/** Wallet-facing status derived from UEP-009 phase. Never maps to CONFIRMED unless SETTLED. */
export type TxViewStatus = "PENDING" | "ACCEPTED" | "REJECTED" | "CONFLICT" | "FINALIZED";

export function viewStatus(phase: TxPhase, inConflict: boolean): TxViewStatus {
  if (phase === "INVALIDATED") return "REJECTED";
  if (phase === "SETTLED") return "FINALIZED";
  if (inConflict) return "CONFLICT";
  if (phase === "LOCAL_FINAL" || phase === "CROSS_DOMAIN_LOCK") return "ACCEPTED";
  return "PENDING";
}

export type UepTransaction = {
  version: number;
  protocol: string;
  networkId: string;
  domainId: string;
  txId: Fr;
  senderId: Fr;
  recipientId: Fr;
  assetId: Fr;
  amount: bigint;
  fee: bigint;
  nonce: Fr;
  nullifier: Fr;
  inputCommitments: Fr[];
  outputCommitments: Fr[];
  transactionCommitment: Fr;
  spendProof: SpendProof;
  phase: TxPhase;
  inConflict: boolean;
  createdAt: number;
};

export function computeTxCommitment(input: {
  networkId: string;
  senderId: Fr;
  recipientId: Fr;
  assetId: Fr;
  amount: bigint;
  fee: bigint;
  nonce: Fr;
  nullifier: Fr;
  inputCommitments: Fr[];
  outputCommitments: Fr[];
}): Fr {
  return canonicalTxCommitment([
    encodeStringToFr(input.networkId),
    input.senderId,
    input.recipientId,
    input.assetId,
    u64ToFr(input.amount),
    u64ToFr(input.fee),
    input.nonce,
    input.nullifier,
    ...input.inputCommitments,
    ...input.outputCommitments,
  ]);
}

export function txIdFromCommitment(commitment: Fr, nullifier: Fr): Fr {
  return canonicalTxCommitment([commitment, nullifier]);
}

export function verifyOwnership(secret: Fr, salt: Fr, senderId: Fr): boolean {
  return hAccount(secret, salt).eq(senderId);
}

export function serializeTx(tx: UepTransaction) {
  return {
    ...tx,
    txId: tx.txId.toHex(),
    senderId: tx.senderId.toHex(),
    recipientId: tx.recipientId.toHex(),
    assetId: tx.assetId.toHex(),
    amount: tx.amount.toString(),
    fee: tx.fee.toString(),
    nonce: tx.nonce.toHex(),
    nullifier: tx.nullifier.toHex(),
    inputCommitments: tx.inputCommitments.map((c) => c.toHex()),
    outputCommitments: tx.outputCommitments.map((c) => c.toHex()),
    transactionCommitment: tx.transactionCommitment.toHex(),
  };
}

export function deserializeTx(data: ReturnType<typeof serializeTx>): UepTransaction {
  return {
    version: data.version,
    protocol: data.protocol,
    networkId: data.networkId,
    domainId: data.domainId,
    txId: new Fr(data.txId),
    senderId: new Fr(data.senderId),
    recipientId: new Fr(data.recipientId),
    assetId: new Fr(data.assetId),
    amount: BigInt(data.amount),
    fee: BigInt(data.fee),
    nonce: new Fr(data.nonce),
    nullifier: new Fr(data.nullifier),
    inputCommitments: data.inputCommitments.map((c) => new Fr(c)),
    outputCommitments: data.outputCommitments.map((c) => new Fr(c)),
    transactionCommitment: new Fr(data.transactionCommitment),
    spendProof: data.spendProof,
    phase: data.phase,
    inConflict: data.inConflict,
    createdAt: data.createdAt,
  };
}
