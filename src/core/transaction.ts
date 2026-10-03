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

type SerializedNote = ReturnType<typeof serializeNote>;

function frHex(v: unknown): string {
  if (v instanceof Fr) return v.toHex();
  if (typeof v === "string") return new Fr(v).toHex();
  if (typeof v === "bigint") return new Fr(v).toHex();
  // A Fr that went through a JSON codec that keeps bigints: { n: <bigint> }.
  if (v && typeof v === "object" && typeof (v as { n?: unknown }).n === "bigint") return new Fr((v as { n: bigint }).n).toHex();
  throw new Error("TX_NOTE_INVALID");
}

/**
 * v0.5.0 (R-3): one canonical serialized form for the notes a transaction
 * carries, whether they are in-memory Notes, already serialized, or Notes
 * that went through a bigint-preserving JSON codec. Without it a snapshot
 * taken after a restore wrote the notes in another form than before, so the
 * payload, its hash and the transaction chain hash changed with the same state.
 */
export function canonicalSerializedNote(note: unknown): SerializedNote {
  if (!note || typeof note !== "object") throw new Error("TX_NOTE_INVALID");
  const n = note as Record<string, unknown>;
  const amount = typeof n.amount === "bigint" ? n.amount.toString() : typeof n.amount === "string" && /^(0|[1-9][0-9]*)$/.test(n.amount) ? n.amount : undefined;
  if (amount === undefined) throw new Error("TX_NOTE_INVALID");
  return {
    assetId: frHex(n.assetId),
    amount,
    owner: frHex(n.owner),
    blinding: frHex(n.blinding),
    commitment: frHex(n.commitment),
    nonce: frHex(n.nonce),
    spent: n.spent as boolean,
  };
}

/** A serialized transaction with its notes in the canonical form (used for hashing the transaction history). */
export function canonicalSerializedTx<T extends { inputNotes?: unknown[]; outputNotes?: unknown[] }>(t: T): T {
  if (!t || typeof t !== "object") return t;
  const out = { ...t };
  if (Array.isArray(t.inputNotes)) out.inputNotes = t.inputNotes.map(canonicalSerializedNote);
  if (Array.isArray(t.outputNotes)) out.outputNotes = t.outputNotes.map(canonicalSerializedNote);
  return out;
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
    ...(tx.inputNotes ? { inputNotes: tx.inputNotes.map(canonicalSerializedNote) } : {}),
    ...(tx.outputNotes ? { outputNotes: tx.outputNotes.map(canonicalSerializedNote) } : {}),
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
    // Transactions carry their notes in the serialized form (see UepTransaction); keep it canonical.
    inputNotes: data.inputNotes?.map(canonicalSerializedNote),
    outputNotes: data.outputNotes?.map(canonicalSerializedNote),
    transactionCommitment: new Fr(data.transactionCommitment),
    spendProof: data.spendProof,
    ...(data.senderAuth ? { senderAuth: { publicKey: data.senderAuth.publicKey, signature: data.senderAuth.signature } } : {}),
    ...(data.inputMembership ? { inputMembership: data.inputMembership.map((p) => ({ leafIndex: p.leafIndex, root: p.root, siblings: [...p.siblings] })) } : {}),
    phase: data.phase,
    inConflict: data.inConflict,
    createdAt: data.createdAt,
  };
}
