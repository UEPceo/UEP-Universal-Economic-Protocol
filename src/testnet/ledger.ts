/**
 * In-process UEP ledger. One instance per network (and per planetary domain).
 * Status: IMPLEMENTED (local). Multi-node P2P: CONCEPTUAL.
 */
import { Fr } from "../core/field.ts";
import { ACCOUNT_DEPTH } from "../core/smt.ts";
import { NullifierSet } from "../core/nullifier.ts";
import { SparseMerkleTree } from "../core/smt.ts";
import { markConflicts, reconcile, settlementRoot } from "../core/reconciliation.ts";
import { assetsForNetwork, findAsset } from "../core/assets.ts";
import { hAccount, hLeaf } from "../core/hash.ts";
import { creatorFee, requiredSenderDebit } from "../core/fee.ts";
import { deriveNullifier } from "../core/nullifier.ts";
import { deserializeNote, makeNote, noteCommitment, noteNonce, openNote, serializeNote, type Note } from "../core/note.ts";
import { computeTxCommitment, deserializeTx, serializeTx, txIdFromCommitment, verifyOwnership, type UepTransaction } from "../core/transaction.ts";
import { encodeStringToFr, u64ToFr } from "../core/encoding.ts";
import { transition } from "../core/transition.ts";
import { TREASURY_ID } from "../network/profiles.ts";
import { SecurityPolicy, type SecurityPolicy as SecurityPolicyType, type RiskTier } from "../core/security-policy.ts";
import { DevelopmentSpendProofProvider, verifyDevelopmentMac, type SpendPublicInputs } from "../core/spend-proof.ts";
import type { IdentitySecrets } from "../identity/kdf.ts";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

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
  | { code: "OFFLINE_QUEUED"; message: string };

export type SubmitResult = { tx: UepTransaction } | { error: SubmitError };

type AccountKey = string; // accountHex|assetHex

function ak(account: Fr, asset: Fr): AccountKey {
  return account.toHex() + "|" + asset.toHex();
}

export type UepLedgerSnapshot = ReturnType<UepLedger["snapshot"]>;

/** Snapshot format version. v2 (0.4.2) adds `formatVersion` and per-asset minted `supply`. */
export const SNAPSHOT_FORMAT_VERSION = 2;

function snapshotPayload(data: Omit<UepLedgerSnapshot, "integrity">): string {
  return JSON.stringify(data, (_key, value) => typeof value === "bigint" ? `${value}n` : value);
}

/**
 * HMAC-SHA256 integrity tag of a snapshot payload (everything except `integrity`).
 * Requires the external snapshot authority secret.
 */
export function signSnapshotPayload(data: Omit<UepLedgerSnapshot, "integrity">, snapshotAuthoritySecret: string | Uint8Array): string {
  return createHmac("sha256", Buffer.from(snapshotAuthoritySecret)).update(snapshotPayload(data)).digest("hex");
}

/**
 * Structural rules of a single-input spend, shared by submit(), pending
 * validation and restore() so that all three accept exactly the same
 * transactions:
 *   - sender, recipient and treasury are distinct accounts;
 *   - exactly one input note, owned by the sender, in the transaction asset,
 *     with a well-formed note nonce equal to `tx.nonce` (the nullifier is
 *     derived from that nonce);
 *   - output 0 pays exactly `amount` to the recipient;
 *   - output 1 (present iff change > 0) returns `input - amount - fee` to the sender.
 * Note openings against the transaction commitments are checked by the caller.
 */
