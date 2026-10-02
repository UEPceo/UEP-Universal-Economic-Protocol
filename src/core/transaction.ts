/**
 * UepTransaction bound to UEP-25 public-input contract + UEP-009 lifecycle.
 * Status: IMPLEMENTED / TESTED
 */
import { Fr } from "./field.ts";
import { canonicalTxCommitment, encodeStringToFr, u64ToFr } from "./encoding.ts";
import { accountIdFromSecrets } from "./spend-key.ts";
import type { SpendProof } from "./spend-proof.ts";
import type { Note } from "./note.ts";
import { serializeNote, deserializeNote } from "./note.ts";

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
  /** Testnet note openings travel with the transaction so another ledger can reconstruct note state. */
  inputNotes?: ReturnType<typeof serializeNote>[];
  outputNotes?: ReturnType<typeof serializeNote>[];
  transactionCommitment: Fr;
  spendProof: SpendProof;
  /** v0.4.4: Ed25519 signature by the sender's registered spend key over txId + commitment. */
  senderAuth?: { publicKey: string; signature: string };
  /** v0.4.4: membership proof of each input commitment in the note-commitment tree. */
  inputMembership?: Array<{ leafIndex: string; root: string; siblings: string[] }>;
  phase: TxPhase;
  inConflict: boolean;
  createdAt: number;
};

export function computeTxCommitment(input: {
  networkId: string;
  domainId: string;
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
    encodeStringToFr(input.domainId),
    input.senderId,
    input.recipientId,
    input.assetId,
    u64ToFr(input.amount),
    u64ToFr(input.fee),
    input.nonce,
    input.nullifier,
    new Fr(input.inputCommitments.length),
    ...input.inputCommitments,
    new Fr(input.outputCommitments.length),
    ...input.outputCommitments,
  ]);
}

export function txIdFromCommitment(commitment: Fr, nullifier: Fr): Fr {
  return canonicalTxCommitment([commitment, nullifier]);
}

/** v0.4.5: the secrets control `senderId` iff their spend key hashes to it. */
export function verifyOwnership(secret: Fr, salt: Fr, senderId: Fr): boolean {
  return accountIdFromSecrets(secret, salt).eq(senderId);
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
    inputNotes: data.inputNotes?.map(deserializeNote),
    outputNotes: data.outputNotes?.map(deserializeNote),
    transactionCommitment: new Fr(data.transactionCommitment),
    spendProof: data.spendProof,
    ...(data.senderAuth ? { senderAuth: { publicKey: data.senderAuth.publicKey, signature: data.senderAuth.signature } } : {}),
    ...(data.inputMembership ? { inputMembership: data.inputMembership.map((p) => ({ leafIndex: p.leafIndex, root: p.root, siblings: [...p.siblings] })) } : {}),
    phase: data.phase,
    inConflict: data.inConflict,
    createdAt: data.createdAt,
  };
}
