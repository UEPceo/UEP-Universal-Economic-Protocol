/**
 * In-process UEP ledger. One instance per network (and per planetary domain).
 * Status: IMPLEMENTED (local). Multi-node P2P: CONCEPTUAL.
 */
import { Fr } from "../core/field.ts";
import { ACCOUNT_DEPTH } from "../core/smt.ts";
import { NullifierSet } from "../core/nullifier.ts";
import { SparseMerkleTree } from "../core/smt.ts";
import { markConflicts, reconcile, settlementRoot } from "../core/reconciliation.ts";
import { assetEncodings, findAsset, findAssetByFr, isCanonicalLedgerAssetId, ledgerAssetIdToFr, resolveAssetIdAlias, MAX_REGISTRY_DECIMALS, type AssetRecord } from "../core/assets.ts";
import type { AssetRegistry } from "../core/asset-registry.ts";
import { anchorChainProblem, buildSettlementAnchor, GENESIS_ANCHOR_HASH, settlementAnchorAuthorizationMessage, type SettlementAnchor, type SettlementAnchorAuthorization } from "../settlement/anchor.ts";
import type { SettlementReceipt } from "../settlement/types.ts";
import { DEPRECATIONS, deprecate, looksLikeLegacyMs } from "../core/deprecation.ts";
import { migrateSnapshotPayload, snapshotFormatSupport } from "./snapshot-migrations.ts";
import { hAccount, hLeaf } from "../core/hash.ts";
import { creatorFee, maxPayableFromNote, MIN_PROTOCOL_FEE, requiredSenderDebit } from "../core/fee.ts";
import { deriveNullifier, signedSpendNullifier } from "../core/nullifier.ts";
import { deserializeNote, makeNote, noteCommitment, noteNonce, openNote, serializeNote, type Note } from "../core/note.ts";
import { assertVerifierAllowed, parseZkSpendPayload, zkBindingMismatches, type ZkSpendVerifier } from "../core/zk-tx-adapter.ts";
import { canonicalSerializedTx, computeTxCommitment, deserializeTx, MAX_TX_INPUTS, MULTI_INPUT_TX_VERSION, multiInputShapeError, serializeTx, txCommitmentOf, txIdFromCommitment, txNonces, txNullifiers, verifyOwnership, type UepTransaction } from "../core/transaction.ts";
import { u64ToFr } from "../core/encoding.ts";
import { transition } from "../core/transition.ts";
import { TREASURY_ID } from "../network/profiles.ts";
import { SecurityPolicy, toPolicyBigint, type SecurityPolicy as SecurityPolicyType, type RiskTier } from "../core/security-policy.ts";
import { DevelopmentSpendProofProvider, SENDER_SIGNATURE_PROOF, verifyDevelopmentMac, type SpendPublicInputs } from "../core/spend-proof.ts";
import type { IdentitySecrets } from "../identity/kdf.ts";
import type { KeyObject } from "node:crypto";
import { generateEd25519KeyPair, publicKeyHexOf, sha256Hex, signEd25519, stableStringify, toPrivateKey, verifyEd25519, type PrivateKeyLike, type PublicKeyLike } from "../core/ed25519.ts";
import { NoteCommitmentTree } from "../core/note-tree.ts";
import { testOnlyOption } from "../core/test-only.ts";
import { MAX_BLOCKS_PER_TICK } from "../core/height.ts";
import { isKeyDerivedAccountId, isV2AccountIdForm, senderAuthFailure, signSenderAuth, spendKeyMatchesAccount } from "../core/spend-key.ts";
import { encodeAccountAddress, parseAccountAddress } from "../core/address.ts";

export type SubmitError =
  | { code: "WRONG_NETWORK"; message: string }
  | { code: "WRONG_OWNER"; message: string }
  | { code: "NOTE_OPENING"; message: string }
  | { code: "NOTE_NOT_MEMBER"; message: string }
  | { code: "NOTE_NONCE"; message: string }
  | { code: "OUTPUT_BINDING"; message: string }
  | { code: "INVALID_PARTICIPANTS"; message: string }
  | { code: "AMOUNT_MISMATCH"; message: string }
  | { code: "ASSET_MISMATCH"; message: string }
  | { code: "DOUBLE_SPEND"; message: string }
  | { code: "REPLAY"; message: string }
  | { code: "INSUFFICIENT"; message: string }
  | { code: "PROOF"; message: string }
  | { code: "POLICY"; message: string }
  | { code: "NOT_CONNECTED"; message: string }
  | { code: "OFFLINE_QUEUED"; message: string }
  /** v0.4.4: missing or invalid sender signature. */
  | { code: "SENDER_AUTH"; message: string }
  /** v0.4.5: the revealed spend key does not hash to the sender / input-note owner. */
  | { code: "OWNER_KEY"; message: string }
  /** v0.4.5: malformed, legacy, wrong-network or non-key-derived account address. */
  | { code: "INVALID_ADDRESS"; message: string }
  /** v0.4.4: missing or invalid note-commitment tree membership proof. */
  | { code: "MEMBERSHIP_PROOF"; message: string }
  /** v0.4.4: the bounded pending queue is full. */
  | { code: "PENDING_FULL"; message: string }
  /** v0.4.7: a multi-note payment batch is malformed (size, mixed sender / asset / recipient, shared inputs). */
  | { code: "BATCH_INVALID"; message: string }
  /** v0.5.2: a spend was submitted while another spend of this ledger was being checked or applied (re-entry). */
  | { code: "LEDGER_BUSY"; message: string }
  /** v0.5.3: this ledger was replaced by restore(..., { replaces }) and accepts no further state change. */
  | { code: "LEDGER_RETIRED"; message: string };

export type SubmitResult = { tx: UepTransaction } | { error: SubmitError };
/** A spend that passed every check and can be applied without further validation. */
interface CheckedSpend { inputs: Note[]; outputs: Note[]; next: { sender: bigint; recipient: bigint; treasury: bigint }; assetIdStr: string }

/**
 * v0.5.0 spend authorization. "sender-signature" (default): remote-safe, the
 * node verifies with the public key only. "development-mac": LOCAL /
 * IN-PROCESS DEVELOPMENT ONLY, verification needs the sender's secret.
 */
export type SpendBuildOptions = { authorization?: "sender-signature" | "development-mac" };

/** v0.4.7: result of preparePayment() / submitBatch(). `index` is the failing part, when known. */
export type BatchResult = { txs: UepTransaction[] } | { error: SubmitError; index?: number };
/** v0.4.7: maximum number of single-input spends in one atomic payment batch. */
export const MAX_PAYMENT_PARTS = 16;

/** v0.4.7: protocol fee floor of a registered asset (registry `minProtocolFee`, default 1). */
export function protocolFeeFloor(networkId: string, assetId: Fr): bigint {
  return findAssetByFr(networkId, assetId)?.minProtocolFee ?? MIN_PROTOCOL_FEE;
}

type AccountKey = string; // accountHex|assetHex

function ak(account: Fr, asset: Fr): AccountKey {
  return account.toHex() + "|" + asset.toHex();
}

/**
 * Snapshot format version.
 * v3 (0.4.3): Ed25519 authority signatures, hash chain, signed faucet mints.
 * v4 (0.4.4): adds the note-commitment tree root, the sender spend-key registry
 * and the pending-queue bound; pending entries are validated on restore.
 * v5 (0.4.5): key-derived account ids (UEP-ADDR-002). The spend-key registry is
 * removed; every note owner must be a key-derived id and every spend's revealed
 * key must hash to its sender and input-note owner.
 * v6 (unreleased, research-labs integration): the protocol hash is Poseidon BN254
 * (UEP-26 domain composition) instead of the SHA-256 field reference hash. Account
 * ids, note commitments, nullifiers, SMT and note-tree roots all change, so v5 state
 * cannot be restored.
 * v7 (v0.5.1, ADR 0002): adds the block `height` of the single-node testnet;
 * `lastReconcileAt` and the `createdAt` of spends prepared by this ledger are
 * heights, and the policy window is `windowHeights`. No wall-clock value is
 * part of the state.
 * v8 (v0.5.3): adds `settlementAnchors` (Marketplace settlement batches anchored
 * in consensus state, src/settlement/anchor.ts) and, ADR 0001,
 * `assetRegistry` = { networkId, version, hash } of the
 * signed asset manifest the ledger enforces, or null for a template-only ledger.
 */
export const SNAPSHOT_FORMAT_VERSION = 8;
/** Default bound of the pending (offline / conflict) queue. */
export const DEFAULT_MAX_PENDING_TRANSACTIONS = 1024;
/** Upper limit accepted for `maxPendingTransactions`. */
export const MAX_PENDING_TRANSACTIONS_LIMIT = 100_000;
/** `prevSnapshotHash` of the first snapshot in a ledger's chain. */
export const GENESIS_SNAPSHOT_HASH = "0".repeat(64);
const SNAPSHOT_DOMAIN = "UEP-SNAPSHOT-v3";
/** v0.5.3: a ledger replaced by restore(..., { replaces }) refuses every state change and snapshot signing. */
const RETIRED_MESSAGE = "this ledger was replaced by a restore (restore(..., { replaces })); use the restored ledger";
const MINT_DOMAIN = "UEP-FAUCET-MINT-v1";
const CHAIN_DOMAIN = "UEP-HISTORY-CHAIN-v1";

/** A faucet issuance record, signed by the dedicated faucet (mint) key. */
export type MintRecord = {
  index: number;
  networkId: string;
  domainId: string;
  account: string;
  assetId: string;
  amount: string;
  commitment: string;
  signature: string;
};

export type SnapshotSignature = { publicKey: string; signature: string };

/**
 * v0.4.7: a mint (issuer) key scoped to some assets. It validates mints of
 * those assets whose index is >= `fromMintIndex` (default 0). Once an asset has
 * at least one scoped issuer key, the unscoped `faucetPublicKeys` no longer
 * validate mints of that asset.
 */
export type IssuerKeyTrust = { publicKey: PublicKeyLike; assetIds: string[]; fromMintIndex?: number };
/** v0.4.7: a mint key that stops validating mints from `fromMintIndex` on (rotation / revocation). */
export type MintKeyRevocation = { publicKey: PublicKeyLike; fromMintIndex: number };

/** Trust anchors for restore(). Only public keys: verifiers never need private keys. */
export type SnapshotTrust = {
  /** Snapshot authority public keys (n). */
  authorities: PublicKeyLike[];
  /** Distinct valid authority signatures required (k). Default 1. */
  threshold?: number;
  /** Faucet (mint) public key(s), valid for every registered asset without scoped issuer keys. Must not be a snapshot authority key. */
  faucetPublicKeys?: PublicKeyLike[];
  /** v0.4.7: per-asset issuer keys (see IssuerKeyTrust). Must not be snapshot authority keys. */
  issuerKeys?: IssuerKeyTrust[];
  /** v0.4.7: mint keys revoked from a mint index on (applies to faucet and issuer keys). */
  revokedMintKeys?: MintKeyRevocation[];
  /** The snapshot must directly follow this snapshot hash. */
  previousSnapshotHash?: string;
  /** A known earlier (or identical) checkpoint the snapshot must extend. */
  checkpoint?: SnapshotCheckpoint;
  /**
   * v0.5.3 (ADR 0001): the governance-verified asset registry the restored
   * ledger enforces. Required when the snapshot binds a registry; its chain
   * must contain the bound manifest hash.
   */
  assetRegistry?: AssetRegistry;
};

/** Private keys handed to a restored ledger so an authority node can keep signing. Optional. */
export type LedgerSigningKeys = {
  snapshotSigningKeys?: PrivateKeyLike[];
  faucetSigningKey?: PrivateKeyLike;
  /** v0.4.7: per-asset issuer private keys (asset id -> key); each must be trusted for that asset. */
  issuerSigningKeys?: Record<string, PrivateKeyLike>;
};

/** Compact commitment to a snapshot and to its transaction / mint history prefix. */
export type SnapshotCheckpoint = {
  sequence: number;
  snapshotHash: string;
  txCount: number;
  txChainHash: string;
  mintCount: number;
  mintChainHash: string;
  /** v0.5.1: block height of the checkpointed snapshot; a restore against it may not go lower (see RestoreOptions). */
  height?: number;
};

/**
 * v0.5.1 restore options (ADR 0002, height never goes backwards):
 *  - `replaces`: the ledger this restore takes over. The restored height may
 *    not be below its height, and it is retired (advanceHeight throws
 *    LEDGER_RETIRED, so a producer still bound to it stops at its next tick).
 *  - `minHeight`: the restored height may not be below this.
 *  - `allowHeightRegression`: explicit operator override of both rules and of
 *    the checkpoint height (a rollback). The Marketplace has no snapshot: after
 *    a rollback its height source regresses and it must be rebuilt, which
 *    loses its orders and held value (docs/THREAT-MODEL.md).
 */
export type RestoreOptions = {
  replaces?: { readonly height: number; retire?: () => void };
  minHeight?: number;
  allowHeightRegression?: boolean;
};

export type UepLedgerSnapshotPayload = ReturnType<UepLedger["snapshotPayload"]>;
export type UepLedgerSnapshot = UepLedgerSnapshotPayload & { snapshotHash: string; signatures: SnapshotSignature[] };

/** Canonical message signed by the faucet key for one mint record. */
export function mintMessage(m: Omit<MintRecord, "signature">): string {
  return stableStringify({ domain: MINT_DOMAIN, index: m.index, networkId: m.networkId, domainId: m.domainId, account: m.account, assetId: m.assetId, amount: m.amount, commitment: m.commitment });
}

function payloadOf(snap: UepLedgerSnapshotPayload & { snapshotHash?: unknown; signatures?: unknown }): UepLedgerSnapshotPayload {
  const { snapshotHash: _h, signatures: _s, ...payload } = snap as any;
  return payload as UepLedgerSnapshotPayload;
}

/** SHA-256 over the domain tag and the canonical payload (everything except `snapshotHash` and `signatures`). */
export function snapshotHash(snap: UepLedgerSnapshotPayload & { snapshotHash?: unknown; signatures?: unknown }): string {
  return sha256Hex(`${SNAPSHOT_DOMAIN}\n${stableStringify(payloadOf(snap))}`);
}

function chainHash(items: string[]): string {
  let h = sha256Hex(`${CHAIN_DOMAIN}\n`);
  for (const item of items) h = sha256Hex(`${h}\n${item}`);
  return h;
}

function txChainHash(txs: UepLedgerSnapshotPayload["txs"], count: number): string {
  // R-3: hash the canonical note form, so the chain hash does not depend on how a restored ledger re-serialized its notes.
  return chainHash(txs.slice(0, count).map((t) => stableStringify(canonicalSerializedTx(t as never))));
}

function mintChainHash(mints: MintRecord[], count: number): string {
  return chainHash(mints.slice(0, count).map((m) => stableStringify(m)));
}

