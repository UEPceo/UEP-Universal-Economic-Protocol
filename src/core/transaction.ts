/**
 * UepTransaction bound to UEP-25 public-input contract + UEP-009 lifecycle.
 * Status: IMPLEMENTED / TESTED
 */
import { BN254_FR_MODULUS, Fr } from "./field.ts";
import { canonicalTxCommitment, encodeStringToFr, u64ToFr } from "./encoding.ts";
import { accountIdsFromSecrets } from "./spend-key.ts";
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
  /**
   * v0.5.3 (UEP-C04): multi-input spend. Present only when a transaction
   * consumes 2..MAX_TX_INPUTS notes: element i is the nonce / nullifier of input
   * i, element 0 equals `nonce` / `nullifier`. Absent = single-input (v0.5.2 form,
   * same commitment and txId as before). Requires version 2.
   */
  inputNonces?: Fr[];
  inputNullifiers?: Fr[];
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
  /** v0.5.3: multi-input vectors; bound only when they carry 2 or more inputs. */
  inputNonces?: Fr[];
  inputNullifiers?: Fr[];
}): Fr {
  const multi = input.inputNullifiers && input.inputNullifiers.length > 1
    ? [MULTI_INPUT_COMMITMENT_TAG, new Fr(input.inputNullifiers.length), ...(input.inputNonces ?? []), ...input.inputNullifiers]
    : [];
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
    ...multi,
  ]);
}

/** v0.5.3 (UEP-C04): largest number of input notes in one transaction. */
export const MAX_TX_INPUTS = 8;
/** Version of a multi-input transaction (single-input transactions keep version 1). */
export const MULTI_INPUT_TX_VERSION = 2;
/** Domain tag appended to the commitment of a multi-input transaction (never present for single input). */
export const MULTI_INPUT_COMMITMENT_TAG = encodeStringToFr("UEP-TX-MULTI-INPUT-v1");

/** All nullifiers a transaction consumes (one per input). */
export function txNullifiers(tx: Pick<UepTransaction, "nullifier" | "inputNullifiers">): Fr[] {
  return tx.inputNullifiers && tx.inputNullifiers.length > 0 ? tx.inputNullifiers : [tx.nullifier];
}

/** All input nonces of a transaction (one per input). */
export function txNonces(tx: Pick<UepTransaction, "nonce" | "inputNonces">): Fr[] {
  return tx.inputNonces && tx.inputNonces.length > 0 ? tx.inputNonces : [tx.nonce];
}

/** Commitment of a transaction from its own fields (single- or multi-input). */
export function txCommitmentOf(tx: UepTransaction): Fr {
  return computeTxCommitment({
    networkId: tx.networkId,
    domainId: tx.domainId,
    senderId: tx.senderId,
    recipientId: tx.recipientId,
    assetId: tx.assetId,
    amount: tx.amount,
    fee: tx.fee,
    nonce: tx.nonce,
    nullifier: tx.nullifier,
    inputCommitments: tx.inputCommitments,
    outputCommitments: tx.outputCommitments,
    inputNonces: tx.inputNonces,
    inputNullifiers: tx.inputNullifiers,
  });
}

/**
 * v0.5.3: shape of the multi-input vectors. undefined = well formed (or a
 * single-input transaction without vectors).
 */
export function multiInputShapeError(tx: UepTransaction): string | undefined {
  const nf = tx.inputNullifiers;
  const nn = tx.inputNonces;
  if (nf === undefined && nn === undefined) return tx.version === MULTI_INPUT_TX_VERSION ? "version 2 requires input vectors" : undefined;
  if (!Array.isArray(nf) || !Array.isArray(nn)) return "input vectors must both be present";
  if (nf.length < 2 || nf.length > MAX_TX_INPUTS) return `a multi-input transaction has 2 to ${MAX_TX_INPUTS} inputs`;
  if (nn.length !== nf.length || tx.inputCommitments.length !== nf.length) return "one nonce, one nullifier and one input commitment per input";
  if (!(nf[0] instanceof Fr) || !(nn[0] instanceof Fr) || !nf[0].eq(tx.nullifier) || !nn[0].eq(tx.nonce)) return "input 0 must be the primary nonce / nullifier";
  if (new Set(nf.map((x) => x.toHex())).size !== nf.length) return "duplicate nullifier";
  if (tx.version !== MULTI_INPUT_TX_VERSION) return "a multi-input transaction is version 2";
  return undefined;
}