export function checkSpendShape(tx: UepTransaction, inputs: Note[], outputs: Note[]): SubmitError | undefined {
  if (tx.senderId.eq(tx.recipientId) || tx.senderId.eq(TREASURY_ID) || tx.recipientId.eq(TREASURY_ID)) {
    return { code: "INVALID_PARTICIPANTS", message: "Sender, recipient and treasury must be distinct accounts." };
  }
  if (inputs.length !== 1) return { code: "AMOUNT_MISMATCH", message: "Public testnet spends use exactly one input note." };
  const input = inputs[0]!;
  if (!input.owner.eq(tx.senderId)) return { code: "WRONG_OWNER", message: "Input note belongs to a different identity." };
  if (!input.assetId.eq(tx.assetId)) return { code: "ASSET_MISMATCH", message: "Input note asset does not match transaction." };
  if (!input.nonce.eq(noteNonce(input.commitment, input.blinding)) || !input.nonce.eq(tx.nonce)) {
    return { code: "NOTE_NONCE", message: "Transaction nonce is not bound to the consumed note." };
  }
  if (input.amount < tx.amount + tx.fee) return { code: "AMOUNT_MISMATCH", message: "Transaction amount plus fee exceeds the value of the input note." };
  const change = input.amount - tx.amount - tx.fee;
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

export class UepLedger {
  /** Optional security policy gate (TESTNET). */
  policy: SecurityPolicyType = new SecurityPolicy();
  /** When true, submit must include secrets (MAC) or a verifiable zkProof. */
  /** Public alpha requires sender authentication for every spend. */
  requireProof = true;
  readonly networkId: string;
  readonly domainId: string;
  readonly connected: boolean;
  readonly allowFaucet: boolean;
  private readonly snapshotAuthoritySecret: Buffer;
  state: SparseMerkleTree;
  nullifiers: NullifierSet;
  balances = new Map<AccountKey, bigint>();
  notes: Note[] = [];
  txs: UepTransaction[] = [];
  pending: UepTransaction[] = [];
  noteCounter = 0n;
  lastReconcileAt = 0;
  /** Total minted (faucet) value per asset (asset hex -> amount). */
  supply = new Map<string, bigint>();

  constructor(opts: {
    networkId: string;
    domainId: string;
    connected: boolean;
    allowFaucet: boolean;
    /** External snapshot authority secret. Keep outside the snapshot. */
    snapshotAuthoritySecret?: string | Uint8Array;
  }) {
    this.networkId = opts.networkId;
    this.domainId = opts.domainId;
    this.connected = opts.connected;
    this.allowFaucet = opts.allowFaucet;
    this.snapshotAuthoritySecret = Buffer.from(opts.snapshotAuthoritySecret ?? randomBytes(32));
    this.state = new SparseMerkleTree(ACCOUNT_DEPTH);
    this.nullifiers = new NullifierSet();
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

  notesOf(account: Fr, unspentOnly = true): Note[] {
    return this.notes.filter((n) => n.owner.eq(account) && (!unspentOnly || !n.spent));
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

  faucet(account: Fr, assetIdStr: string, amount: bigint): Note {
    if (!this.allowFaucet) throw new Error("Faucet is TESTNET-only");
    if (!this.connected) throw new Error("Node is not connected");
    const rec = findAsset(this.networkId, assetIdStr);
    if (!rec) throw new Error("Unknown TESTNET asset");
    const assetId = encodeStringToFr(assetIdStr);
    const blinding = hLeaf(account, new Fr(++this.noteCounter));
    const note = makeNote(account, assetId, amount, blinding);
    this.notes.push(note);
    this.setBalance(account, assetId, this.balanceOf(account, assetId) + amount);
    this.supply.set(assetId.toHex(), (this.supply.get(assetId.toHex()) ?? 0n) + amount);
    return note;
  }

  /**
   * Build a spend from the caller's secrets. Selects FIFO notes.
   */
  prepareSpend(
    secrets: IdentitySecrets,
    recipient: Fr,
    assetIdStr: string,
    amount: bigint,
    now = Date.now(),
  ): SubmitResult {
    if (amount <= 0n) return { error: { code: "AMOUNT_MISMATCH", message: "Amount must be greater than zero." } };
    if (!this.connected) {
      return {
        error: {
          code: "NOT_CONNECTED",
          message: "No live network endpoint configured.",
        },
      };
    }
    {
      const feeGuess = creatorFee(amount);
      const verdict = this.policy.check(
        {
          accountHex: secrets.accountId.toHex(),
          assetId: assetIdStr,
          amount,
          fee: feeGuess,
          nowMs: now,
        },
        false,
      );
      if (!verdict.ok) {
        return { error: { code: "POLICY", message: `${verdict.code}: ${verdict.message}` } };
      }
    }
    const assetId = encodeStringToFr(assetIdStr);
    const senderId = secrets.accountId;
    if (!verifyOwnership(secrets.secret, secrets.salt, senderId)) {
      return { error: { code: "WRONG_OWNER", message: "Identity does not control this account." } };
    }
    if (recipient.eq(senderId) || recipient.eq(TREASURY_ID) || senderId.eq(TREASURY_ID)) {
      return { error: { code: "INVALID_PARTICIPANTS", message: "Sender, recipient and treasury must be distinct accounts." } };
    }
    const fee = creatorFee(amount);
    const required = amount + fee;
    const available = this.notesOf(senderId).filter((n) => n.assetId.eq(assetId) && openNote(n));
    // v0.4 public testnet deliberately uses one input note per transaction.
    // This keeps the single-nullifier transaction format sound; multi-input
    // aggregation requires an explicit nullifier vector in a future protocol version.
    const spent = available.find((n) => n.amount >= required);
    if (!spent) {
      return { error: { code: "INSUFFICIENT", message: "No single unspent note covers amount plus fee." } };
    }
    const selected: Note[] = [spent];
    const total = spent.amount;
    const debit = requiredSenderDebit(amount);
    const senderOld = this.balanceOf(senderId, assetId);
    const recipientOld = this.balanceOf(recipient, assetId);
    const treasuryOld = this.balanceOf(TREASURY_ID, assetId);
    const tr = transition(
      { sender: senderOld, recipient: recipientOld, treasury: treasuryOld },
      amount,
    );
    if ("err" in tr) {
      return { error: { code: "INSUFFICIENT", message: tr.err } };
    }

    const change = total - amount - fee;
    // Single-note spend: consume the selected note, emit the recipient output
    // (`amount`) plus optional change (`total - amount - fee`). The nullifier is
    // derived from that note (single-nullifier transition, matching UEP-25).
    const nonce = spent.nonce;
    const nullifier = deriveNullifier(secrets.secret, nonce);
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
    const spendProof = DevelopmentSpendProofProvider.prove(pub, {
      senderSecret: secrets.secret,
      senderSalt: secrets.salt,
      nonce,
    });

    const tx: UepTransaction = {
      version: 1,
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
      phase: "LOCAL_VALID",
      inConflict: false,
      createdAt: now,
    };

    // Stash outputs on the tx object via a side table
    this.stashOutputs(tx.txId.toHex(), outputs, selected, debit, tr.ok.new);
    return { tx };
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

  submit(tx: UepTransaction, secrets?: IdentitySecrets): SubmitResult {

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
      this.pending.push(tx);
      return {
        error: {
          code: "NOT_CONNECTED",
          message: "No live network endpoint configured.",
        },
      };
    }
    const policyVerdict = this.policy.check(
      {
        accountHex: tx.senderId.toHex(),
        assetId: [...assetsForNetwork(this.networkId)].find((a) => encodeStringToFr(a.assetId).eq(tx.assetId))?.assetId ?? "unknown",
        amount: tx.amount,
        fee: tx.fee,
        nowMs: Date.now(),
      },
      false,
    );
    if (!policyVerdict.ok) {
      return { error: { code: "POLICY", message: `${policyVerdict.code}: ${policyVerdict.message}` } };
    }
    if (this.txs.some((t) => t.txId.eq(tx.txId))) {
      return { error: { code: "REPLAY", message: "Transaction already present (idempotent reject)." } };
    }
    if (this.nullifiers.contains(tx.nullifier)) {
      return { error: { code: "DOUBLE_SPEND", message: "Nullifier already spent." } };
    }

    const recomputed = computeTxCommitment({
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
    });
    if (!recomputed.eq(tx.transactionCommitment)) {
      return { error: { code: "AMOUNT_MISMATCH", message: "Transaction commitment does not match fields." } };
    }
    const expectId = txIdFromCommitment(tx.transactionCommitment, tx.nullifier);
    if (!expectId.eq(tx.txId)) {
      return { error: { code: "AMOUNT_MISMATCH", message: "TxID does not match canonical commitment." } };
    }
    if (tx.fee !== creatorFee(tx.amount)) {
      return { error: { code: "AMOUNT_MISMATCH", message: "Fee does not match protocol policy." } };
    }
    if (!assetsForNetwork(this.networkId).some((a) => encodeStringToFr(a.assetId).eq(tx.assetId))) {
      return { error: { code: "ASSET_MISMATCH", message: "Asset is not registered on this network." } };
    }

    if (secrets) {
      if (!verifyOwnership(secrets.secret, secrets.salt, tx.senderId)) {
        return { error: { code: "WRONG_OWNER", message: "Spender is not the note owner." } };
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
          message: "Proof required: provide the sender identity (development MAC).",
        },
      };
    }

    const transportedInputs = tx.inputNotes?.map(deserializeNote) ?? [];
    if (transportedInputs.length !== tx.inputCommitments.length) {
      return { error: { code: "NOTE_OPENING", message: "Every input commitment must carry its note opening." } };
    }
    // Transported notes are evidence, not authority. The authoritative ledger
    // must already contain the exact unspent commitment. A sender cannot mint a
    // new balance merely by attaching a self-consistent note to a transaction.
    const inputs: Note[] = [];
    for (let i = 0; i < tx.inputCommitments.length; i++) {
      const transported = transportedInputs[i]!;
      const canonical = this.notes.find((n) => n.commitment.eq(tx.inputCommitments[i]!));
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
    if (tx.inputCommitments.length !== 1 || uniqueInputs.size !== tx.inputCommitments.length || inputs.length !== tx.inputCommitments.length) {
      return { error: { code: "AMOUNT_MISMATCH", message: "Input commitments must be unique and exactly match the referenced notes." } };
    }
    const outputs = tx.outputNotes?.map(deserializeNote) ?? [];
    if (outputs.length !== tx.outputCommitments.length || outputs.some((n, i) => !openNote(n) || !n.commitment.eq(tx.outputCommitments[i]!))) {
      return { error: { code: "AMOUNT_MISMATCH", message: "Output notes do not match transaction commitments." } };
    }
    // Bind input and outputs to sender / recipient / amount / change (UEP-B03)
    // and the transaction nonce to the consumed note (UEP-C01).
    const shapeError = checkSpendShape(tx, inputs, outputs);
    if (shapeError) return { error: shapeError };
    for (const n of inputs) {
      // Amount/asset bind: recomputing commitment with a mutated amount must fail.
      const mutated = noteCommitment(n.owner, n.assetId, n.amount + 1n, n.blinding);
      if (mutated.eq(n.commitment)) {
        return { error: { code: "AMOUNT_MISMATCH", message: "Commitment is not binding." } };
      }
    }

    const senderOld = this.balanceOf(tx.senderId, tx.assetId);
    const recipientOld = this.balanceOf(tx.recipientId, tx.assetId);
    const treasuryOld = this.balanceOf(TREASURY_ID, tx.assetId);
    const tr = transition(
      { sender: senderOld, recipient: recipientOld, treasury: treasuryOld },
      tx.amount,
    );
    if ("err" in tr) {
      return { error: { code: "INSUFFICIENT", message: tr.err } };
    }

    const inserted = this.nullifiers.insertOnce(tx.nullifier);
    if (!inserted) {
      return { error: { code: "DOUBLE_SPEND", message: "Nullifier already in the set." } };
    }

    this.setBalance(tx.senderId, tx.assetId, tr.ok.new.sender);
    this.setBalance(tx.recipientId, tx.assetId, tr.ok.new.recipient);
    this.setBalance(TREASURY_ID, tx.assetId, tr.ok.new.treasury);

    // `inputs` are the canonical ledger notes resolved above.
    for (const n of inputs) n.spent = true;
    for (const o of outputs) {
      if (!this.notes.some((n) => n.commitment.eq(o.commitment))) this.notes.push(o);
    }

    const accepted: UepTransaction = { ...tx, phase: "LOCAL_FINAL", inConflict: false };
    this.txs.push(accepted);
    this.outputStash.delete(tx.txId.toHex());
    this.policy.check(
      {
        accountHex: tx.senderId.toHex(),
        assetId: assetsForNetwork(this.networkId).find((a) => encodeStringToFr(a.assetId).eq(tx.assetId))?.assetId ?? "unknown",
        amount: tx.amount,
        fee: tx.fee,
        nowMs: Date.now(),
      },
      true,
    );
    return { tx: accepted };
  }

  /**
   * Queue a conflicting spend of the same notes (developer / adversarial).
   * Used to exercise UEP-009. reconcilePending() validates queued spends but never
   * applies or settles them; see reconcilePending().
   */
  queueConflict(tx: UepTransaction): void {
    this.pending.push(tx);
  }

  private validatePending(tx: UepTransaction): SubmitResult {
    // Pending reconciliation must never promote an unchecked envelope.
    // Validate canonical fields and note commitments without mutating live state.
    if (tx.networkId !== this.networkId || tx.domainId !== this.domainId || tx.amount <= 0n) return { error: { code: "POLICY", message: "Pending transaction envelope invalid." } };
    if (tx.fee !== creatorFee(tx.amount)) return { error: { code: "AMOUNT_MISMATCH", message: "Pending fee invalid." } };
    const recomputed = computeTxCommitment({ networkId: tx.networkId, domainId: tx.domainId, senderId: tx.senderId, recipientId: tx.recipientId, assetId: tx.assetId, amount: tx.amount, fee: tx.fee, nonce: tx.nonce, nullifier: tx.nullifier, inputCommitments: tx.inputCommitments, outputCommitments: tx.outputCommitments });
    if (!recomputed.eq(tx.transactionCommitment) || !txIdFromCommitment(tx.transactionCommitment, tx.nullifier).eq(tx.txId)) return { error: { code: "AMOUNT_MISMATCH", message: "Pending transaction commitment invalid." } };
    if (this.nullifiers.contains(tx.nullifier) || this.txs.some((x) => x.txId.eq(tx.txId))) return { error: { code: "REPLAY", message: "Pending transaction already committed." } };
    const ins = tx.inputNotes?.map(deserializeNote) ?? [];
    const outs = tx.outputNotes?.map(deserializeNote) ?? [];
    if (ins.length !== tx.inputCommitments.length || outs.length !== tx.outputCommitments.length) return { error: { code: "NOTE_OPENING", message: "Pending transaction notes are missing." } };
    if (ins.some((n, i) => !openNote(n) || !n.commitment.eq(tx.inputCommitments[i]!)) || outs.some((n, i) => !openNote(n) || !n.commitment.eq(tx.outputCommitments[i]!))) return { error: { code: "NOTE_OPENING", message: "Pending note commitment mismatch." } };
    // Same input/output binding rules as submit().
    const shapeError = checkSpendShape(tx, ins, outs);
    if (shapeError) return { error: shapeError };
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
    // Pending transactions cannot be applied here: the development MAC can only be
    // verified with the sender's secret, so reconciliation has no way to authenticate
    // a pending spend. Therefore:
    //   - invalid envelopes (bad commitment, notes, fee, value, or an already
    //     committed nullifier) are rejected and removed from the queue;
    //   - structurally valid ones STAY queued in phase LOCAL_VALID (never SETTLED
    //     without a state transition), flagged `inConflict` when several queued
    //     spends share a nullifier. They must be applied through submit().
    const committedNullifiers = new Set(this.txs.map((t) => t.nullifier.toHex()));
    const rejected: Array<{ txId: string; code: SubmitError["code"]; message: string }> = [];
    const validCandidates: UepTransaction[] = [];
    for (const candidate of this.pending) {
      if (committedNullifiers.has(candidate.nullifier.toHex())) {
        rejected.push({ txId: candidate.txId.toHex(), code: "REPLAY", message: "Nullifier already committed locally." });
        continue;
      }
      const check = this.validatePending(candidate);
      if ("tx" in check) validCandidates.push(candidate);
      else rejected.push({ txId: candidate.txId.toHex(), code: check.error.code, message: check.error.message });
    }
    const queued = markConflicts(validCandidates).map((t) => ({ ...t, phase: "LOCAL_VALID" as const }));
    this.pending = queued;
    this.lastReconcileAt = Date.now();
    const settlements: ReturnType<typeof reconcile> = [];
    return { settlements, root: settlementRoot(settlements), queued: queued.map((t) => ({ ...t })), rejected };
  }

  snapshot() {
    const payload = {
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      networkId: this.networkId,
      domainId: this.domainId,
      connected: this.connected,
      allowFaucet: this.allowFaucet,
      policy: { ...this.policy.config, blockedAccounts: [...this.policy.config.blockedAccounts], assetTier: { ...this.policy.config.assetTier } },
      state: this.state.toJSON(),
      nullifiers: this.nullifiers.toJSON(),
      balances: [...this.balances.entries()].map(([k, v]) => [k, v.toString()] as const),
      supply: [...this.supply.entries()].map(([k, v]) => [k, v.toString()] as const),
      notes: this.notes.map(serializeNote),
      txs: this.txs.map(serializeTx),
      pending: this.pending.map(serializeTx),
      noteCounter: this.noteCounter.toString(),
      lastReconcileAt: this.lastReconcileAt,
    };
    const integrity = signSnapshotPayload(payload, this.snapshotAuthoritySecret);
    return { ...payload, integrity };
  }

  /**
   * Restore a snapshot. The integrity tag is verified first (constant-time),
   * then the full state is re-derived and every invariant is checked. A
   * snapshot is accepted only if it could have been produced by faucet() and
   * submit() under the same rules submit() enforces. Errors are specific
   * `INVALID_SNAPSHOT_*` codes.
   */
  static restore(data: UepLedgerSnapshot, snapshotAuthoritySecret: string | Uint8Array): UepLedger {
    const fail = (code: string): never => { throw new Error(`INVALID_SNAPSHOT_${code}`); };
    if (!data || data.networkId == null || data.domainId == null || !data.state || !data.nullifiers || !Array.isArray(data.nullifiers.seen) || !Array.isArray(data.balances) || !Array.isArray(data.notes) || !Array.isArray(data.txs) || !Array.isArray(data.pending) || !data.policy || typeof data.integrity !== "string") fail("SHAPE");
    if (data.formatVersion !== SNAPSHOT_FORMAT_VERSION || !Array.isArray(data.supply)) fail("VERSION");
    const { integrity, ...payload } = data;
    const expected = Buffer.from(signSnapshotPayload(payload, snapshotAuthoritySecret), "hex");
    const given = /^[0-9a-f]{64}$/.test(integrity) ? Buffer.from(integrity, "hex") : Buffer.alloc(0);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) fail("INTEGRITY");

    const l = new UepLedger({
      networkId: data.networkId,
      domainId: data.domainId,
      connected: data.connected,
      allowFaucet: data.allowFaucet,
      snapshotAuthoritySecret,
    });
    l.state = SparseMerkleTree.fromJSON(data.state);
    l.balances = new Map(data.balances.map(([k, v]) => [k, BigInt(v)]));
    l.supply = new Map(data.supply.map(([k, v]) => [k, BigInt(v)]));
    l.notes = data.notes.map(deserializeNote);
    l.txs = data.txs.map(deserializeTx);
    l.pending = data.pending.map(deserializeTx);
    l.noteCounter = BigInt(data.noteCounter);
    l.lastReconcileAt = data.lastReconcileAt;
    const p = data.policy as any;
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
      noteByCommitment.set(n.commitment.toHex(), n);
    }

    // 3. Transactions replay in order under submit()'s rules.
    const registeredAssets = assetsForNetwork(l.networkId).map((a) => encodeStringToFr(a.assetId));
    const outputCommitments = new Set<string>();
    for (const tx of l.txs) for (const c of tx.outputCommitments) outputCommitments.add(c.toHex());
    // Notes that are not the output of any transaction are faucet mints.
    const available = new Set<string>([...noteByCommitment.keys()].filter((c) => !outputCommitments.has(c)));
    const consumed = new Set<string>();
    const txIds = new Set<string>();
    const feesByAsset = new Map<string, bigint>();
    const rebuiltNullifiers = new NullifierSet();
    for (const tx of l.txs) {
      if (tx.networkId !== l.networkId || tx.domainId !== l.domainId) fail("TX_NETWORK");
      if (txIds.has(tx.txId.toHex())) fail("TX_DUPLICATE");
      txIds.add(tx.txId.toHex());
      if (!rebuiltNullifiers.insertOnce(tx.nullifier)) fail("NULLIFIER_SET");
      if (tx.amount <= 0n || tx.fee !== creatorFee(tx.amount)) fail("TX_VALUE");
      if (!registeredAssets.some((a) => a.eq(tx.assetId))) fail("TX_ASSET");
      if (!tx.inputNotes || !tx.outputNotes || tx.inputNotes.length !== tx.inputCommitments.length || tx.outputNotes.length !== tx.outputCommitments.length) fail("TX_NOTES");
      const recomputed = computeTxCommitment({ networkId: tx.networkId, domainId: tx.domainId, senderId: tx.senderId, recipientId: tx.recipientId, assetId: tx.assetId, amount: tx.amount, fee: tx.fee, nonce: tx.nonce, nullifier: tx.nullifier, inputCommitments: tx.inputCommitments, outputCommitments: tx.outputCommitments });
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
      feesByAsset.set(tx.assetId.toHex(), (feesByAsset.get(tx.assetId.toHex()) ?? 0n) + tx.fee);
    }

    // 4. Nullifier tree and seen set equal exactly the committed nullifiers.
    if (!rebuiltNullifiers.root().eq(new NullifierSet(SparseMerkleTree.fromJSON(data.nullifiers.tree)).root())) fail("NULLIFIER_ROOT");
    const seen = new Set(data.nullifiers.seen);
    if (seen.size !== data.nullifiers.seen.length || seen.size !== l.txs.length || l.txs.some((t) => !seen.has(t.nullifier.toHex()))) fail("NULLIFIER_SEEN");
    l.nullifiers = rebuiltNullifiers;

    // 5. A note is spent iff it was consumed by a committed transaction.
    for (const n of l.notes) if (n.spent !== consumed.has(n.commitment.toHex())) fail("SPENT_FLAG");

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

    // 7. Supply: minted notes and total balances per asset equal the recorded supply.
    const minted = new Map<string, bigint>();
    for (const n of l.notes) if (!outputCommitments.has(n.commitment.toHex())) minted.set(n.assetId.toHex(), (minted.get(n.assetId.toHex()) ?? 0n) + n.amount);
    const totals = new Map<string, bigint>();
    for (const [k, v] of l.balances) { const assetHex = k.split("|")[1]!; totals.set(assetHex, (totals.get(assetHex) ?? 0n) + v); }
    for (const assetHex of new Set([...minted.keys(), ...totals.keys(), ...l.supply.keys()])) {
      const supply = l.supply.get(assetHex) ?? 0n;
      if ((minted.get(assetHex) ?? 0n) !== supply || (totals.get(assetHex) ?? 0n) !== supply) fail("SUPPLY");
    }
    return l;
  }
}