/** Checkpoint of a snapshot: its hash plus hash chains over its transaction and mint history. */
export function checkpointOf(snap: UepLedgerSnapshot): SnapshotCheckpoint {
  return {
    sequence: snap.sequence,
    snapshotHash: snapshotHash(snap),
    txCount: snap.txs.length,
    txChainHash: txChainHash(snap.txs, snap.txs.length),
    mintCount: snap.mints.length,
    mintChainHash: mintChainHash(snap.mints, snap.mints.length),
    ...(Number.isSafeInteger((snap as { height?: unknown }).height) ? { height: snap.height } : {}),
  };
}

/**
 * (Re)sign a snapshot payload with the given snapshot authority private keys.
 * Replaces existing signatures. Requires private keys (authority tooling only).
 */
export function signSnapshot(snap: UepLedgerSnapshotPayload & { snapshotHash?: unknown; signatures?: unknown }, privateKeys: PrivateKeyLike[]): UepLedgerSnapshot {
  const payload = payloadOf(snap);
  const hash = snapshotHash(payload);
  return { ...payload, snapshotHash: hash, signatures: privateKeys.map((k) => ({ publicKey: publicKeyHexOf(toPrivateKey(k)), signature: signEd25519(hash, k) })) };
}

/** Add one co-signature (e.g. the second authority of a 2-of-3 set). */
export function cosignSnapshot(snap: UepLedgerSnapshot, privateKey: PrivateKeyLike): UepLedgerSnapshot {
  const hash = snapshotHash(snap);
  return { ...snap, snapshotHash: hash, signatures: [...(snap.signatures ?? []), { publicKey: publicKeyHexOf(toPrivateKey(privateKey)), signature: signEd25519(hash, privateKey) }] };
}

function distinctKeyHexes(keys: PublicKeyLike[] | undefined, code: string): string[] {
  const out: string[] = [];
  for (const k of keys ?? []) {
    let hex: string;
    try { hex = publicKeyHexOf(k); } catch { throw new Error(code); }
    if (out.includes(hex)) throw new Error(code);
    out.push(hex);
  }
  return out;
}

/** v3 key-derived id, or the v2 form (grandfathered for restored state; a live recipient also needs a v2 proof). */
function isKeyDerivedOrV2Form(id: Fr): boolean {
  return isKeyDerivedAccountId(id) || isV2AccountIdForm(id);
}

/**
 * Structural rules of a single-input spend, shared by submit(), pending
 * validation and restore() so that all three accept exactly the same
 * transactions:
 *   - sender, recipient and treasury are distinct accounts; sender and recipient
 *     are v2 key-derived account ids (v0.4.5);
 *   - exactly one input note, owned by the sender, in the transaction asset,
 *     with a well-formed note nonce equal to `tx.nonce` (the nullifier is
 *     derived from that nonce);
 *   - output 0 pays exactly `amount` to the recipient;
 *   - output 1 (present iff change > 0) returns `input - amount - fee` to the sender.
 * Note openings against the transaction commitments are checked by the caller.
 */
export function checkSpendShape(tx: UepTransaction, inputs: Note[], outputs: Note[], acceptsRecipient: (id: Fr) => boolean = isKeyDerivedOrV2Form): SubmitError | undefined {
  if (tx.senderId.eq(tx.recipientId) || tx.senderId.eq(TREASURY_ID) || tx.recipientId.eq(TREASURY_ID)) {
    return { code: "INVALID_PARTICIPANTS", message: "Sender, recipient and treasury must be distinct accounts." };
  }
  // v0.5.1: the sender is a v3 id or a v2-form id; its spend key proves it (checked by the caller).
  if (!isKeyDerivedOrV2Form(tx.senderId)) {
    return { code: "INVALID_PARTICIPANTS", message: "Sender must be a key-derived account." };
  }
  if (!acceptsRecipient(tx.recipientId)) {
    return { code: "INVALID_PARTICIPANTS", message: "Recipient must be a v3 key-derived account or a proven v2 account." };
  }
  // v0.5.3 (UEP-C04): 1 input (v0.5.2 form) or 2..MAX_TX_INPUTS inputs with nonce / nullifier vectors.
  const nonces = txNonces(tx);
  if (inputs.length < 1 || inputs.length > MAX_TX_INPUTS || inputs.length !== nonces.length) {
    return { code: "AMOUNT_MISMATCH", message: `A spend uses 1 to ${MAX_TX_INPUTS} input notes, one nonce and one nullifier each.` };
  }
  let total = 0n;
  for (const [i, input] of inputs.entries()) {
    if (!input.owner.eq(tx.senderId)) return { code: "WRONG_OWNER", message: "Input note belongs to a different identity." };
    if (!input.assetId.eq(tx.assetId)) return { code: "ASSET_MISMATCH", message: "Input note asset does not match transaction." };
    if (!input.nonce.eq(noteNonce(input.commitment, input.blinding)) || !input.nonce.eq(nonces[i]!)) {
      return { code: "NOTE_NONCE", message: "Transaction nonce is not bound to the consumed note." };
    }
    total += input.amount;
  }
  if (total < tx.amount + tx.fee) return { code: "AMOUNT_MISMATCH", message: "Transaction amount plus fee exceeds the value of the input notes." };
  const change = total - tx.amount - tx.fee;
  const expected: Array<{ owner: Fr; amount: bigint }> = [{ owner: tx.recipientId, amount: tx.amount }];
  if (change > 0n) expected.push({ owner: tx.senderId, amount: change });
  if (outputs.length !== expected.length) return { code: "OUTPUT_BINDING", message: "Unexpected number of output notes." };
  for (let i = 0; i < expected.length; i++) {
    const o = outputs[i]!;
    if (!o.owner.eq(expected[i]!.owner) || o.amount !== expected[i]!.amount || !o.assetId.eq(tx.assetId)) {
      return { code: "OUTPUT_BINDING", message: i === 0 ? "Output 0 must pay exactly the amount to the recipient." : "Output 1 must return the exact change to the sender." };
    }
    if (!o.nonce.eq(noteNonce(o.commitment, o.blinding))) return { code: "NOTE_NONCE", message: "Output note nonce is malformed." };
  }
  return undefined;
}

/** v0.4.7 payment plan over notes of one encoding: one covering note, else largest first (at most MAX_PAYMENT_PARTS). */
function planPayment(available: Note[], amount: bigint, minFee: bigint): { plan: Array<{ note: Note; part: bigint }> } | { error: SubmitError } {
  const single = available.find((n) => n.amount >= amount + creatorFee(amount, minFee));
  if (single) return { plan: [{ note: single, part: amount }] };
  const plan: Array<{ note: Note; part: bigint }> = [];
  let remaining = amount;
  const byValue = [...available].sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1));
  for (const note of byValue) {
    if (remaining === 0n) break;
    const cap = maxPayableFromNote(note.amount, minFee);
    if (cap <= 0n) continue;
    const part = cap < remaining ? cap : remaining;
    plan.push({ note, part });
    remaining -= part;
  }
  if (remaining > 0n) return { error: { code: "INSUFFICIENT", message: "Unspent notes do not cover the amount plus one protocol fee per note used." } };
  if (plan.length > MAX_PAYMENT_PARTS) return { error: { code: "BATCH_INVALID", message: `Payment needs more than ${MAX_PAYMENT_PARTS} notes.` } };
  return { plan };
}

export class UepLedger {
  /** v0.5.3: zk-spend verifier (see src/core/zk-tx-adapter.ts). */
  private zkSpendVerifier: ZkSpendVerifier | undefined;
  /** v0.5.2: re-entrancy guard of submit() / submitBatch(). */
  private spendInProgress = false;
  /** Optional security policy gate (TESTNET). */
  policy: SecurityPolicyType = new SecurityPolicy();
  /**
   * When true, a spend must be a sender-signature spend (v0.5.0 default,
   * verified with the public key only) or a local development-MAC spend
   * submitted in-process together with the sender identity.
   * v0.4.7: fixed at construction. It is always true unless the ledger was
   * built with the test-only flag `testOnlyDisableProof`; assigning `false`
   * afterwards throws. The Ed25519 sender signature is required either way.
   */
  get requireProof(): boolean {
    return this.proofRequired;
  }
  set requireProof(value: boolean) {
    if (value !== this.proofRequired) throw new Error("REQUIRE_PROOF_IMMUTABLE: requireProof is fixed at construction (testOnlyDisableProof is test-only)");
  }
  private readonly proofRequired: boolean;
  private readonly unboundedHeightAdvance: boolean;
  /** v0.5.1: set when a restore with `replaces` took over this ledger; it no longer advances. */
  private retired = false;
  readonly networkId: string;
  readonly domainId: string;
  readonly connected: boolean;
  readonly allowFaucet: boolean;
  private snapshotSigners: KeyObject[] = [];
  private faucetSigner: KeyObject | undefined;
  /** v0.4.7: per-asset issuer (mint) keys; when set for an asset, the default faucet key cannot mint it. */
  private issuerSigners = new Map<string, KeyObject>();
  /** Signed faucet issuance log. Supply is derived from it. */
  mints: MintRecord[] = [];
  /** Sequence of the last snapshot produced or restored (0 = none). */
  snapshotSequence = 0;
  /** Hash of the last snapshot produced or restored (genesis = 64 zeros). */
  lastSnapshotHash = GENESIS_SNAPSHOT_HASH;
  state: SparseMerkleTree;
  nullifiers: NullifierSet;
  balances = new Map<AccountKey, bigint>();
  notes: Note[] = [];
  txs: UepTransaction[] = [];
  /** v0.5.1: v2 ids proven by a committed public-key spend (derived from txs; see acceptsRecipient). */
  private readonly provenV2 = new Set<string>();
  private provenV2Scanned = 0;
  pending: UepTransaction[] = [];
  noteCounter = 0n;
  /** Height of the last reconcilePending() (v0.5.1; a wall-clock ms value before format 7, reset to 0 by the 6 -> 7 migration). */
  lastReconcileAt = 0;
  /** v0.5.1: clearer name of `lastReconcileAt` (a block height). */
  get lastReconcileHeight(): number {
    return this.lastReconcileAt;
  }
  /**
   * v0.5.1 (ADR 0002): block height of this single-node testnet. Starts at 0
   * and only moves through advanceHeight() (the local block producer); it is
   * part of the signed snapshot. Transitions read time from it, never from a
   * clock or a header timestamp.
   */
  private blockHeight = 0;
  /**
   * v0.5.1: snapshot format this ledger was restored from and the migration
   * steps applied (empty for a current-format snapshot or a new ledger).
   */
  restoredFrom: { formatVersion: number; migrationSteps: string[] } | undefined;
  /** Total minted (faucet) value per asset (asset hex -> amount), derived from `mints`. */
  supply = new Map<string, bigint>();
  /** v0.4.4: append-only Merkle tree of every note commitment, in `notes` order. */
  noteTree = new NoteCommitmentTree();
  /** v0.4.4: bound of the pending queue. */
  readonly maxPendingTransactions: number;

