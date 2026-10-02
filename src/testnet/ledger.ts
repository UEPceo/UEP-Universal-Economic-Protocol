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
import { deserializeNote, makeNote, noteCommitment, openNote, serializeNote, type Note } from "../core/note.ts";
import { computeTxCommitment, deserializeTx, serializeTx, txIdFromCommitment, verifyOwnership, type UepTransaction } from "../core/transaction.ts";
import { encodeStringToFr, u64ToFr } from "../core/encoding.ts";
import { transition } from "../core/transition.ts";
import { TREASURY_ID } from "../network/profiles.ts";
import { SecurityPolicy, type SecurityPolicy as SecurityPolicyType, type RiskTier } from "../core/security-policy.ts";
import { DevelopmentSpendProofProvider, verifyDevelopmentMac, type SpendPublicInputs } from "../core/spend-proof.ts";
import type { IdentitySecrets } from "../identity/kdf.ts";

export type SubmitError =
  | { code: "WRONG_NETWORK"; message: string }
  | { code: "WRONG_OWNER"; message: string }
  | { code: "NOTE_OPENING"; message: string }
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
  state: SparseMerkleTree;
  nullifiers: NullifierSet;
  balances = new Map<AccountKey, bigint>();
  notes: Note[] = [];
  txs: UepTransaction[] = [];
  pending: UepTransaction[] = [];
  noteCounter = 0n;
  lastReconcileAt = 0;

  constructor(opts: {
    networkId: string;
    domainId: string;
    connected: boolean;
    allowFaucet: boolean;
  }) {
    this.networkId = opts.networkId;
    this.domainId = opts.domainId;
    this.connected = opts.connected;
    this.allowFaucet = opts.allowFaucet;
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
    const available = this.notesOf(senderId).filter((n) => n.assetId.eq(assetId) && openNote(n));
    let selected: Note[] = [];
    let total = 0n;
    for (const n of available) {
      selected.push(n);
      total += n.amount;
      if (total >= amount) break;
    }
    if (total < amount) {
      return { error: { code: "INSUFFICIENT", message: "Not enough unspent notes for this asset." } };
    }
    const fee = creatorFee(amount);
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
    const spent = selected[0]!;
    // One-note spend of `amount` from the first covering set: consume selected,
    // emit recipient output + optional change. Nullifier from the first note
    // (v0.1 single-nullifier transition, matching UEP-25). Remaining selected
    // notes are also marked spent and folded into change.
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

    const stash = this.outputStash.get(tx.txId.toHex());
    const transportedInputs = tx.inputNotes?.map(deserializeNote) ?? [];
    const inputs = stash?.inputs ?? (transportedInputs.length ? transportedInputs : this.notes.filter((n) => tx.inputCommitments.some((c) => c.eq(n.commitment))));
    if (inputs.length === 0) {
      return { error: { code: "NOTE_OPENING", message: "Input notes are not in this ledger." } };
    }
    const uniqueInputs = new Set(tx.inputCommitments.map((c) => c.toHex()));
    if (uniqueInputs.size !== tx.inputCommitments.length || inputs.length !== tx.inputCommitments.length) {
      return { error: { code: "AMOUNT_MISMATCH", message: "Input commitments must be unique and exactly match the referenced notes." } };
    }
    const inputTotal = inputs.reduce((sum, n) => sum + n.amount, 0n);
    const outputs = tx.outputNotes?.map(deserializeNote) ?? stash?.outputs ?? [];
    if (outputs.length !== tx.outputCommitments.length || outputs.some((n, i) => !openNote(n) || !n.commitment.eq(tx.outputCommitments[i]!))) {
      return { error: { code: "AMOUNT_MISMATCH", message: "Output notes do not match transaction commitments." } };
    }
    const outputTotal = outputs.reduce((sum, n) => sum + n.amount, 0n);
    if (outputTotal !== inputTotal - tx.fee || outputTotal !== tx.amount + (inputTotal - tx.amount - tx.fee)) {
      return { error: { code: "AMOUNT_MISMATCH", message: "Output notes do not conserve input value after fee." } };
    }
    const requiredInputValue = tx.amount + tx.fee;
    if (inputTotal < requiredInputValue) {
      return { error: { code: "AMOUNT_MISMATCH", message: "Transaction amount plus fee exceeds the value of the input notes." } };
    }
    for (const n of inputs) {
      if (n.spent) return { error: { code: "DOUBLE_SPEND", message: "Input note already spent." } };
      if (!n.owner.eq(tx.senderId)) {
        return { error: { code: "WRONG_OWNER", message: "Input note belongs to a different identity." } };
      }
      if (!n.assetId.eq(tx.assetId)) {
        return { error: { code: "ASSET_MISMATCH", message: "Input note asset does not match transaction." } };
      }
      if (!openNote(n)) {
        return { error: { code: "NOTE_OPENING", message: "Note opening failed (commitment mismatch)." } };
      }
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

    for (const n of inputs) {
      const local = this.notes.find((x) => x.commitment.eq(n.commitment));
      if (local) local.spent = true;
      else this.notes.push({ ...n, spent: true });
    }
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
    const inputTotal = ins.reduce((a, n) => a + n.amount, 0n);
    const outputTotal = outs.reduce((a, n) => a + n.amount, 0n);
    if (outputTotal !== inputTotal - tx.fee || inputTotal < tx.amount + tx.fee) return { error: { code: "AMOUNT_MISMATCH", message: "Pending transaction does not conserve value." } };
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
    return {
      networkId: this.networkId,
      domainId: this.domainId,
      connected: this.connected,
      allowFaucet: this.allowFaucet,
      policy: { ...this.policy.config, blockedAccounts: [...this.policy.config.blockedAccounts], assetTier: { ...this.policy.config.assetTier } },
      state: this.state.toJSON(),
      nullifiers: this.nullifiers.toJSON(),
      balances: [...this.balances.entries()].map(([k, v]) => [k, v.toString()] as const),
      notes: this.notes.map(serializeNote),
      txs: this.txs.map(serializeTx),
      pending: this.pending.map(serializeTx),
      noteCounter: this.noteCounter.toString(),
      lastReconcileAt: this.lastReconcileAt,
    };
  }

  static restore(data: ReturnType<UepLedger["snapshot"]>): UepLedger {
    if (!data || data.networkId == null || data.domainId == null || !data.state || !data.nullifiers || !Array.isArray(data.balances) || !Array.isArray(data.notes) || !Array.isArray(data.txs) || !Array.isArray(data.pending)) throw new Error("INVALID_SNAPSHOT_SHAPE");
    const l = new UepLedger({
      networkId: data.networkId,
      domainId: data.domainId,
      connected: data.connected,
      allowFaucet: data.allowFaucet,
    });
    l.state = SparseMerkleTree.fromJSON(data.state);
    l.nullifiers = NullifierSet.fromJSON(data.nullifiers);
    l.balances = new Map(data.balances.map(([k, v]) => [k, BigInt(v)]));
    l.notes = data.notes.map(deserializeNote);
    l.txs = data.txs.map(deserializeTx);
    l.pending = data.pending.map(deserializeTx);
    l.noteCounter = BigInt(data.noteCounter);
    l.lastReconcileAt = data.lastReconcileAt;
    const p = data.policy as any;
    if (p) l.policy = new SecurityPolicy({ ...p, blockedAccounts: new Set(p.blockedAccounts ?? []), assetTier: { ...(p.assetTier ?? {}) } });
    const rebuiltState = new SparseMerkleTree(ACCOUNT_DEPTH);
    for (const [key, value] of l.balances) {
      const [accountHex, assetHex] = key.split("|");
      if (!accountHex || !assetHex) throw new Error("INVALID_SNAPSHOT_BALANCE_KEY");
      const account = new Fr(accountHex); const asset = new Fr(assetHex);
      rebuiltState.set(hAccount(account, asset), l.leafFor(account, asset, value));
    }
    if (!rebuiltState.root().eq(l.state.root())) throw new Error("INVALID_SNAPSHOT_STATE_ROOT");
    for (const n of l.notes) { if (!openNote(n)) throw new Error("INVALID_SNAPSHOT_NOTE_COMMITMENT"); }
    const rebuiltNullifiers = new NullifierSet();
    for (const tx of l.txs) {
      if (!rebuiltNullifiers.insertOnce(tx.nullifier)) throw new Error("INVALID_SNAPSHOT_NULLIFIER_SET");
      if (!tx.inputNotes || !tx.outputNotes) throw new Error("INVALID_SNAPSHOT_TX_NOTES");
    }
    if (!rebuiltNullifiers.root().eq(l.nullifiers.root())) throw new Error("INVALID_SNAPSHOT_NULLIFIER_ROOT");
    const calculatedBalances = new Map<string,bigint>();
    for (const [k,v] of l.balances) calculatedBalances.set(k,v);
    if (l.notes.some(n => !n.spent && (calculatedBalances.get(ak(n.owner,n.assetId)) ?? 0n) < n.amount)) throw new Error("INVALID_SNAPSHOT_NOTE_BALANCE");
    return l;
  }
}