export function txIdFromCommitment(commitment: Fr, nullifier: Fr): Fr {
  return canonicalTxCommitment([commitment, nullifier]);
}

/**
 * v0.4.5: the secrets control `senderId` iff their spend key hashes to it.
 * v0.5.1: the v3 id or the v2 id of that key (existing accounts).
 */
export function verifyOwnership(secret: Fr, salt: Fr, senderId: Fr): boolean {
  const ids = accountIdsFromSecrets(secret, salt);
  return ids.v3.eq(senderId) || ids.v2.eq(senderId);
}

type SerializedNote = ReturnType<typeof serializeNote>;

/** v0.5.1: canonical field element only (0 <= v < r); a value that Fr would silently reduce is refused. */
function canonicalFr(n: bigint): string {
  if (n < 0n || n >= BN254_FR_MODULUS) throw new Error("TX_NOTE_INVALID: field element is not canonical");
  return new Fr(n).toHex();
}

function frHex(v: unknown): string {
  if (v instanceof Fr) return v.toHex();
  if (typeof v === "string") {
    const hex = v.startsWith("0x") || v.startsWith("0X") ? v.slice(2) : v;
    if (!/^[0-9a-fA-F]{1,64}$/.test(hex)) throw new Error("TX_NOTE_INVALID");
    return canonicalFr(BigInt("0x" + hex));
  }
  if (typeof v === "bigint") return canonicalFr(v);
  // A Fr that went through a JSON codec that keeps bigints: { n: <bigint> }.
  if (v && typeof v === "object" && typeof (v as { n?: unknown }).n === "bigint") return canonicalFr((v as { n: bigint }).n);
  throw new Error("TX_NOTE_INVALID");
}

/**
 * v0.5.1 (R-3): one canonical serialized form for the notes a transaction
 * carries, whether they are in-memory Notes, already serialized, or Notes
 * that went through a bigint-preserving JSON codec. Without it a snapshot
 * taken after a restore wrote the notes in another form than before, so the
 * payload, its hash and the transaction chain hash changed with the same state.
 */
export function canonicalSerializedNote(note: unknown): SerializedNote {
  if (!note || typeof note !== "object") throw new Error("TX_NOTE_INVALID");
  const n = note as Record<string, unknown>;
  // v0.5.3: a bigint amount follows the same rule as the string form (non-negative).
  const amount = typeof n.amount === "bigint" ? (n.amount >= 0n ? n.amount.toString() : undefined) : typeof n.amount === "string" && /^(0|[1-9][0-9]*)$/.test(n.amount) ? n.amount : undefined;
  if (amount === undefined) throw new Error("TX_NOTE_INVALID");
  if (n.spent !== undefined && typeof n.spent !== "boolean") throw new Error("TX_NOTE_INVALID: spent is a boolean");
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
    ...(tx.inputNonces ? { inputNonces: tx.inputNonces.map((x) => x.toHex()) } : {}),
    ...(tx.inputNullifiers ? { inputNullifiers: tx.inputNullifiers.map((x) => x.toHex()) } : {}),
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
    ...(Array.isArray(data.inputNonces) ? { inputNonces: (data.inputNonces as unknown as string[]).map((x) => new Fr(x)) } : {}),
    ...(Array.isArray(data.inputNullifiers) ? { inputNullifiers: (data.inputNullifiers as unknown as string[]).map((x) => new Fr(x)) } : {}),
    phase: data.phase,
    inConflict: data.inConflict,
    createdAt: data.createdAt,
  };
}