  constructor(opts: {
    networkId: string;
    domainId: string;
    connected: boolean;
    allowFaucet: boolean;
    /**
     * Snapshot authority Ed25519 private keys held by this node (all of them sign each snapshot).
     * Default: one ephemeral key (1-of-1 local testnet). Pass `[]` for a verify-only node.
     */
    snapshotSigningKeys?: PrivateKeyLike[];
    /**
     * Dedicated faucet (mint) Ed25519 private key, distinct from every snapshot key.
     * Default: an ephemeral key when `allowFaucet` is true. Pass `null` for no mint capability.
     */
    faucetSigningKey?: PrivateKeyLike | null;
    /** Bound of the pending queue (default 1024, max 100000). */
    maxPendingTransactions?: number;
    /** v0.4.7: per-asset issuer (mint) private keys, asset id -> key. Distinct from every snapshot key. */
    issuerSigningKeys?: Record<string, PrivateKeyLike>;
    /**
     * v0.5.3 (ADR 0001): governance-verified asset registry. When set, the
     * ledger accepts only assets that are both network templates and listed in
     * the registry with the same decimals (at most 8); deprecated assets
     * cannot be minted; the fee floor is the registry `minProtocolFee`; the
     * registry hash is committed in every snapshot.
     */
    assetRegistry?: AssetRegistry;
    /**
     * v0.5.3: Marketplace anchor keys per marketplace id. anchorSettlements()
     * accepts a batch only with a signature of one of these keys over the
     * request (settlementAnchorAuthorizationMessage). Operator configuration,
     * not snapshot state: set it again on a restored ledger
     * (setSettlementAnchorAuthority).
     */
    settlementAnchorAuthorities?: Record<string, PublicKeyLike[]>;
    /** v0.4.7 TEST-ONLY: build a ledger with requireProof = false. Never set outside tests. */
    testOnlyDisableProof?: boolean;
    /**
     * v0.5.3: verifier for `zk-spend` proofs on the transaction path (crypto
     * alignment). The ledger first binds public inputs 4..11 to the transaction;
     * development keys are refused under NODE_ENV=production. Without it a
     * zk-spend is refused.
     */
    zkSpendVerifier?: ZkSpendVerifier;
    /** v0.5.1 TEST-ONLY: advanceHeight(n) accepts n > MAX_BLOCKS_PER_TICK (tests and offline simulations). */
    testOnlyUnboundedHeightAdvance?: boolean;
  }) {
    if ((opts as { snapshotAuthoritySecret?: unknown }).snapshotAuthoritySecret !== undefined) throw new Error("SNAPSHOT_SECRET_UNSUPPORTED: v0.4.3 uses Ed25519 snapshotSigningKeys");
    this.networkId = opts.networkId;
    this.domainId = opts.domainId;
    this.connected = opts.connected;
    this.allowFaucet = opts.allowFaucet;
    const maxPending = opts.maxPendingTransactions ?? DEFAULT_MAX_PENDING_TRANSACTIONS;
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > MAX_PENDING_TRANSACTIONS_LIMIT) throw new Error("INVALID_MAX_PENDING_TRANSACTIONS");
    this.maxPendingTransactions = maxPending;
    this.proofRequired = !testOnlyOption("testOnlyDisableProof", opts.testOnlyDisableProof);
    if (opts.zkSpendVerifier) {
      assertVerifierAllowed(opts.zkSpendVerifier);
      this.zkSpendVerifier = opts.zkSpendVerifier;
    }
    this.unboundedHeightAdvance = testOnlyOption("testOnlyUnboundedHeightAdvance", opts.testOnlyUnboundedHeightAdvance);
    this.installSigningKeys(
      opts.snapshotSigningKeys ?? [generateEd25519KeyPair().privateKey],
      opts.faucetSigningKey === undefined ? (opts.allowFaucet ? generateEd25519KeyPair().privateKey : undefined) : (opts.faucetSigningKey ?? undefined),
      opts.issuerSigningKeys,
    );
    this.state = new SparseMerkleTree(ACCOUNT_DEPTH);
    this.nullifiers = new NullifierSet();
    if (opts.assetRegistry !== undefined) {
      const reg = opts.assetRegistry;
      if (!reg || typeof reg.find !== "function" || typeof reg.hash !== "string") throw new Error("ASSET_REGISTRY_INVALID");
      if (reg.networkId !== this.networkId) throw new Error("ASSET_REGISTRY_NETWORK_MISMATCH");
      this.assetRegistry = reg;
    }
    for (const [mid, keys] of Object.entries(opts.settlementAnchorAuthorities ?? {})) this.setSettlementAnchorAuthority(mid, keys);
  }

  /** v0.5.3: anchor keys of one Marketplace (replaces the previous set; an empty list removes it). */
  setSettlementAnchorAuthority(marketplaceId: string, publicKeys: readonly PublicKeyLike[]): void {
    if (this.retired) throw new Error(`LEDGER_RETIRED: ${RETIRED_MESSAGE}`);
    if (typeof marketplaceId !== "string" || !marketplaceId || !Array.isArray(publicKeys)) throw new Error("SETTLEMENT_ANCHOR_AUTHORITY_INVALID");
    const hexes = new Set<string>();
    for (const k of publicKeys) {
      let hex: string;
      try { hex = publicKeyHexOf(k); } catch { throw new Error("SETTLEMENT_ANCHOR_AUTHORITY_INVALID: key"); }
      hexes.add(hex);
    }
    if (hexes.size === 0) this.anchorAuthorities.delete(marketplaceId);
    else this.anchorAuthorities.set(marketplaceId, hexes);
  }

  /** v0.5.3: anchored Marketplace settlement batches, hash-chained (see src/settlement/anchor.ts). */
  settlementAnchors: SettlementAnchor[] = [];
  private anchoredSettlements = new Map<string, Set<string>>();
  private anchorAuthorities = new Map<string, Set<string>>();

  /**
   * v0.5.3 settlement bridge: verify `receipts` (hashes, per-receipt
   * conservation, treasury binding, no duplicate and no settlement anchored
   * before) and append their batch commitment to the consensus state at the
   * current height. Returns the anchor. Re-anchoring a settlement id fails.
   */
  anchorSettlements(input: { marketplaceId: string; treasuryId: string; receipts: readonly SettlementReceipt[]; authorization?: SettlementAnchorAuthorization }): SettlementAnchor {
    if (this.retired) throw new Error("LEDGER_RETIRED");
    const prev = this.settlementAnchors[this.settlementAnchors.length - 1];
    // v0.5.3: only the Marketplace's anchor key may anchor under its id (no anonymous or invented batches).
    const keys = this.anchorAuthorities.get(input?.marketplaceId);
    if (!keys) throw new Error("SETTLEMENT_ANCHOR_UNAUTHORIZED: no anchor key is configured for this marketplace");
    const auth = input?.authorization;
    let authHex: string | undefined;
    try { authHex = auth ? publicKeyHexOf(auth.publicKeyHex) : undefined; } catch { authHex = undefined; }
    const message = Array.isArray(input?.receipts) && input.receipts.every((r) => r && typeof r === "object")
      ? settlementAnchorAuthorizationMessage({ networkId: this.networkId, marketplaceId: input.marketplaceId, treasuryId: input.treasuryId, index: this.settlementAnchors.length, prevAnchorHash: prev?.anchorHash ?? GENESIS_ANCHOR_HASH, receipts: input.receipts })
      : undefined;
    if (!auth || !authHex || !keys.has(authHex) || !message || !verifyEd25519(message, auth.signature, authHex)) throw new Error("SETTLEMENT_ANCHOR_UNAUTHORIZED: missing or invalid Marketplace anchor signature");
    const anchored = this.anchoredSettlements.get(input?.marketplaceId) ?? new Set<string>();
    const anchor = buildSettlementAnchor({
      index: this.settlementAnchors.length,
      prevAnchorHash: prev?.anchorHash ?? GENESIS_ANCHOR_HASH,
      height: this.blockHeight,
      marketplaceId: input?.marketplaceId,
      treasuryId: input?.treasuryId,
      receipts: input?.receipts,
      anchored,
      networkId: this.networkId,
    });
    this.settlementAnchors.push(anchor);
    const set = new Set(anchored);
    for (const id of anchor.settlementIds) set.add(id);
    this.anchoredSettlements.set(anchor.marketplaceId, set);
    return { ...anchor, settlementIds: [...anchor.settlementIds], totals: { ...anchor.totals } };
  }

  /** v0.5.3: the anchor that committed `settlementId` of `marketplaceId`, and its position in the batch. */
  settlementAnchorOf(marketplaceId: string, settlementId: string): { anchor: SettlementAnchor; position: number } | undefined {
    for (const a of this.settlementAnchors) {
      if (a.marketplaceId !== marketplaceId) continue;
      const position = a.settlementIds.indexOf(settlementId);
      if (position >= 0) return { anchor: a, position };
    }
    return undefined;
  }

  /** v0.5.3 (ADR 0001): registry enforced by this ledger (undefined: network templates only). */
  readonly assetRegistry: AssetRegistry | undefined;

  /** v0.5.3: registry binding committed in snapshots (null without a registry). */
  assetRegistryBinding(): { networkId: string; version: number; hash: string } | null {
    const r = this.assetRegistry;
    return r ? { networkId: r.networkId, version: r.version, hash: r.hash } : null;
  }

  /**
   * v0.5.3 (ADR 0001): the template record of an asset if this ledger admits
   * it: a network template and, with a registry, listed there with the same
   * decimals (D-1: at most 8). Unknown assets return undefined.
   */
  assetRecord(assetIdStr: string): AssetRecord | undefined {
    return this.admit(findAsset(this.networkId, assetIdStr));
  }

  assetRecordByFr(assetId: Fr): AssetRecord | undefined {
    return this.admit(findAssetByFr(this.networkId, assetId));
  }

  /** Protocol fee floor: the registry `minProtocolFee` when a registry is enforced, else the template's. */
  feeFloorOf(assetId: Fr): bigint {
    const rec = this.assetRecordByFr(assetId);
    if (rec && this.assetRegistry) return this.assetRegistry.find(rec.assetId)!.minProtocolFee;
    return rec?.minProtocolFee ?? MIN_PROTOCOL_FEE;
  }

  /** Throws ASSET_DISABLED when the registry has deprecated the asset (no new issuance). */
  private assertMintable(assetIdStr: string): void {
    const reg = this.assetRegistry?.find(assetIdStr);
    if (reg && reg.status === "deprecated") throw new Error("ASSET_DISABLED: deprecated in the asset registry; no new issuance");
  }

  private admit(rec: AssetRecord | undefined): AssetRecord | undefined {
    if (!rec) return undefined;
    if (!Number.isSafeInteger(rec.decimals) || rec.decimals < 0 || rec.decimals > MAX_REGISTRY_DECIMALS) return undefined;
    if (!this.assetRegistry) return rec;
    const reg = this.assetRegistry.find(rec.assetId);
    if (!reg || reg.decimals !== rec.decimals) return undefined;
    return rec;
  }

  /** v0.5.1: current block height (deterministic; see advanceHeight()). */
  get height(): number {
    return this.blockHeight;
  }

  /**
   * v0.5.1: seal `blocks` blocks (default 1) and return the new height. This
   * is the single-node testnet's block producer: a node loop calls it, for
   * example once per 5 s target block time. Transitions committed between two
   * calls belong to the same height. It never reads a clock itself.
   */
  advanceHeight(blocks = 1): number {
    if (this.retired) throw new Error("LEDGER_RETIRED: this ledger was replaced by a restore; bind the producer to the restored ledger");
    if (!Number.isSafeInteger(blocks) || blocks < 0 || !Number.isSafeInteger(this.blockHeight + blocks)) throw new Error("HEIGHT_ADVANCE_INVALID");
    // v0.5.1: at most MAX_BLOCKS_PER_TICK per call outside test mode (an operator fast-forward
    // moves every window at once; it is bounded per call and the producer then waits for real time).
    if (blocks > MAX_BLOCKS_PER_TICK && !this.unboundedHeightAdvance) throw new Error(`HEIGHT_ADVANCE_CAP: at most ${MAX_BLOCKS_PER_TICK} blocks per call (testOnlyUnboundedHeightAdvance lifts it in tests)`);
    this.blockHeight += blocks;
    return this.blockHeight;
  }

  /** v0.5.1: true once a restore with `replaces: this` took over (advanceHeight then throws LEDGER_RETIRED). */
  get isRetired(): boolean {
    return this.retired;
  }

  stateRoot(): Fr {
    return this.state.root();
  }

  nullifierRoot(): Fr {
    return this.nullifiers.root();
  }

  balanceOf(account: Fr, asset: Fr): bigint {
    return this.balances.get(ak(account, asset)) ?? 0n;
  }

  /**
   * v0.5.0: balance of one asset by id (a legacy alias resolves), summed over
   * the asset's accepted encodings: the namespaced id and, for state restored
   * from before the v0.5.0 rename, the legacy alias encoding.
   */
  balanceOfAsset(account: Fr, assetIdStr: string): bigint {
    const rec = this.assetRecord(assetIdStr);
    if (!rec) return 0n;
    let total = 0n;
    for (const enc of assetEncodings(rec.assetId)) total += this.balanceOf(account, enc);
    return total;
  }

  notesOf(account: Fr, unspentOnly = true): Note[] {
    return this.notes.filter((n) => n.owner.eq(account) && (!unspentOnly || !n.spent));
  }

  /** Root of the note-commitment tree (every note ever created on this ledger). */
  noteCommitmentRoot(): Fr {
    return this.noteTree.root();
  }

  /** Canonical ledger note for a commitment (O(1) via the note tree index). */
  noteByCommitment(commitment: Fr): Note | undefined {
    const index = this.noteTree.indexOf(commitment);
    return index === undefined ? undefined : this.notes[index];
  }

  /** The only way notes enter the ledger: the tree and `notes` stay index-aligned. */
  private addNote(note: Note): void {
    this.noteTree.append(note.commitment);
    this.notes.push(note);
  }

  /** v0.4.5: v2 address (UEP-ADDR-002) of a key-derived account on this ledger's network. */
  addressOf(account: Fr): string {
    return encodeAccountAddress(this.networkId, account);
  }

  /**
   * v0.4.5: resolve a v2 address string (checked for checksum, version and
   * network) or a key-derived account id. Throws `ADDRESS_*` errors.
   */
  resolveAccount(accountOrAddress: Fr | string): Fr {
    const id = typeof accountOrAddress === "string" ? parseAccountAddress(accountOrAddress, this.networkId) : accountOrAddress;
    if (!(id instanceof Fr) || !this.acceptsRecipient(id)) throw new Error("ADDRESS_VERSION: account id is not a v3 key-derived account or a proven v2 account");
    return id;
  }

  /**
   * v0.5.1: may `id` receive notes? A v3 id (version byte and 64-bit check)
   * always; a v2-form id only once that account has proven its key, i.e. it
   * is the sender of a committed spend whose revealed key hashes to it. A
   * legacy H(secret, salt) id with the v2 byte can never get that proof.
   * Derived from committed transactions only, so every replica agrees.
   */
  acceptsRecipient(id: Fr): boolean {
    if (isKeyDerivedAccountId(id)) return true;
    if (!isV2AccountIdForm(id)) return false;
    for (; this.provenV2Scanned < this.txs.length; this.provenV2Scanned++) {
      const t = this.txs[this.provenV2Scanned]!;
      if (isV2AccountIdForm(t.senderId) && t.senderAuth && spendKeyMatchesAccount(t.senderAuth.publicKey, t.senderId)) this.provenV2.add(t.senderId.toHex());
    }
    return this.provenV2.has(id.toHex());
  }

  /**
   * Resolve transported inputs to canonical, unspent ledger notes (UEP-B02 rule,
   * shared by submit() and pending validation).
   */
  private canonicalInputs(tx: UepTransaction): { inputs: Note[] } | { error: SubmitError } {
    const transportedInputs = tx.inputNotes?.map(deserializeNote) ?? [];
    if (transportedInputs.length !== tx.inputCommitments.length) {
      return { error: { code: "NOTE_OPENING", message: "Every input commitment must carry its note opening." } };
    }
    const inputs: Note[] = [];
    for (let i = 0; i < tx.inputCommitments.length; i++) {
      const transported = transportedInputs[i]!;
      const canonical = this.noteByCommitment(tx.inputCommitments[i]!);
      if (!canonical) return { error: { code: "NOTE_NOT_MEMBER", message: "Input note is not a member of this ledger." } };
      if (canonical.spent) return { error: { code: "DOUBLE_SPEND", message: "Input note already spent." } };
      if (!openNote(transported) || !transported.commitment.eq(canonical.commitment)) return { error: { code: "NOTE_OPENING", message: "Transported note does not match ledger membership." } };
      if (transported.owner.toHex() !== canonical.owner.toHex() || transported.amount !== canonical.amount || transported.assetId.toHex() !== canonical.assetId.toHex()) return { error: { code: "NOTE_OPENING", message: "Transported note fields do not match ledger membership." } };
      inputs.push(canonical);
    }
    if (inputs.length === 0) {
      return { error: { code: "NOTE_OPENING", message: "Transaction has no input notes." } };
    }
    const uniqueInputs = new Set(tx.inputCommitments.map((c) => c.toHex()));
    if (tx.inputCommitments.length !== txNullifiers(tx).length || uniqueInputs.size !== tx.inputCommitments.length || inputs.length !== tx.inputCommitments.length) {
      return { error: { code: "AMOUNT_MISMATCH", message: "Input commitments must be unique and exactly match the referenced notes." } };
    }
    return { inputs };
  }

  /** Every input must carry a valid note-tree membership proof against a root this ledger has had. */
  private checkMembership(tx: UepTransaction, inputs: Note[]): SubmitError | undefined {
    const proofs = tx.inputMembership;
    if (!Array.isArray(proofs) || proofs.length !== inputs.length) return { code: "MEMBERSHIP_PROOF", message: "Every input must carry a note-commitment tree membership proof." };
    for (let i = 0; i < inputs.length; i++) {
      const proof = proofs[i]!;
      if (proof?.leafIndex !== String(this.noteTree.indexOf(inputs[i]!.commitment)) || !this.noteTree.verify(inputs[i]!.commitment, proof)) {
        return { code: "MEMBERSHIP_PROOF", message: "Input membership proof does not verify against a known note-commitment root." };
      }
    }
    return undefined;
  }

  /**
   * v0.4.5 registry-free sender check: the revealed spend key must hash to
   * `senderId` (key-derived account) and must have signed the envelope.
   */
  private checkSenderAuth(tx: UepTransaction): SubmitError | undefined {
    const failure = senderAuthFailure(tx);
    if (failure === "MISSING") return { code: "SENDER_AUTH", message: "Transaction carries no sender signature." };
    if (failure === "OWNER_KEY") return { code: "OWNER_KEY", message: "Revealed spend key does not hash to the sender account." };
    if (failure === "SIGNATURE") return { code: "SENDER_AUTH", message: "Transaction is not signed by the sender's spend key." };
    return undefined;
  }

  /** v0.5.0: a signed spend uses the public, sender-bound nullifier of its note. */
  private checkSignedNullifier(tx: UepTransaction): SubmitError | undefined {
    if (tx.spendProof.backend !== SENDER_SIGNATURE_PROOF.backend || tx.spendProof.payload !== "") return { code: "PROOF", message: "Unknown sender-signature scheme." };
    const nonces = txNonces(tx);
    const nfs = txNullifiers(tx);
    if (nonces.length !== nfs.length || nfs.some((nf, i) => !signedSpendNullifier(tx.senderId, nonces[i]!).eq(nf))) {
      return { code: "WRONG_OWNER", message: "Nullifier is not the sender-bound nullifier of the consumed note." };
    }
    return undefined;
  }

  /** v0.4.5: every canonical input note must be owned by the account of the revealed key. */
  private checkInputOwnerKeys(tx: UepTransaction, inputs: Note[]): SubmitError | undefined {
    for (const n of inputs) {
      if (!tx.senderAuth || !spendKeyMatchesAccount(tx.senderAuth.publicKey, n.owner)) return { code: "OWNER_KEY", message: "Input note owner does not match the signing spend key." };
    }
    return undefined;
  }

  private leafFor(account: Fr, asset: Fr, balance: bigint): Fr {
    return hLeaf(account, hLeaf(asset, u64ToFr(balance)));
  }

  private leafKey(account: Fr, asset: Fr): Fr {
    return hAccount(account, asset);
  }

  private setBalance(account: Fr, asset: Fr, balance: bigint) {
    this.balances.set(ak(account, asset), balance);
    this.state.set(this.leafKey(account, asset), this.leafFor(account, asset, balance));
  }

  faucet(accountOrAddress: Fr | string, assetIdStr: string, amount: bigint): Note {
    if (this.retired) throw new Error(`LEDGER_RETIRED: ${RETIRED_MESSAGE}`);
    if (!this.allowFaucet) throw new Error("Faucet is TESTNET-only");
    assetIdStr = resolveAssetIdAlias(assetIdStr);
    let account: Fr;
    try { account = this.resolveAccount(accountOrAddress); } catch (e) { throw new Error(`FAUCET_ACCOUNT_INVALID: ${(e as Error).message}`); }
    if (!this.connected) throw new Error("Node is not connected");
    const rec = isCanonicalLedgerAssetId(assetIdStr) ? this.assetRecord(assetIdStr) : undefined;
    if (!rec) throw new Error("Unknown TESTNET asset");
    this.assertMintable(rec.assetId);
    // v0.4.7: a per-asset issuer key, if configured, is the only key that mints this asset.
    const signer = this.issuerSigners.get(assetIdStr) ?? this.faucetSigner;
    if (!signer) throw new Error("FAUCET_KEY_REQUIRED");
    if (amount <= 0n || amount >= 2n ** 64n) throw new Error("FAUCET_AMOUNT_INVALID");
    const assetId = ledgerAssetIdToFr(assetIdStr);
    if (this.balanceOf(account, assetId) + amount >= 2n ** 64n) throw new Error("FAUCET_AMOUNT_INVALID");
    const blinding = hLeaf(account, new Fr(++this.noteCounter));
    const note = makeNote(account, assetId, amount, blinding);
    this.addNote(note);
    const unsigned = { index: this.mints.length, networkId: this.networkId, domainId: this.domainId, account: account.toHex(), assetId: assetId.toHex(), amount: amount.toString(), commitment: note.commitment.toHex() };
    this.mints.push({ ...unsigned, signature: signEd25519(mintMessage(unsigned), signer) });
    this.setBalance(account, assetId, this.balanceOf(account, assetId) + amount);
    this.supply.set(assetId.toHex(), (this.supply.get(assetId.toHex()) ?? 0n) + amount);
    return note;
  }

  private installSigningKeys(snapshotKeys: PrivateKeyLike[], faucetKey: PrivateKeyLike | undefined, issuerKeys?: Record<string, PrivateKeyLike>): void {
    const signers = snapshotKeys.map((k) => toPrivateKey(k));
    const hexes = signers.map((k) => publicKeyHexOf(k));
    if (new Set(hexes).size !== hexes.length) throw new Error("SNAPSHOT_SIGNING_KEYS_DUPLICATE");
    const faucet = faucetKey === undefined ? undefined : toPrivateKey(faucetKey);
    if (faucet && hexes.includes(publicKeyHexOf(faucet))) throw new Error("FAUCET_KEY_NOT_DISTINCT");
    const issuers = new Map<string, KeyObject>();
    for (const [rawAssetId, k] of Object.entries(issuerKeys ?? {})) {
      const assetIdStr = resolveAssetIdAlias(rawAssetId);
      if (!isCanonicalLedgerAssetId(assetIdStr) || !this.assetRecord(assetIdStr)) throw new Error("ISSUER_ASSET_UNKNOWN");
      const key = toPrivateKey(k);
      if (hexes.includes(publicKeyHexOf(key))) throw new Error("ISSUER_KEY_NOT_DISTINCT");
      issuers.set(assetIdStr, key);
    }
    this.snapshotSigners = signers;
    this.faucetSigner = faucet;
    this.issuerSigners = issuers;
  }

  /**
   * v0.4.7: install, rotate (replace) or remove (`null`) the issuer key of one
   * registered asset. Verifiers must update their `issuerKeys` /
   * `revokedMintKeys` trust from the current mint index (`mints.length`).
   */
  setIssuerSigningKey(assetIdStr: string, key: PrivateKeyLike | null): void {
    assetIdStr = resolveAssetIdAlias(assetIdStr);
    if (!isCanonicalLedgerAssetId(assetIdStr) || !this.assetRecord(assetIdStr)) throw new Error("ISSUER_ASSET_UNKNOWN");
    if (this.retired) throw new Error(`LEDGER_RETIRED: ${RETIRED_MESSAGE}`);
    if (key === null) { this.issuerSigners.delete(assetIdStr); return; }
    const k = toPrivateKey(key);
    if (this.snapshotAuthorityPublicKeys().includes(publicKeyHexOf(k))) throw new Error("ISSUER_KEY_NOT_DISTINCT");
    this.issuerSigners.set(assetIdStr, k);
  }

  /** v0.4.7: issuer public keys of this node, asset id -> hex SPKI DER. */
  issuerPublicKeys(): Record<string, string> {
    return Object.fromEntries([...this.issuerSigners.entries()].map(([a, k]) => [a, publicKeyHexOf(k)]));
  }

  /** Snapshot authority public keys of this node (hex SPKI DER). Share these with verifiers. */
  snapshotAuthorityPublicKeys(): string[] {
    return this.snapshotSigners.map((k) => publicKeyHexOf(k));
  }

  /** Faucet (mint) public key of this node (hex SPKI DER), if it can mint. */
  faucetPublicKey(): string | undefined {
    return this.faucetSigner ? publicKeyHexOf(this.faucetSigner) : undefined;
  }

  /** Checkpoint of the last snapshot this ledger produced or restored. */
  lastCheckpoint(): { sequence: number; snapshotHash: string } {
    return { sequence: this.snapshotSequence, snapshotHash: this.lastSnapshotHash };
  }

  /**
   * Build a spend from the caller's secrets. Selects FIFO notes. Runs on the
   * client (its own ledger replica): the secrets never leave it.
   * v0.5.0: by default the spend is authorized by the sender signature alone
   * (`sender-signature`) and the node verifies it with `submit(tx)` without
   * secrets. `{ authorization: "development-mac" }` builds the legacy
   * development MAC, which only an in-process `submit(tx, secrets)` can check.
   * v0.5.1: `now` is a height (default: this ledger's height); it is the
   * policy pre-check height and the spend's `createdAt`.
   */
  prepareSpend(
    secrets: IdentitySecrets,
    recipientOrAddress: Fr | string,
    assetIdStr: string,
    amount: bigint,
    now = this.blockHeight,
    opts: SpendBuildOptions = {},
  ): SubmitResult {
    assetIdStr = resolveAssetIdAlias(assetIdStr);
    now = this.spendHeight(now);
    const pre = this.prepareChecks(secrets, recipientOrAddress, assetIdStr, amount, now);
    if ("error" in pre) return pre;
    const { recipient, minFee } = pre;
    const senderId = secrets.accountId;
    const fee = creatorFee(amount, minFee);
    const required = amount + fee;
    const available = this.spendableNotes(senderId, pre.assetId);
    // v0.4 public testnet deliberately uses one input note per transaction.
    // This keeps the single-nullifier transaction format sound. Payments that
    // need several notes use preparePayment() + submitBatch() (v0.4.7): an
    // atomic batch of single-input spends.
    const spent = available.find((n) => n.amount >= required);
    if (!spent) {
      return { error: { code: "INSUFFICIENT", message: "No single unspent note covers amount plus fee." } };
    }
    // v0.5.0: a note from before the asset rename keeps its legacy encoding (inputs, outputs and fee).
    const assetId = spent.assetId;
    const tr = transition(
      { sender: this.balanceOf(senderId, assetId), recipient: this.balanceOf(recipient, assetId), treasury: this.balanceOf(TREASURY_ID, assetId) },
      amount,
      minFee,
    );
    if ("err" in tr) {
      return { error: { code: "INSUFFICIENT", message: tr.err } };
    }
    return { tx: this.buildSpend(secrets, recipient, assetId, amount, minFee, spent, now, tr.ok.new, opts) };
  }

  /**
   * v0.4.7: prepare a payment of `amount` to one recipient from one or more of
   * the sender's notes of one asset. If a single note covers amount + fee, the
   * result is that one spend (same as prepareSpend). Otherwise the amount is
   * split into at most MAX_PAYMENT_PARTS single-input spends, largest notes
   * first; each part pays its own protocol fee (0.1%, per-asset floor), so the
   * total fee can exceed the fee of a single transfer by the floors. Submit the
   * parts with submitBatch(), which applies all of them or none.
   */
  preparePayment(
    secrets: IdentitySecrets,
    recipientOrAddress: Fr | string,
    assetIdStr: string,
    amount: bigint,
    now = this.blockHeight,
    opts: SpendBuildOptions = {},
  ): BatchResult {
    assetIdStr = resolveAssetIdAlias(assetIdStr);
    now = this.spendHeight(now);
    const pre = this.prepareChecks(secrets, recipientOrAddress, assetIdStr, amount, now);
    if ("error" in pre) return pre;
    const { recipient, minFee } = pre;
    const senderId = secrets.accountId;
    // v0.5.0: one payment uses notes of one encoding (namespaced first, then a legacy alias encoding).
    let plan: Array<{ note: Note; part: bigint }> = [];
    let assetId = pre.assetId;
    let planError: { error: SubmitError } | undefined;
    for (const enc of assetEncodings(assetIdStr)) {
      const r = planPayment(this.spendableNotes(senderId, enc).filter((n) => n.assetId.eq(enc)), amount, minFee);
      if ("plan" in r) { plan = r.plan; assetId = enc; planError = undefined; break; }
      planError ??= r;
    }
    if (planError) return planError;
    const probes = plan.map(({ part }) => ({ accountHex: senderId.toHex(), assetId: assetIdStr, amount: part, fee: creatorFee(part, minFee), height: now }));
    const verdict = this.policy.checkSequence(probes);
    if (!verdict.ok) return { error: { code: "POLICY", message: `${verdict.code}: ${verdict.message}` } };
    const balances = { sender: this.balanceOf(senderId, assetId), recipient: this.balanceOf(recipient, assetId), treasury: this.balanceOf(TREASURY_ID, assetId) };
    const txs: UepTransaction[] = [];
    for (const [index, { note, part }] of plan.entries()) {
      const tr = transition(balances, part, minFee);
      if ("err" in tr) return { error: { code: "INSUFFICIENT", message: tr.err }, index };
      Object.assign(balances, tr.ok.new);
      txs.push(this.buildSpend(secrets, recipient, assetId, part, minFee, note, now, { ...tr.ok.new }, opts));
    }
    return { txs };
  }

  /**
   * v0.5.3 (UEP-C04): one multi-input transaction paying `amount` from up to
   * MAX_TX_INPUTS of the sender's notes of one asset encoding, with ONE protocol
   * fee for the whole transaction and at most one change note (consolidation of
   * the consumed notes). A single covering note gives a plain single-input
   * spend (v0.5.2 form). Always a sender-signature spend; submit with submit(tx).
   */
  prepareMultiInputSpend(
    secrets: IdentitySecrets,
    recipientOrAddress: Fr | string,
    assetIdStr: string,
    amount: bigint,
    now = this.blockHeight,
  ): SubmitResult {
    assetIdStr = resolveAssetIdAlias(assetIdStr);
    now = this.spendHeight(now);
    const pre = this.prepareChecks(secrets, recipientOrAddress, assetIdStr, amount, now);
    if ("error" in pre) return pre;
    const { recipient, minFee } = pre;
    const senderId = secrets.accountId;
    const required = amount + creatorFee(amount, minFee);
    for (const enc of assetEncodings(assetIdStr)) {
      const notes = this.spendableNotes(senderId, enc).filter((n) => n.assetId.eq(enc));
      const single = notes.find((n) => n.amount >= required);
      let chosen: Note[] | undefined = single ? [single] : undefined;
      if (!chosen) {
        const byValue = [...notes].sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1));
        const pick: Note[] = [];
        let sum = 0n;
        for (const n of byValue) {
          if (sum >= required || pick.length === MAX_TX_INPUTS) break;
          pick.push(n);
          sum += n.amount;
        }
        if (sum >= required) chosen = pick;
      }
      if (!chosen) continue;
      const tr = transition(
        { sender: this.balanceOf(senderId, enc), recipient: this.balanceOf(recipient, enc), treasury: this.balanceOf(TREASURY_ID, enc) },
        amount,
        minFee,
      );
      if ("err" in tr) return { error: { code: "INSUFFICIENT", message: tr.err } };
      return { tx: this.buildSpend(secrets, recipient, enc, amount, minFee, chosen, now, tr.ok.new, { authorization: "sender-signature" }) };
    }
    return { error: { code: "INSUFFICIENT", message: `At most ${MAX_TX_INPUTS} unspent notes of one encoding do not cover amount plus one fee.` } };
  }

  /** Shared preconditions of prepareSpend() / preparePayment(). */
  private prepareChecks(
    secrets: IdentitySecrets,
    recipientOrAddress: Fr | string,
    assetIdStr: string,
    amount: bigint,
    now: number,
  ): { recipient: Fr; assetId: Fr; minFee: bigint } | { error: SubmitError } {
    if (this.retired) return { error: { code: "LEDGER_RETIRED", message: RETIRED_MESSAGE } };
    if (amount <= 0n) return { error: { code: "AMOUNT_MISMATCH", message: "Amount must be greater than zero." } };
    if (recipientOrAddress instanceof Fr && (recipientOrAddress.eq(TREASURY_ID) || recipientOrAddress.eq(secrets.accountId))) {
      return { error: { code: "INVALID_PARTICIPANTS", message: "Sender, recipient and treasury must be distinct accounts." } };
    }
    let recipient: Fr;
    try { recipient = this.resolveAccount(recipientOrAddress); } catch (e) { return { error: { code: "INVALID_ADDRESS", message: (e as Error).message } }; }
    if (!this.connected) {
      return {
        error: {
          code: "NOT_CONNECTED",
          message: "No live network endpoint configured.",
        },
      };
    }
    // v0.4.7: canonical, registered asset id only.
    if (!isCanonicalLedgerAssetId(assetIdStr) || !this.assetRecord(assetIdStr)) {
      return { error: { code: "ASSET_MISMATCH", message: "Asset is not registered on this network." } };
    }
    const assetId = ledgerAssetIdToFr(assetIdStr);
    const minFee = this.feeFloorOf(assetId);
    {
      const feeGuess = creatorFee(amount, minFee);
      const verdict = this.policy.check(
        {
          accountHex: secrets.accountId.toHex(),
          assetId: assetIdStr,
          amount,
          fee: feeGuess,
          height: now,
        },
        false,
      );
      if (!verdict.ok) {
        return { error: { code: "POLICY", message: `${verdict.code}: ${verdict.message}` } };
      }
    }
    const senderId = secrets.accountId;
    if (!verifyOwnership(secrets.secret, secrets.salt, senderId)) {
      return { error: { code: "WRONG_OWNER", message: "Identity does not control this account." } };
    }
    if (recipient.eq(senderId) || recipient.eq(TREASURY_ID) || senderId.eq(TREASURY_ID)) {
      return { error: { code: "INVALID_PARTICIPANTS", message: "Sender, recipient and treasury must be distinct accounts." } };
    }
    return { recipient, assetId, minFee };
  }

  /** Unspent notes of `owner` in the asset of `assetId`, in every accepted encoding of that asset (namespaced first). */
  private spendableNotes(owner: Fr, assetId: Fr): Note[] {
    const rec = this.assetRecordByFr(assetId);
    const encodings = rec ? assetEncodings(rec.assetId) : [assetId];
    const notes = this.notesOf(owner).filter((n) => encodings.some((e) => e.eq(n.assetId)) && openNote(n));
    const rank = (n: Note) => encodings.findIndex((e) => e.eq(n.assetId));
    return notes.map((n, i) => ({ n, i })).sort((a, b) => rank(a.n) - rank(b.n) || a.i - b.i).map((x) => x.n);
  }

  /**
   * v0.5.1: `now` of prepareSpend()/preparePayment() is a height. A legacy
   * Unix-ms value (callers written before v0.5.1 passed Date.now()) is
   * replaced by this ledger's height (deprecated, UEP_DEP_SPEND_NOW_MS).
   */
  private spendHeight(now: number): number {
    if (!looksLikeLegacyMs(now)) return now;
    deprecate(DEPRECATIONS.SPEND_NOW_MS, "prepareSpend()/preparePayment(): `now` is a block height since v0.5.1; a Unix-ms value is replaced by the ledger height");
    return this.blockHeight;
  }

  /** Build and sign one single-input spend of `spent` (amount to recipient, change to sender). */
  private buildSpend(
    secrets: IdentitySecrets,
    recipient: Fr,
    assetId: Fr,
    amount: bigint,
    minFee: bigint,
    spent: Note | Note[],
    now: number,
    balancesAfter: { sender: bigint; recipient: bigint; treasury: bigint },
    opts: SpendBuildOptions = {},
  ): UepTransaction {
    const senderId = secrets.accountId;
    const mode = opts.authorization ?? "sender-signature";
    if (mode !== "sender-signature" && mode !== "development-mac") throw new Error("SPEND_AUTHORIZATION_INVALID");
    const fee = creatorFee(amount, minFee);
    const selected: Note[] = Array.isArray(spent) ? spent : [spent];
    if (selected.length < 1 || selected.length > MAX_TX_INPUTS) throw new Error("SPEND_INPUTS_INVALID");
    const multi = selected.length > 1;
    if (multi && mode !== "sender-signature") throw new Error("SPEND_MULTI_INPUT_REQUIRES_SENDER_SIGNATURE");
    const total = selected.reduce((t, n) => t + n.amount, 0n);
    const debit = requiredSenderDebit(amount, minFee);
    const change = total - amount - fee;
    // Single-note spend: consume the selected note, emit the recipient output
    // (`amount`) plus optional change (`total - amount - fee`). The nullifier is
    // derived from that note (single-nullifier transition, matching UEP-25).
    // v0.5.3 (UEP-C04): several notes -> one nonce / nullifier per input, one fee for the transaction.
    const nonce = selected[0]!.nonce;
    const nullifier = mode === "sender-signature" ? signedSpendNullifier(senderId, nonce) : deriveNullifier(secrets.secret, nonce);
    const inputNonces = multi ? selected.map((n) => n.nonce) : undefined;
    const inputNullifiers = multi ? selected.map((n) => signedSpendNullifier(senderId, n.nonce)) : undefined;
    const outBlinding = hLeaf(secrets.secret, new Fr(++this.noteCounter));
    const output = makeNote(recipient, assetId, amount, outBlinding);
    const outputs = [output];
    if (change > 0n) {
      const chBlinding = hLeaf(secrets.secret, new Fr(++this.noteCounter));
      outputs.push(makeNote(senderId, assetId, change, chBlinding));
    }

    const inputCommitments = selected.map((n) => n.commitment);
    const outputCommitments = outputs.map((n) => n.commitment);
    const transactionCommitment = computeTxCommitment({
      networkId: this.networkId,
      domainId: this.domainId,
      senderId,
      recipientId: recipient,
      assetId,
      amount,
      fee,
      nonce,
      nullifier,
      inputCommitments,
      outputCommitments,
      inputNonces,
      inputNullifiers,
    });
    const txId = txIdFromCommitment(transactionCommitment, nullifier);

    const pub: SpendPublicInputs = {
      oldStateRoot: this.stateRoot(),
      newStateRoot: this.stateRoot(), // filled after apply
      oldNullifierRoot: this.nullifierRoot(),
      newNullifierRoot: this.nullifierRoot(),
      senderId,
      recipientId: recipient,
      treasuryId: TREASURY_ID,
      assetId,
      nullifier,
      amount: u64ToFr(amount),
      fee: u64ToFr(fee),
      transactionCommitment,
    };
    const spendProof = mode === "sender-signature"
      ? { ...SENDER_SIGNATURE_PROOF }
      : DevelopmentSpendProofProvider.prove(pub, { senderSecret: secrets.secret, senderSalt: secrets.salt, nonce });

    const tx: UepTransaction = {
      version: multi ? MULTI_INPUT_TX_VERSION : 1,
      protocol: "UEP-25-prototype",
      networkId: this.networkId,
      domainId: this.domainId,
      txId,
      senderId,
      recipientId: recipient,
      assetId,
      amount,
      fee,
      nonce,
      nullifier,
      inputCommitments,
      outputCommitments,
      inputNotes: selected.map(serializeNote),
      outputNotes: outputs.map(serializeNote),
      transactionCommitment,
      spendProof,
      ...(multi ? { inputNonces, inputNullifiers } : {}),
      phase: "LOCAL_VALID",
      inConflict: false,
      createdAt: now,
    };
    // v0.4.4: publicly verifiable sender signature and note-tree membership proofs.
    tx.senderAuth = signSenderAuth(tx, secrets.secret, secrets.salt);
    tx.inputMembership = selected.map((n) => this.noteTree.prove(n.commitment));

    // Stash outputs on the tx object via a side table
    this.stashOutputs(tx.txId.toHex(), outputs, selected, debit, balancesAfter);
    return tx;
  }

  private outputStash = new Map<
    string,
    { outputs: Note[]; inputs: Note[]; debit: bigint; balances: { sender: bigint; recipient: bigint; treasury: bigint } }
  >();

  private stashOutputs(
    txId: string,
    outputs: Note[],
    inputs: Note[],
    debit: bigint,
    balances: { sender: bigint; recipient: bigint; treasury: bigint },
  ) {
    this.outputStash.set(txId, { outputs, inputs, debit, balances });
  }

  /**
   * v0.5.2 (attack battery, concurrent double spend): check + nullifier insert +
   * apply run in one synchronous turn, so two spends of one note cannot
   * interleave inside one process; this guard also refuses re-entry (a spend
   * submitted from inside another spend's checks). Adapters that await an
   * asynchronous verifier first must serialize through SpendSerializer
   * (src/testnet/spend-serializer.ts). Multi-process deployments need a shared
   * transactional store; that is outside this reference implementation.
   */
  submit(tx: UepTransaction, secrets?: IdentitySecrets): SubmitResult {
    if (this.retired) return { error: { code: "LEDGER_RETIRED", message: RETIRED_MESSAGE } };
    if (this.spendInProgress) return { error: { code: "LEDGER_BUSY", message: "Another spend is being processed by this ledger." } };
    this.spendInProgress = true;
    try {
      return this.submitUnguarded(tx, secrets);
    } finally {
      this.spendInProgress = false;
    }
  }

  private submitUnguarded(tx: UepTransaction, secrets?: IdentitySecrets): SubmitResult {

    if (tx.amount <= 0n) {
      return { error: { code: "AMOUNT_MISMATCH", message: "Transaction amount must be greater than zero." } };
    }
    if (tx.networkId !== this.networkId) {
      return {
        error: {
          code: "WRONG_NETWORK",
          message: "Transaction network does not match this ledger.",
        },
      };
    }
    if (tx.domainId !== this.domainId) {
      return {
        error: {
          code: "WRONG_NETWORK",
          message: "Transaction domain does not match this ledger.",
        },
      };
    }
    if (!this.connected) {
      // v0.4.4: the offline queue only accepts authenticated, locally valid spends.
      const queued = this.enqueuePending(tx);
      if ("error" in queued) return queued;
      return {
        error: {
          code: "NOT_CONNECTED",
          message: "No live network endpoint configured; the transaction was validated and queued for reconciliation.",
        },
      };
    }
    const checked = this.checkSpend(tx, secrets, {});
    if ("error" in checked) return checked;
    return { tx: this.applySpend(tx, checked) };
  }

  /**
   * v0.4.7: submit an atomic batch of single-input spends (from preparePayment()).
   * All parts must share sender, asset and recipient and use distinct inputs.
   * Every part is checked against the state left by the previous parts, with
   * the security policy evaluated over the whole sequence, before any part is
   * applied: either every part is accepted or none is. Each accepted part is an
   * ordinary single-input spend (same rules in submit() and restore()).
   * Batches are not queued offline.
   */
  submitBatch(txs: UepTransaction[], secrets?: IdentitySecrets): BatchResult {
    if (this.retired) return { error: { code: "LEDGER_RETIRED", message: RETIRED_MESSAGE } };
    if (this.spendInProgress) return { error: { code: "LEDGER_BUSY", message: "Another spend is being processed by this ledger." } };
    this.spendInProgress = true;
    try {
      return this.submitBatchUnguarded(txs, secrets);
    } finally {
      this.spendInProgress = false;
    }
  }

  private submitBatchUnguarded(txs: UepTransaction[], secrets?: IdentitySecrets): BatchResult {
    if (!Array.isArray(txs) || txs.length === 0 || txs.length > MAX_PAYMENT_PARTS) return { error: { code: "BATCH_INVALID", message: `A batch carries 1 to ${MAX_PAYMENT_PARTS} spends.` } };
    if (!this.connected) return { error: { code: "NOT_CONNECTED", message: "Payment batches are not queued offline." } };
    const first = txs[0]!;
    const seen = new Set<string>();
    for (const tx of txs) {
      if (!tx || !tx.senderId?.eq(first.senderId) || !tx.assetId?.eq(first.assetId) || !tx.recipientId?.eq(first.recipientId)) return { error: { code: "BATCH_INVALID", message: "Every part of a batch must have the same sender, asset and recipient." } };
      const ids = [`tx:${tx.txId.toHex()}`, ...txNullifiers(tx).map((nf) => `nf:${nf.toHex()}`), ...tx.inputCommitments.map((c) => `in:${c.toHex()}`), ...tx.outputCommitments.map((c) => `out:${c.toHex()}`)];
      for (const id of ids) {
        if (seen.has(id)) return { error: { code: "BATCH_INVALID", message: "Parts of a batch must not share a transaction id, nullifier, input or output note." } };
        seen.add(id);
      }
    }
    for (const [index, tx] of txs.entries()) {
      if (tx.amount <= 0n) return { error: { code: "AMOUNT_MISMATCH", message: "Transaction amount must be greater than zero." }, index };
      if (tx.networkId !== this.networkId || tx.domainId !== this.domainId) return { error: { code: "WRONG_NETWORK", message: "Transaction network or domain does not match this ledger." }, index };
    }
    const assetIdStr = this.assetRecordByFr(first.assetId)?.assetId ?? "unknown";
    const height = this.blockHeight;
    const verdict = this.policy.checkSequence(txs.map((tx) => ({ accountHex: tx.senderId.toHex(), assetId: assetIdStr, amount: tx.amount, fee: tx.fee, height })));
    if (!verdict.ok) return { error: { code: "POLICY", message: `${verdict.code}: ${verdict.message}` } };
    const overlay = new Map<AccountKey, bigint>();
    const checkedParts: CheckedSpend[] = [];
    for (const [index, tx] of txs.entries()) {
      const checked = this.checkSpend(tx, secrets, { skipPolicy: true, overlay });
      if ("error" in checked) return { error: checked.error, index };
      overlay.set(ak(tx.senderId, tx.assetId), checked.next.sender);
      overlay.set(ak(tx.recipientId, tx.assetId), checked.next.recipient);
      overlay.set(ak(TREASURY_ID, tx.assetId), checked.next.treasury);
      checkedParts.push(checked);
    }
    return { txs: txs.map((tx, i) => this.applySpend(tx, checkedParts[i]!)) };
  }

  /**
   * Every rule of a connected submit, without mutating state. `overlay`
   * replaces balances (used by submitBatch); `skipPolicy` when the policy was
   * already evaluated for the whole batch.
   */
  private checkSpend(
    tx: UepTransaction,
    secrets: IdentitySecrets | undefined,
    opts: { skipPolicy?: boolean; overlay?: Map<AccountKey, bigint> },
  ): { error: SubmitError } | CheckedSpend {
    const assetIdStr = this.assetRecordByFr(tx.assetId)?.assetId ?? "unknown";
    const minFee = this.feeFloorOf(tx.assetId);
    if (!opts.skipPolicy) {
    const policyVerdict = this.policy.check(
      {
        accountHex: tx.senderId.toHex(),
        assetId: assetIdStr,
        amount: tx.amount,
        fee: tx.fee,
        height: this.blockHeight,
      },
      false,
    );
    if (!policyVerdict.ok) {
      return { error: { code: "POLICY", message: `${policyVerdict.code}: ${policyVerdict.message}` } };
    }
    }
    if (this.txs.some((t) => t.txId.eq(tx.txId))) {
      return { error: { code: "REPLAY", message: "Transaction already present (idempotent reject)." } };
    }
    const shape = multiInputShapeError(tx);
    if (shape) return { error: { code: "AMOUNT_MISMATCH", message: `Multi-input transaction: ${shape}.` } };
    if (txNullifiers(tx).some((nf) => this.nullifiers.contains(nf))) {
      return { error: { code: "DOUBLE_SPEND", message: "Nullifier already spent." } };
    }
    // v0.4.7: every transported note must be in the transaction asset.
    {
      let transported: Note[] = [];
      try { transported = [...(tx.inputNotes ?? []), ...(tx.outputNotes ?? [])].map(deserializeNote); } catch { transported = []; }
      if (transported.some((n) => !n.assetId.eq(tx.assetId))) {
        return { error: { code: "ASSET_MISMATCH", message: "A transported note is not in the transaction asset." } };
      }
    }

    const recomputed = txCommitmentOf(tx);
    if (!recomputed.eq(tx.transactionCommitment)) {
      return { error: { code: "AMOUNT_MISMATCH", message: "Transaction commitment does not match fields." } };
    }
    const expectId = txIdFromCommitment(tx.transactionCommitment, tx.nullifier);
    if (!expectId.eq(tx.txId)) {
      return { error: { code: "AMOUNT_MISMATCH", message: "TxID does not match canonical commitment." } };
    }
    if (tx.fee !== creatorFee(tx.amount, minFee)) {
      return { error: { code: "AMOUNT_MISMATCH", message: "Fee does not match protocol policy." } };
    }
    if (!this.assetRecordByFr(tx.assetId)) {
      return { error: { code: "ASSET_MISMATCH", message: "Asset is not registered on this network." } };
    }

    if (tx.spendProof?.kind === "sender-signature") {
      // v0.5.0 remote path: public-key verification only (sender signature and
      // input owner keys are checked below); no secret is needed or used.
      const nullifierError = this.checkSignedNullifier(tx);
      if (nullifierError) return { error: nullifierError };
    } else if (tx.spendProof?.kind === "zk-spend") {
      // v0.5.3: witness contract on the tx path. Bound public inputs first, then the verifier.
      if (!this.zkSpendVerifier) return { error: { code: "PROOF", message: "zk-spend proofs need a configured verifier on this ledger." } };
      if (tx.inputNullifiers) return { error: { code: "PROOF", message: "The spend circuit proves one nullifier; multi-input zk-spends are not supported." } };
      const payload = parseZkSpendPayload(tx.spendProof);
      if (!payload) return { error: { code: "PROOF", message: "Malformed zk-spend payload." } };
      const mismatch = zkBindingMismatches(tx, TREASURY_ID, payload);
      if (mismatch.length > 0) return { error: { code: "PROOF", message: `zk-spend public inputs ${mismatch.join(",")} do not match the transaction.` } };
      let ok = false;
      try { ok = this.zkSpendVerifier.verify(payload) === true; } catch { ok = false; }
      if (!ok) return { error: { code: "PROOF", message: "zk-spend proof does not verify." } };
    } else if (secrets) {
      if (!verifyOwnership(secrets.secret, secrets.salt, tx.senderId)) {
        return { error: { code: "WRONG_OWNER", message: "Spender is not the note owner." } };
      }
      if (tx.inputNullifiers) {
        return { error: { code: "PROOF", message: "Multi-input spends are sender-signature spends (the development MAC covers one nullifier)." } };
      }
      const expectN = deriveNullifier(secrets.secret, tx.nonce);
      if (!expectN.eq(tx.nullifier)) {
        return { error: { code: "WRONG_OWNER", message: "Nullifier does not match spending secret." } };
      }
      const pub: SpendPublicInputs = {
        oldStateRoot: this.stateRoot(),
        newStateRoot: this.stateRoot(),
        oldNullifierRoot: this.nullifierRoot(),
        newNullifierRoot: this.nullifierRoot(),
        senderId: tx.senderId,
        recipientId: tx.recipientId,
        treasuryId: TREASURY_ID,
        assetId: tx.assetId,
        nullifier: tx.nullifier,
        amount: u64ToFr(tx.amount),
        fee: u64ToFr(tx.fee),
        transactionCommitment: tx.transactionCommitment,
      };
      if (!verifyDevelopmentMac(tx.spendProof, pub, secrets.secret)) {
        return { error: { code: "PROOF", message: "Development spend MAC is invalid." } };
      }
    } else if (this.requireProof) {
      return {
        error: {
          code: "PROOF",
          message: "Proof required: a sender-signature spend, or the sender identity for a local development MAC.",
        },
      };
    }

    // Transported notes are evidence, not authority. The authoritative ledger
    // must already contain the exact unspent commitment. A sender cannot mint a
    // new balance merely by attaching a self-consistent note to a transaction.
    const resolved = this.canonicalInputs(tx);
    if ("error" in resolved) return resolved;
    const inputs = resolved.inputs;
    const outputs = tx.outputNotes?.map(deserializeNote) ?? [];
    if (outputs.length !== tx.outputCommitments.length || outputs.some((n, i) => !openNote(n) || !n.commitment.eq(tx.outputCommitments[i]!))) {
      return { error: { code: "AMOUNT_MISMATCH", message: "Output notes do not match transaction commitments." } };
    }
    // Bind input and outputs to sender / recipient / amount / change (UEP-B03)
    // and the transaction nonce to the consumed note (UEP-C01).
    const shapeError = checkSpendShape(tx, inputs, outputs, (id) => this.acceptsRecipient(id));
    if (shapeError) return { error: shapeError };
    if (outputs.some((o) => this.noteTree.indexOf(o.commitment) !== undefined)) {
      return { error: { code: "OUTPUT_BINDING", message: "Output note already exists on this ledger." } };
    }
    // v0.4.4: note-tree membership and a publicly verifiable sender signature.
    const membershipError = this.checkMembership(tx, inputs);
    if (membershipError) return { error: membershipError };
    const senderError = this.checkSenderAuth(tx) ?? this.checkInputOwnerKeys(tx, inputs);
    if (senderError) return { error: senderError };
    for (const n of inputs) {
      // Amount/asset bind: recomputing commitment with a mutated amount must fail.
      const mutated = noteCommitment(n.owner, n.assetId, n.amount + 1n, n.blinding);
      if (mutated.eq(n.commitment)) {
        return { error: { code: "AMOUNT_MISMATCH", message: "Commitment is not binding." } };
      }
    }

    const bal = (account: Fr) => opts.overlay?.get(ak(account, tx.assetId)) ?? this.balanceOf(account, tx.assetId);
    const tr = transition(
      { sender: bal(tx.senderId), recipient: bal(tx.recipientId), treasury: bal(TREASURY_ID) },
      tx.amount,
      minFee,
    );
    if ("err" in tr) {
      return { error: { code: "INSUFFICIENT", message: tr.err } };
    }
    return { inputs, outputs, next: tr.ok.new, assetIdStr };
  }

  private applySpend(tx: UepTransaction, checked: CheckedSpend): UepTransaction {
    const { inputs, outputs } = checked;
    const tr = { ok: { new: checked.next } };

    // checkSpend() verified every nullifier is unused; a failure here is an internal error.
    for (const nf of txNullifiers(tx)) {
      if (!this.nullifiers.insertOnce(nf)) throw new Error("LEDGER_INTERNAL: nullifier inserted twice");
    }

    this.setBalance(tx.senderId, tx.assetId, tr.ok.new.sender);
    this.setBalance(tx.recipientId, tx.assetId, tr.ok.new.recipient);
    this.setBalance(TREASURY_ID, tx.assetId, tr.ok.new.treasury);

    // `inputs` are the canonical ledger notes resolved above.
    for (const n of inputs) n.spent = true;
    for (const o of outputs) this.addNote(o);

    const accepted: UepTransaction = { ...tx, phase: "LOCAL_FINAL", inConflict: false };
    this.txs.push(accepted);
    this.outputStash.delete(tx.txId.toHex());
    this.policy.check(
      {
        accountHex: tx.senderId.toHex(),
        assetId: checked.assetIdStr,
        amount: tx.amount,
        fee: tx.fee,
        height: this.blockHeight,
      },
      true,
    );
    return accepted;
  }

  /**
   * Queue a conflicting spend of the same notes (developer / adversarial).
   * Used to exercise UEP-009. reconcilePending() validates queued spends but never
   * applies or settles them; see reconcilePending().
   */
  queueConflict(tx: UepTransaction): SubmitResult {
    return this.enqueuePending(tx);
  }

  /**
   * Add a transaction to the bounded pending queue (v0.4.4, UEP-B06/A06).
   * The envelope must pass validatePending() (authenticated sender, canonical
   * unspent inputs, spend shape, membership proof). Duplicates are refused
   * and the queue never exceeds `maxPendingTransactions`.
   */
  enqueuePending(tx: UepTransaction): SubmitResult {
    if (this.pending.some((p) => p.txId.eq(tx.txId))) return { error: { code: "REPLAY", message: "Transaction already queued." } };
    if (this.pending.length >= this.maxPendingTransactions) return { error: { code: "PENDING_FULL", message: `Pending queue is full (${this.maxPendingTransactions}).` } };
    const check = this.validatePending(tx);
    if ("error" in check) return check;
    const queued: UepTransaction = { ...tx, phase: "LOCAL_VALID", inConflict: false };
    this.pending.push(queued);
    return { tx: { ...queued } };
  }

  private validatePending(tx: UepTransaction): SubmitResult {
    // Pending reconciliation must never promote an unchecked envelope.
    // Validate canonical fields and note commitments without mutating live state.
    if (tx.networkId !== this.networkId || tx.domainId !== this.domainId || tx.amount <= 0n) return { error: { code: "POLICY", message: "Pending transaction envelope invalid." } };
    if (tx.fee !== creatorFee(tx.amount, this.feeFloorOf(tx.assetId))) return { error: { code: "AMOUNT_MISMATCH", message: "Pending fee invalid." } };
    if (multiInputShapeError(tx)) return { error: { code: "AMOUNT_MISMATCH", message: "Pending multi-input transaction malformed." } };
    const recomputed = txCommitmentOf(tx);
    if (!recomputed.eq(tx.transactionCommitment) || !txIdFromCommitment(tx.transactionCommitment, tx.nullifier).eq(tx.txId)) return { error: { code: "AMOUNT_MISMATCH", message: "Pending transaction commitment invalid." } };
    if (txNullifiers(tx).some((nf) => this.nullifiers.contains(nf)) || this.txs.some((x) => x.txId.eq(tx.txId))) return { error: { code: "REPLAY", message: "Pending transaction already committed." } };
    const ins = tx.inputNotes?.map(deserializeNote) ?? [];
    const outs = tx.outputNotes?.map(deserializeNote) ?? [];
    if (ins.length !== tx.inputCommitments.length || outs.length !== tx.outputCommitments.length) return { error: { code: "NOTE_OPENING", message: "Pending transaction notes are missing." } };
    if (ins.some((n, i) => !openNote(n) || !n.commitment.eq(tx.inputCommitments[i]!)) || outs.some((n, i) => !openNote(n) || !n.commitment.eq(tx.outputCommitments[i]!))) return { error: { code: "NOTE_OPENING", message: "Pending note commitment mismatch." } };
    // The sender must be authenticated by the spend key its account commits to
    // (v0.4.5, no registry), and the inputs must be canonical, unspent ledger
    // notes owned by that key's account (same rules as submit()).
    const senderError = this.checkSenderAuth(tx) ?? (tx.spendProof?.kind === "sender-signature" ? this.checkSignedNullifier(tx) : undefined);
    if (senderError) return { error: senderError };
    const resolved = this.canonicalInputs(tx);
    if ("error" in resolved) return resolved;
    const ownerError = this.checkInputOwnerKeys(tx, resolved.inputs);
    if (ownerError) return { error: ownerError };
    // Same input/output binding rules as submit(), on the canonical inputs.
    const shapeError = checkSpendShape(tx, resolved.inputs, outs, (id) => this.acceptsRecipient(id));
    if (shapeError) return { error: shapeError };
    if (outs.some((o) => this.noteTree.indexOf(o.commitment) !== undefined)) return { error: { code: "OUTPUT_BINDING", message: "Pending output note already exists on this ledger." } };
    const membershipError = this.checkMembership(tx, resolved.inputs);
    if (membershipError) return { error: membershipError };
    return { tx };
  }

  reconcilePending(): {
    settlements: ReturnType<typeof reconcile>;
    root: Fr;
    queued: UepTransaction[];
    rejected: Array<{ txId: string; code: SubmitError["code"]; message: string }>;
  } {
    // LOCAL_FINAL transactions have already mutated balances and the nullifier set.
    // They are not eligible to be overturned by a later pending conflict.
    //
    // Pending transactions are not applied here. Since v0.4.4 every queued spend is
    // sender-signed and checked against local unspent notes and the note tree, but
    // the development MAC can only be verified with the sender's secret, and applying
    // a spend remains an explicit submit(). Therefore:
    //   - entries that no longer validate (bad envelope, sender signature, inputs,
    //     membership, or an already committed nullifier) are rejected and removed;
    //   - structurally valid ones STAY queued in phase LOCAL_VALID (never SETTLED
    //     without a state transition), flagged `inConflict` when several queued
    //     spends share a nullifier. They must be applied through submit().
    const committedNullifiers = new Set(this.txs.flatMap((t) => txNullifiers(t).map((nf) => nf.toHex())));
    const rejected: Array<{ txId: string; code: SubmitError["code"]; message: string }> = [];
    const validCandidates: UepTransaction[] = [];
    for (const candidate of this.pending) {
      if (txNullifiers(candidate).some((nf) => committedNullifiers.has(nf.toHex()))) {
        rejected.push({ txId: candidate.txId.toHex(), code: "REPLAY", message: "Nullifier already committed locally." });
        continue;
      }
      const check = this.validatePending(candidate);
      if ("tx" in check) validCandidates.push(candidate);
      else rejected.push({ txId: candidate.txId.toHex(), code: check.error.code, message: check.error.message });
    }
    // Conflicts: several queued spends share a nullifier or an input note.
    const inputUse = new Map<string, number>();
    for (const t of validCandidates) for (const c of t.inputCommitments) inputUse.set(c.toHex(), (inputUse.get(c.toHex()) ?? 0) + 1);
    const queued = markConflicts(validCandidates).map((t) => ({
      ...t,
      inConflict: t.inConflict || t.inputCommitments.some((c) => (inputUse.get(c.toHex()) ?? 0) > 1),
      phase: "LOCAL_VALID" as const,
    }));
    this.pending = queued;
    this.lastReconcileAt = this.blockHeight;
    const settlements: ReturnType<typeof reconcile> = [];
    return { settlements, root: settlementRoot(settlements), queued: queued.map((t) => ({ ...t })), rejected };
  }

  /** Unsigned snapshot payload for the next snapshot in this ledger's chain (does not advance the chain). */
  snapshotPayload() {
    return {
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      sequence: this.snapshotSequence + 1,
      prevSnapshotHash: this.lastSnapshotHash,
      networkId: this.networkId,
      domainId: this.domainId,
      connected: this.connected,
      allowFaucet: this.allowFaucet,
      policy: { ...this.policy.config, blockedAccounts: [...this.policy.config.blockedAccounts], assetTier: { ...this.policy.config.assetTier } },
      state: this.state.toJSON(),
      nullifiers: this.nullifiers.toJSON(),
      balances: [...this.balances.entries()].map(([k, v]) => [k, v.toString()] as const),
      mints: this.mints.map((m) => ({ ...m })),
      notes: this.notes.map(serializeNote),
      txs: this.txs.map(serializeTx),
      // Entries that no longer validate (e.g. input spent since queuing) are not exported.
      pending: this.pending.filter((t) => "tx" in this.validatePending(t)).map(serializeTx),
      maxPendingTransactions: this.maxPendingTransactions,
      noteRoot: this.noteTree.root().toHex(),
      noteCount: this.noteTree.size,
      noteCounter: this.noteCounter.toString(),
      lastReconcileAt: this.lastReconcileAt,
      height: this.blockHeight,
      assetRegistry: this.assetRegistryBinding(),
      settlementAnchors: this.settlementAnchors.map((a) => ({ ...a, settlementIds: [...a.settlementIds], totals: { ...a.totals } })),
    };
  }

  /**
   * Produce the next signed snapshot: signed by every snapshot authority key this
   * node holds and linked to the previous snapshot by `prevSnapshotHash`.
   */
  snapshot(): UepLedgerSnapshot {
    // v0.5.3: a retired ledger must not sign a second, diverging history.
    if (this.retired) throw new Error(`LEDGER_RETIRED: ${RETIRED_MESSAGE}`);
    if (this.snapshotSigners.length === 0) throw new Error("SNAPSHOT_SIGNING_KEY_REQUIRED");
    const signed = signSnapshot(this.snapshotPayload(), this.snapshotSigners);
    this.snapshotSequence = signed.sequence;
    this.lastSnapshotHash = signed.snapshotHash;
    return signed;
  }

  /**
   * Restore a snapshot against public trust anchors only.
   *  1. Format v4 is required (older formats are rejected).
   *  2. At least `threshold` distinct snapshot authorities must have signed the
   *     snapshot hash; any invalid signature by a listed authority is rejected.
   *  3. Chain continuity: optional `previousSnapshotHash` / `checkpoint` must be
   *     extended (a reordered or rewritten history is rejected even if signed).
   *  4. Every faucet mint carries a valid signature by a trusted faucet key that
   *     is distinct from the snapshot authorities; every non-output note is minted.
   *  5. The full state is re-derived and every v0.4.2 invariant is checked.
   *  6. v0.4.4: the note-commitment tree is rebuilt and must match `noteRoot`;
   *     every committed spend carries a membership proof against an earlier
   *     root; every pending entry is re-validated against the restored state
   *     and the queue bound.
   *  7. v0.4.5: every note owner is a key-derived account id, and every
   *     committed spend reveals a key that hashes to its sender and input-note
   *     owner and signed it. There is no spend-key registry to trust.
   * A restored ledger can only sign snapshots or mint if `keys` are passed.
   */
  static restore(data: UepLedgerSnapshot, trust: SnapshotTrust, keys: LedgerSigningKeys = {}, opts: RestoreOptions = {}): UepLedger {
    const fail = (code: string, detail?: string): never => { throw new Error(`INVALID_SNAPSHOT_${code}${detail ? `: ${detail}` : ""}`); };
    if (!data || typeof data !== "object") fail("SHAPE");
    // v0.5.1 (docs/COMPATIBILITY.md): older formats are migrated step by step
    // (snapshot-migrations.ts) after their signatures and chain links are
    // checked against the bytes that were signed. Formats behind a hash change
    // cannot be migrated and are rejected with the reason.
    const sourceFormat = (data as { formatVersion?: unknown }).formatVersion ?? 1;
    const support = snapshotFormatSupport(sourceFormat);
    if (support.kind !== "current" && support.kind !== "migratable") fail("VERSION", support.reason);
    if (data.networkId == null || data.domainId == null || !data.state || !data.nullifiers || !Array.isArray(data.nullifiers.seen) || !Array.isArray(data.balances) || !Array.isArray(data.notes) || !Array.isArray(data.txs) || !Array.isArray(data.pending) || !Array.isArray(data.mints) || !data.policy || !Array.isArray(data.signatures)) fail("SHAPE");
    if ((data as { spendKeys?: unknown }).spendKeys !== undefined) fail("SPEND_KEY", "v0.4.5 snapshots carry no spend-key registry; ownership is bound by key-derived account ids");
    if (typeof data.noteRoot !== "string" || !Number.isSafeInteger(data.noteCount) || !Number.isSafeInteger(data.maxPendingTransactions)) fail("SHAPE");
    if (!Number.isSafeInteger(data.sequence) || data.sequence < 1 || typeof data.prevSnapshotHash !== "string" || !/^[0-9a-f]{64}$/.test(data.prevSnapshotHash)) fail("SHAPE");

    // Trust anchors (public keys only).
    if (!trust || !Array.isArray(trust.authorities) || trust.authorities.length === 0) fail("TRUST", "at least one snapshot authority public key is required");
    const authorities = distinctKeyHexes(trust.authorities, "INVALID_SNAPSHOT_TRUST: authority keys must be distinct Ed25519 public keys");
    const threshold = trust.threshold ?? 1;
    if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > authorities.length) fail("TRUST", "threshold must be between 1 and the number of authorities");
    const faucetKeys = distinctKeyHexes(trust.faucetPublicKeys, "INVALID_SNAPSHOT_TRUST: faucet keys must be distinct Ed25519 public keys");
    if (faucetKeys.some((k) => authorities.includes(k))) fail("TRUST", "faucet keys must be distinct from snapshot authority keys");
    // v0.4.7: per-asset issuer keys and mint-key revocations.
    if (trust.issuerKeys !== undefined && !Array.isArray(trust.issuerKeys)) fail("TRUST", "issuerKeys must be an array");
    if (trust.revokedMintKeys !== undefined && !Array.isArray(trust.revokedMintKeys)) fail("TRUST", "revokedMintKeys must be an array");
    const issuerEntries: Array<{ hex: string; assetIds: string[]; from: number }> = [];
    for (const e of trust.issuerKeys ?? []) {
      let hex = "";
      try { hex = publicKeyHexOf(e.publicKey); } catch { fail("TRUST", "issuer keys must be Ed25519 public keys"); }
      const from = e.fromMintIndex ?? 0;
      const ids = Array.isArray(e.assetIds) ? e.assetIds.map((a) => resolveAssetIdAlias(a)) : [];
      if (ids.length === 0 || ids.some((a) => !isCanonicalLedgerAssetId(a) || !findAsset(data.networkId, a))) fail("TRUST", "issuer keys must list registered asset ids of the snapshot network");
      if (!Number.isSafeInteger(from) || from < 0) fail("TRUST", "issuer fromMintIndex must be a non-negative integer");
      if (authorities.includes(hex)) fail("TRUST", "issuer keys must be distinct from snapshot authority keys");
      issuerEntries.push({ hex, assetIds: ids, from });
    }
    const revocations: Array<{ hex: string; from: number }> = [];
    for (const r of trust.revokedMintKeys ?? []) {
      let hex = "";
      try { hex = publicKeyHexOf(r.publicKey); } catch { fail("TRUST", "revoked mint keys must be Ed25519 public keys"); }
      if (!Number.isSafeInteger(r.fromMintIndex) || r.fromMintIndex < 0) fail("TRUST", "revocation fromMintIndex must be a non-negative integer");
      revocations.push({ hex, from: r.fromMintIndex });
    }
    const notRevokedAt = (hex: string, index: number) => !revocations.some((r) => r.hex === hex && index >= r.from);
    /** Keys that may sign mint `index` of `assetIdStr`: scoped issuer keys if the asset has any, else the faucet keys. */
    const mintKeysFor = (assetIdStr: string, index: number): string[] => {
      const scoped = issuerEntries.filter((e) => e.assetIds.includes(assetIdStr));
      const keys = scoped.length > 0 ? scoped.filter((e) => index >= e.from).map((e) => e.hex) : faucetKeys;
      return keys.filter((k) => notRevokedAt(k, index));
    };

    // 1-2. Hash and k-of-n authority signatures.
    const hash = snapshotHash(data);
    if (data.snapshotHash !== hash) fail("HASH");
    const signers = new Set<string>();
    for (const sig of data.signatures) {
      if (!sig || typeof sig.publicKey !== "string" || typeof sig.signature !== "string") fail("SIGNATURE");
      let hex: string;
      try { hex = publicKeyHexOf(sig.publicKey); } catch { continue; }
      if (!authorities.includes(hex)) continue; // signatures by unknown keys carry no weight
      if (!verifyEd25519(hash, sig.signature, hex)) fail("SIGNATURE");
      signers.add(hex);
    }
    if (signers.size < threshold) fail("THRESHOLD", `${signers.size} distinct valid authority signature(s), ${threshold} required`);

    // 3. Chain continuity.
    if ((data.sequence === 1) !== (data.prevSnapshotHash === GENESIS_SNAPSHOT_HASH)) fail("CHAIN");
    if (trust.previousSnapshotHash !== undefined && data.prevSnapshotHash !== trust.previousSnapshotHash) fail("CHAIN", "prevSnapshotHash does not match the expected previous snapshot");
    const cp = trust.checkpoint;
    if (cp) {
      if (data.sequence < cp.sequence) fail("CHAIN", "snapshot is older than the trusted checkpoint");
      if (data.sequence === cp.sequence && hash !== cp.snapshotHash) fail("CHAIN", "snapshot conflicts with the trusted checkpoint");
      if (data.sequence === cp.sequence + 1 && data.prevSnapshotHash !== cp.snapshotHash) fail("CHAIN", "snapshot does not extend the trusted checkpoint");
      if (data.txs.length < cp.txCount || txChainHash(data.txs, cp.txCount) !== cp.txChainHash) fail("HISTORY", "transaction history diverges from the trusted checkpoint");
      if (data.mints.length < cp.mintCount || mintChainHash(data.mints, cp.mintCount) !== cp.mintChainHash) fail("HISTORY", "mint history diverges from the trusted checkpoint");
    }

    // Migration to the current format (pure; transactions and mints are not
    // rewritten). The chain keeps the hash of the snapshot as signed.
    let migrationSteps: string[] = [];
    if (support.kind === "migratable") {
      try {
        const migrated = migrateSnapshotPayload(payloadOf(data) as unknown as Record<string, unknown>);
        migrationSteps = migrated.steps;
        data = { ...(migrated.payload as unknown as UepLedgerSnapshotPayload), snapshotHash: data.snapshotHash, signatures: data.signatures };
      } catch (e) {
        fail("MIGRATION", (e as Error).message);
      }
      deprecate(DEPRECATIONS.SNAPSHOT_MIGRATED, `restored a format ${String(sourceFormat)} snapshot through the migration registry; the next snapshot of this ledger is written in format ${SNAPSHOT_FORMAT_VERSION}`);
    }

    let l!: UepLedger;
    try {
      l = new UepLedger({
        networkId: data.networkId,
        domainId: data.domainId,
        connected: data.connected,
        allowFaucet: data.allowFaucet,
        snapshotSigningKeys: [],
        faucetSigningKey: null,
        maxPendingTransactions: data.maxPendingTransactions,
        assetRegistry: trust.assetRegistry,
      });
    } catch (e) {
      fail("PENDING", (e as Error).message);
    }
    // v0.5.3: settlement anchors re-checked (hash chain, indexes, no settlement anchored twice).
    {
      const anchors = (data as { settlementAnchors?: unknown }).settlementAnchors;
      const problem = anchorChainProblem(anchors);
      if (problem) fail("SETTLEMENT_ANCHOR", problem);
      const lastAnchor = (anchors as SettlementAnchor[])[(anchors as SettlementAnchor[]).length - 1];
      if (lastAnchor && lastAnchor.height > (data as { height: number }).height) fail("SETTLEMENT_ANCHOR", "anchor height above the snapshot height");
      l.settlementAnchors = (anchors as SettlementAnchor[]).map((a) => ({ ...a, settlementIds: [...a.settlementIds], totals: { ...a.totals } }));
      for (const a of l.settlementAnchors) {
        const set = l.anchoredSettlements.get(a.marketplaceId) ?? new Set<string>();
        for (const id of a.settlementIds) set.add(id);
        l.anchoredSettlements.set(a.marketplaceId, set);
      }
    }
    // v0.5.3 (ADR 0001): the registry bound by the snapshot must be the trusted one (or an earlier version of its chain).
    {
      const bound = (data as { assetRegistry?: unknown }).assetRegistry;
      if (bound !== null && bound !== undefined) {
        const b = bound as { networkId?: unknown; version?: unknown; hash?: unknown };
        if (typeof b.hash !== "string" || !Number.isSafeInteger(b.version) || b.networkId !== data.networkId) fail("ASSET_REGISTRY", "malformed registry binding");
        if (!trust.assetRegistry) fail("ASSET_REGISTRY", "the snapshot binds an asset registry; pass trust.assetRegistry");
        const chain = trust.assetRegistry.chain();
        const at = chain.find((m) => m.version === b.version);
        if (!at || at.manifestHash !== b.hash) fail("ASSET_REGISTRY", "the snapshot's registry hash is not in the trusted registry chain");
      }
    }
    // Optional private keys for an authority node resuming its own chain.
    if (keys.snapshotSigningKeys?.some((k) => !authorities.includes(publicKeyHexOf(toPrivateKey(k))))) throw new Error("SNAPSHOT_SIGNING_KEY_NOT_TRUSTED");
    if (keys.faucetSigningKey !== undefined && !faucetKeys.includes(publicKeyHexOf(toPrivateKey(keys.faucetSigningKey)))) throw new Error("FAUCET_KEY_NOT_TRUSTED");
    if (keys.faucetSigningKey !== undefined && !notRevokedAt(publicKeyHexOf(toPrivateKey(keys.faucetSigningKey)), data.mints.length)) throw new Error("FAUCET_KEY_NOT_TRUSTED");
    for (const [rawAssetId, k] of Object.entries(keys.issuerSigningKeys ?? {})) {
      const assetIdStr = resolveAssetIdAlias(rawAssetId);
      if (!mintKeysFor(assetIdStr, data.mints.length).includes(publicKeyHexOf(toPrivateKey(k))) || !issuerEntries.some((e) => e.assetIds.includes(assetIdStr))) throw new Error("ISSUER_KEY_NOT_TRUSTED");
    }
    l.installSigningKeys(keys.snapshotSigningKeys ?? [], keys.faucetSigningKey, keys.issuerSigningKeys);
    l.state = SparseMerkleTree.fromJSON(data.state);
    l.balances = new Map(data.balances.map(([k, v]) => [k, BigInt(v)]));
    l.notes = data.notes.map(deserializeNote);
    l.txs = data.txs.map(deserializeTx);
    l.noteCounter = BigInt(data.noteCounter);
    // v0.5.1 (format 7): the block height is a non-negative safe integer and not below the last reconcile height.
    if (!Number.isSafeInteger(data.height) || data.height < 0 || !Number.isSafeInteger(data.lastReconcileAt) || data.lastReconcileAt < 0 || data.lastReconcileAt > data.height) fail("HEIGHT", "height must be a non-negative integer, at or above lastReconcileAt");
    l.lastReconcileAt = data.lastReconcileAt;
    l.blockHeight = data.height;
    // v0.5.1: the height never goes backwards unless the operator forces a rollback.
    if (opts.allowHeightRegression !== true) {
      const floors: Array<[string, unknown]> = [["checkpoint", trust.checkpoint?.height], ["minHeight", opts.minHeight], ["replaced ledger", opts.replaces?.height]];
      for (const [what, floor] of floors) {
        if (floor === undefined) continue;
        if (!Number.isSafeInteger(floor) || (floor as number) < 0) fail("HEIGHT", `${what} height is not a non-negative integer`);
        if (data.height < (floor as number)) fail("HEIGHT_REGRESSION", `restored height ${data.height} is below the ${what} height ${floor}; pass allowHeightRegression to force a rollback`);
      }
    }
    const p = { ...(data.policy as any) };
    // Policy amounts may arrive as "<digits>n" strings when a snapshot was read with plain JSON.parse (same hash).
    for (const k of ["maxTransferAmount", "maxTransferPerWindow", "minFee"]) if (p[k] !== undefined) { try { p[k] = toPolicyBigint(p[k]); } catch { fail("POLICY", `${k} is not an amount`); } }
    l.policy = new SecurityPolicy({ ...p, blockedAccounts: new Set(p.blockedAccounts ?? []), assetTier: { ...(p.assetTier ?? {}) } });

    // 1. Account state root is re-derived from balances.
    const rebuiltState = new SparseMerkleTree(ACCOUNT_DEPTH);
    for (const [key, value] of l.balances) {
      const [accountHex, assetHex] = key.split("|");
      if (!accountHex || !assetHex) fail("BALANCE_KEY");
      if (value < 0n || value >= 2n ** 64n) fail("BALANCE_RANGE");
      const account = new Fr(accountHex!); const asset = new Fr(assetHex!);
      if (ak(account, asset) !== key) fail("BALANCE_KEY");
      rebuiltState.set(hAccount(account, asset), l.leafFor(account, asset, value));
    }
    if (!rebuiltState.root().eq(l.state.root())) fail("STATE_ROOT");

    // 2. Every note opens, has a well-formed nonce and appears once.
    const noteByCommitment = new Map<string, Note>();
    for (const n of l.notes) {
      if (!openNote(n)) fail("NOTE_COMMITMENT");
      if (!n.nonce.eq(noteNonce(n.commitment, n.blinding))) fail("NOTE_NONCE");
      if (noteByCommitment.has(n.commitment.toHex())) fail("NOTE_DUPLICATE");
      // v0.5.0: v3 ids, or the v2 form of state written v0.4.5 to v0.5.0 (grandfathered; its spends still need the key).
      if (!isKeyDerivedOrV2Form(n.owner)) fail("NOTE_OWNER", "note owner is not a key-derived account");
      if (!l.assetRecordByFr(n.assetId)) fail("NOTE_ASSET", "note asset is not registered on this network");
      noteByCommitment.set(n.commitment.toHex(), n);
    }
    // 2b. Note-commitment tree rebuilt in creation order must match the signed root.
    // (The root is compared after the mint and supply checks, so their errors keep precedence.)
    for (const n of l.notes) l.noteTree.append(n.commitment);

    // 3. Transactions replay in order under submit()'s rules.
    const outputCommitments = new Set<string>();
    for (const tx of l.txs) for (const c of tx.outputCommitments) outputCommitments.add(c.toHex());
    // Notes that are not the output of any transaction must be signed faucet mints.
    const mintedCommitments = new Set<string>();
    const minted = new Map<string, bigint>();
    if (data.mints.length > 0 && faucetKeys.length === 0 && issuerEntries.length === 0) fail("MINT_KEY", "snapshot contains mints but no trusted faucet public key was supplied");
    data.mints.forEach((m, i) => {
      if (!m || m.index !== i || m.networkId !== l.networkId || m.domainId !== l.domainId || typeof m.commitment !== "string" || typeof m.amount !== "string" || !/^[0-9]+$/.test(m.amount) || typeof m.assetId !== "string") fail("MINT_SHAPE");
      // v0.4.7: only registered assets can be minted, and only by a key trusted for that asset at this index.
      let assetFr: Fr | undefined;
      try { assetFr = new Fr(m.assetId); } catch { fail("MINT_SHAPE"); }
      const asset = l.assetRecordByFr(assetFr!);
      if (!asset || assetFr!.toHex() !== m.assetId) fail("MINT_ASSET", `mint ${i} is for an asset that is not registered on this network`);
      const { signature, ...unsigned } = m;
      if (!mintKeysFor(asset!.assetId, i).some((k) => verifyEd25519(mintMessage(unsigned), signature, k))) fail("MINT_SIGNATURE", `mint ${i} is unsigned or not signed by a key trusted for this asset`);
      const note = noteByCommitment.get(m.commitment);
      if (!note || outputCommitments.has(m.commitment) || note.owner.toHex() !== m.account || note.assetId.toHex() !== m.assetId || note.amount.toString() !== m.amount) fail("MINT_NOTE");
      if (mintedCommitments.has(m.commitment)) fail("MINT_DUPLICATE");
      mintedCommitments.add(m.commitment);
      minted.set(m.assetId, (minted.get(m.assetId) ?? 0n) + BigInt(m.amount));
    });
    l.mints = data.mints.map((m) => ({ ...m }));
    l.supply = new Map(minted);
    const available = new Set<string>(mintedCommitments);
    const consumed = new Set<string>();
    const txIds = new Set<string>();
    const feesByAsset = new Map<string, bigint>();
    const rebuiltNullifiers = new NullifierSet();
    for (const tx of l.txs) {
      if (tx.networkId !== l.networkId || tx.domainId !== l.domainId) fail("TX_NETWORK");
      if (txIds.has(tx.txId.toHex())) fail("TX_DUPLICATE");
      txIds.add(tx.txId.toHex());
      if (multiInputShapeError(tx)) fail("TX_INPUTS");
      for (const nf of txNullifiers(tx)) if (!rebuiltNullifiers.insertOnce(nf)) fail("NULLIFIER_SET");
      if (tx.spendProof?.kind === "sender-signature" && txNullifiers(tx).some((nf, i) => !signedSpendNullifier(tx.senderId, txNonces(tx)[i]!).eq(nf))) fail("TX_NULLIFIER");
      if (tx.amount <= 0n || tx.fee !== creatorFee(tx.amount, l.feeFloorOf(tx.assetId))) fail("TX_VALUE");
      if (!l.assetRecordByFr(tx.assetId)) fail("TX_ASSET");
      if (!tx.inputNotes || !tx.outputNotes || tx.inputNotes.length !== tx.inputCommitments.length || tx.outputNotes.length !== tx.outputCommitments.length) fail("TX_NOTES");
      const recomputed = txCommitmentOf(tx);
      if (!recomputed.eq(tx.transactionCommitment) || !txIdFromCommitment(tx.transactionCommitment, tx.nullifier).eq(tx.txId)) fail("TX_COMMITMENT");
      const ins = tx.inputNotes!.map(deserializeNote); const outs = tx.outputNotes!.map(deserializeNote);
      if (ins.some((n, i) => !openNote(n) || !n.commitment.eq(tx.inputCommitments[i]!)) || outs.some((n, i) => !openNote(n) || !n.commitment.eq(tx.outputCommitments[i]!))) fail("TX_NOTES");
      const shapeError = checkSpendShape(tx, ins, outs);
      if (shapeError) {
        const map: Partial<Record<SubmitError["code"], string>> = { OUTPUT_BINDING: "TX_OUTPUT_BINDING", NOTE_NONCE: "TX_NONCE", INVALID_PARTICIPANTS: "TX_PARTICIPANTS", WRONG_OWNER: "TX_OWNER", ASSET_MISMATCH: "TX_ASSET" };
        fail(map[shapeError.code] ?? "TX_VALUE");
      }
      for (const n of ins) {
        const key = n.commitment.toHex();
        if (!noteByCommitment.has(key)) fail("TX_INPUT_MISSING");
        if (consumed.has(key) || !available.has(key)) fail("TX_ORDER");
        available.delete(key); consumed.add(key);
      }
      for (const o of outs) {
        if (!noteByCommitment.has(o.commitment.toHex())) fail("TX_OUTPUT_MISSING");
        available.add(o.commitment.toHex());
      }
      // v0.4.4: membership proof against a root that predates this spend's outputs.
      // v0.4.5: the revealed key hashes to the sender and to every input-note owner,
      // and signed the envelope (no registry).
      const firstOutput = outs.length > 0 ? Math.min(...outs.map((o) => l.noteTree.indexOf(o.commitment)!)) : l.noteTree.size;
      if (!Array.isArray(tx.inputMembership) || tx.inputMembership.length !== ins.length) fail("TX_MEMBERSHIP");
      ins.forEach((n, i) => {
        const proof = tx.inputMembership![i]!;
        if (proof?.leafIndex !== String(l.noteTree.indexOf(n.commitment)) || !l.noteTree.verify(n.commitment, proof, firstOutput)) fail("TX_MEMBERSHIP");
      });
      const senderFailure = senderAuthFailure(tx);
      if (senderFailure === "OWNER_KEY") fail("OWNER_KEY", "a spend's revealed key does not hash to its sender account");
      if (senderFailure) fail("TX_SENDER");
      if (ins.some((n) => !spendKeyMatchesAccount(tx.senderAuth!.publicKey, n.owner))) fail("OWNER_KEY", "an input note owner does not match the spend's revealed key");
      feesByAsset.set(tx.assetId.toHex(), (feesByAsset.get(tx.assetId.toHex()) ?? 0n) + tx.fee);
    }

    // 4. Nullifier tree and seen set equal exactly the committed nullifiers.
    if (!rebuiltNullifiers.root().eq(new NullifierSet(SparseMerkleTree.fromJSON(data.nullifiers.tree)).root())) fail("NULLIFIER_ROOT");
    const seen = new Set(data.nullifiers.seen);
    const committedNfs = l.txs.flatMap((t) => txNullifiers(t).map((nf) => nf.toHex()));
    if (seen.size !== data.nullifiers.seen.length || seen.size !== committedNfs.length || committedNfs.some((nf) => !seen.has(nf))) fail("NULLIFIER_SEEN");
    l.nullifiers = rebuiltNullifiers;

    // 5. A note is spent iff it was consumed by a committed transaction.
    for (const n of l.notes) if (n.spent !== consumed.has(n.commitment.toHex())) fail("SPENT_FLAG");

    // Every note is either a signed faucet mint or the output of a committed transaction.
    for (const c of noteByCommitment.keys()) if (!outputCommitments.has(c) && !mintedCommitments.has(c)) fail("UNMINTED_NOTE");

    // 6. Balances equal unspent notes per (owner, asset), plus fee income for the treasury.
    const expectedBalances = new Map<string, bigint>();
    for (const n of l.notes) if (!n.spent) expectedBalances.set(ak(n.owner, n.assetId), (expectedBalances.get(ak(n.owner, n.assetId)) ?? 0n) + n.amount);
    for (const [assetHex, fees] of feesByAsset) {
      const k = ak(TREASURY_ID, new Fr(assetHex));
      expectedBalances.set(k, (expectedBalances.get(k) ?? 0n) + fees);
    }
    for (const k of new Set([...expectedBalances.keys(), ...l.balances.keys()])) {
      if ((expectedBalances.get(k) ?? 0n) !== (l.balances.get(k) ?? 0n)) fail("NOTE_BALANCE");
    }

    // 7. Supply: total balances per asset equal the signed mint total.
    const totals = new Map<string, bigint>();
    for (const [k, v] of l.balances) { const assetHex = k.split("|")[1]!; totals.set(assetHex, (totals.get(assetHex) ?? 0n) + v); }
    for (const assetHex of new Set([...minted.keys(), ...totals.keys()])) {
      if ((minted.get(assetHex) ?? 0n) !== (totals.get(assetHex) ?? 0n)) fail("SUPPLY");
    }

    if (l.noteTree.size !== data.noteCount || l.noteTree.root().toHex() !== data.noteRoot) fail("NOTE_ROOT");

    // 8. Pending queue: bounded, unique, and every entry valid against the restored state.
    if (data.pending.length > l.maxPendingTransactions) fail("PENDING", "pending queue exceeds maxPendingTransactions");
    for (const raw of data.pending) {
      let tx: UepTransaction;
      try { tx = deserializeTx(raw); } catch { fail("PENDING", "malformed pending transaction"); }
      if (l.pending.some((p) => p.txId.eq(tx!.txId))) fail("PENDING", "duplicate pending transaction");
      const check = l.validatePending(tx!);
      if ("error" in check) fail("PENDING", `${check.error.code}: ${check.error.message}`);
      l.pending.push({ ...tx!, phase: "LOCAL_VALID" });
    }

    l.snapshotSequence = data.sequence;
    l.lastSnapshotHash = hash;
    l.restoredFrom = { formatVersion: sourceFormat as number, migrationSteps };
    opts.replaces?.retire?.();
    return l;
  }

  /** v0.5.1: retire this ledger (called by restore(..., { replaces: this })); advanceHeight then throws LEDGER_RETIRED. */
  retire(): void {
    this.retired = true;
  }

  /**
   * Restore the last snapshot of an ordered chain, verifying every link:
   * each snapshot must be signed per `trust`, directly follow its predecessor
   * and extend its predecessor's transaction and mint history.
   */
  static restoreChain(snapshots: UepLedgerSnapshot[], trust: SnapshotTrust, keys: LedgerSigningKeys = {}, opts: RestoreOptions = {}): UepLedger {
    if (!Array.isArray(snapshots) || snapshots.length === 0) throw new Error("INVALID_SNAPSHOT_CHAIN: empty chain");
    let restored: UepLedger | undefined;
    let prev: UepLedgerSnapshot | undefined;
    for (const [i, snap] of snapshots.entries()) {
      const linkTrust: SnapshotTrust = prev ? { ...trust, previousSnapshotHash: snapshotHash(prev), checkpoint: checkpointOf(prev) } : trust;
      if (prev && snap?.sequence !== prev.sequence + 1) throw new Error("INVALID_SNAPSHOT_CHAIN: sequence gap or reorder");
      const last = i === snapshots.length - 1;
      restored = UepLedger.restore(snap, linkTrust, last ? keys : {}, last ? opts : { allowHeightRegression: opts.allowHeightRegression });
      prev = snap;
    }
    return restored!;
  }
}
