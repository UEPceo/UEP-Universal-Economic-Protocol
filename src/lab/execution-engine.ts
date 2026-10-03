/**
 * UEP-30.1 Canonical Execution Engine
 *
 * - Real recipient_id / treasury balances in the prove request
 * - Persistent leaf map + nullifier set (lab-side canonical state)
 * - expected_old_state_root chaining (STALE_ROOT on mismatch)
 * - transitionId = SHA-256 of 12 public input hexes (not proof bytes)
 * - oneInFlightPerSender for ZK
 *
 * Does not change SpendCircuit / Poseidon params / fee.
 */

import { zkVerifyPinned } from "./zk-vk-pins.ts";
import { Fr } from "../core/field.ts";
import { creatorFee } from "../core/fee.ts";
import { findUepZkBinary, zkProveSpendJson, zkNoteCommit, zkStateIndex, zkHAccount } from "./zk-bridge.ts";
import { buildPoseidonSpendRequest } from "./poseidon-spend-request.ts";
import { normalizeFrHex } from "./zk-public-inputs.ts";
import { transitionIdFromPublics } from "./poseidon-ledger-lab.ts";
import {
  partitionIntoWaves,
  scheduleStats,
  DEFAULT_CONFLICT_MODE,
  type ConflictMode,
  type PendingJob,
} from "./conflict-scheduler.ts";

export type EngineConfig = {
  depth: 4 | 32;
  profile: "dev" | "local" | "testnet";
  requireProof: boolean;
  proveConcurrency: number;
  seedBase?: number;
  oneInFlightPerSender?: boolean;
  /** UEP-30.2 conflict rules for wave scheduling. */
  conflictMode?: ConflictMode;
  /** Active domain_code (ADDR-002); payments must match when set. */
  domainCode?: number;
};

export type AccountState = {
  /** Stable field element used as recipient_id / identity in circuit. */
  id: Fr;
  secret: Fr;
  salt: Fr;
  blinding: Fr;
  balance: bigint;
  reserved: bigint;
};

export type SpendIntent = {
  id: string;
  from: string;
  to: string;
  amount: bigint;
};

export type ProvedJob = {
  intent: SpendIntent;
  fee: bigint;
  transitionId: string;
  nullifier: string;
  publicInputsHex: string[];
  oldStateRoot: string;
  newStateRoot: string;
  oldNullifierRoot: string;
  newNullifierRoot: string;
  leafUpdates: {
    senderIndex: number;
    senderNew: string;
    recipientIndex: number;
    recipientNew: string;
    treasuryIndex: number;
    treasuryNew: string;
    nullifierIndex: number;
    nullifier: string;
  };
  vkHex?: string;
  proofHex?: string;
  vkId?: string;
  setupMs?: number;
  proveMs?: number;
  verifyMs?: number;
  intakeSeq: number;
};

export type CommitResult = {
  ok: boolean;
  intentId: string;
  transitionId?: string;
  error?: string;
  newStateRoot?: string;
  commitMs?: number;
};

export type EngineStats = {
  enqueued: number;
  proved: number;
  committed: number;
  rejected: number;
  proveWallMs: number;
  commitWallMs: number;
};

function available(a: AccountState): bigint {
  return a.balance - a.reserved;
}

function oneInFlightPolicy(config: EngineConfig): boolean {
  if (config.oneInFlightPerSender !== undefined) return config.oneInFlightPerSender;
  return config.requireProof;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export class ExecutionEngine {
  readonly config: EngineConfig;
  private accounts = new Map<string, AccountState>();
  /** index → leaf hex (canonical state leaves known to the engine) */
  private stateLeaves = new Map<number, string>();
  private nullifiers = new Set<string>();
  private transitionIds = new Set<string>();
  /** Paid invoice keys (orderId or mac) — anti replay of payment requests. */
  private consumedPaymentKeys = new Set<string>();
  private intakeSeq = 0;
  private pending: Array<{ intent: SpendIntent; fee: bigint; seq: number }> = [];
  /** Canonical roots after last commit (null = empty genesis). */
  stateRoot: string | null = null;
  nullifierRoot: string | null = null;
  treasuryBalance = 0n;
  treasuryId = Fr.from(44n);
  assetId = Fr.from(1n);
  stats: EngineStats = {
    enqueued: 0,
    proved: 0,
    committed: 0,
    rejected: 0,
    proveWallMs: 0,
    commitWallMs: 0,
  };

  constructor(config: EngineConfig) {
    this.config = config;
  }

  registerAccount(label: string, acc: Omit<AccountState, "reserved" | "id"> & { id?: Fr }): void {
    this.accounts.set(label, {
      id: acc.id ?? acc.secret, // lab default: secret as stable id stand-in
      secret: acc.secret,
      salt: acc.salt,
      blinding: acc.blinding,
      balance: acc.balance,
      reserved: 0n,
    });
  }

  getAccount(label: string): AccountState {
    const a = this.accounts.get(label);
    if (!a) throw new Error(`unknown account ${label}`);
    return a;
  }

  listAccountLabels(): string[] {
    return [...this.accounts.keys()];
  }

  findAccountLabelById(id: Fr): string | null {
    const target = id.toHex();
    for (const [label, acc] of this.accounts) {
      if (acc.id.toHex() === target) return label;
    }
    return null;
  }


  getIntakeSeq(): number {
    return this.intakeSeq;
  }

  setIntakeSeq(n: number): void {
    this.intakeSeq = n;
  }

  exportStateLeaves(): Array<[number, string]> {
    return [...this.stateLeaves.entries()];
  }

  importStateLeaves(leaves: Array<[number, string]>): void {
    this.stateLeaves.clear();
    for (const [i, h] of leaves) this.stateLeaves.set(i, h);
  }

  exportNullifiers(): string[] {
    return [...this.nullifiers];
  }

  importNullifiers(nfs: string[]): void {
    this.nullifiers.clear();
    for (const n of nfs) this.nullifiers.add(n);
  }

  exportTransitionIds(): string[] {
    return [...this.transitionIds];
  }

  exportConsumedPaymentKeys(): string[] {
    return [...this.consumedPaymentKeys];
  }

  importConsumedPaymentKeys(keys: string[]): void {
    this.consumedPaymentKeys.clear();
    for (const k of keys) this.consumedPaymentKeys.add(k);
  }

  isPaymentKeyConsumed(key: string): boolean {
    return this.consumedPaymentKeys.has(key);
  }

  markPaymentKeyConsumed(key: string): void {
    this.consumedPaymentKeys.add(key);
  }


  importTransitionIds(ids: string[]): void {
    this.transitionIds.clear();
    for (const id of ids) this.transitionIds.add(id);
  }

  exportPending(): Array<{ intent: SpendIntent; fee: bigint; seq: number }> {
    return this.pending.map((p) => ({ ...p, intent: { ...p.intent } }));
  }

  importPending(jobs: Array<{ intent: SpendIntent; fee: bigint; seq: number }>): void {
    this.pending = jobs.map((p) => ({
      intent: { ...p.intent },
      fee: p.fee,
      seq: p.seq,
    }));
  }


  totalBalances(): bigint {
    let s = this.treasuryBalance;
    for (const a of this.accounts.values()) s += a.balance;
    return s;
  }


  /**
   * Insert 0-balance Poseidon note leaves for all registered accounts + treasury
   * so the SMT matches the circuit model (0-balance note ≠ empty leaf).
   * Call after registerAccount(...), before the first ZK spend.
   */
  bootstrapZeroNotes(): void {
    if (!this.config.requireProof) return;
    if (!findUepZkBinary()) throw new Error("uep-zk required for bootstrapZeroNotes");
    const asset = this.assetId.toString();
    // State index = lowBits(H_ACCOUNT(owner, asset), D). Two different owners in
    // one slot are rejected (SMT_INDEX_COLLISION), never overwritten.
    const slotOwner = new Map<number, string>();
    const place = (owner: string, idx: number, leaf: string) => {
      const prev = slotOwner.get(idx);
      if (prev !== undefined && prev !== owner) throw new Error(`SMT_INDEX_COLLISION index=${idx}`);
      slotOwner.set(idx, owner);
      this.stateLeaves.set(idx, normalizeFrHex(leaf));
    };
    for (const [, acc] of this.accounts) {
      // Sender leaf is keyed by h_account(secret,salt); recipient leaf by id
      const senderId = zkHAccount(acc.secret.toString(), acc.salt.toString());
      // Leaf amounts must match engine balances (circuit uses note_commitment, not empty).
      const bal = acc.balance.toString();
      place(normalizeFrHex(senderId), zkStateIndex(senderId, asset, this.config.depth), zkNoteCommit(senderId, asset, bal, acc.blinding.toString()));
      const rid = acc.id.toString();
      place(normalizeFrHex(rid), zkStateIndex(rid, asset, this.config.depth), zkNoteCommit(rid, asset, bal, acc.blinding.toString()));
    }
    const tid = this.treasuryId.toString();
    place(normalizeFrHex(tid), zkStateIndex(tid, asset, this.config.depth), zkNoteCommit(tid, asset, "0", "5"));
    // Root unknown until first prove; leave stateRoot null so expected is unset until first commit
    this.stateRoot = null;
  }

  enqueue(intent: SpendIntent): { ok: true } | { ok: false; error: string } {
    const sender = this.accounts.get(intent.from);
    const recipient = this.accounts.get(intent.to);
    if (!sender || !recipient) return { ok: false, error: "unknown account" };
    if (intent.amount <= 0n) return { ok: false, error: "amount must be positive" };
    const fee = creatorFee(intent.amount);
    if (available(sender) < intent.amount + fee) {
      return { ok: false, error: "insufficient available balance" };
    }
    if (oneInFlightPolicy(this.config)) {
      if (this.pending.some((p) => p.intent.from === intent.from)) {
        return { ok: false, error: "ONE_IN_FLIGHT_PER_SENDER" };
      }
    }
    sender.reserved += intent.amount + fee;
    const seq = this.intakeSeq++;
    this.pending.push({ intent, fee, seq });
    this.stats.enqueued++;
    return { ok: true };
  }

  private releaseReservation(from: string, amount: bigint, fee: bigint): void {
    const a = this.getAccount(from);
    a.reserved -= amount + fee;
    if (a.reserved < 0n) a.reserved = 0n;
  }

  async provePending(): Promise<{
    proved: ProvedJob[];
    failed: Array<{ intentId: string; error: string }>;
  }> {
    if (this.config.requireProof && !findUepZkBinary()) {
      throw new Error("uep-zk binary required for requireProof engine");
    }
    let batch = this.pending.splice(0, this.pending.length);
    if (oneInFlightPolicy(this.config)) {
      const seen = new Set<string>();
      const take: typeof batch = [];
      const defer: typeof batch = [];
      for (const j of batch) {
        if (seen.has(j.intent.from)) defer.push(j);
        else {
          seen.add(j.intent.from);
          take.push(j);
        }
      }
      this.pending = defer.concat(this.pending);
      batch = take;
    }
    const t0 = performance.now();
    const failed: Array<{ intentId: string; error: string }> = [];
    const proved: ProvedJob[] = [];

    // Snapshot canonical state for this prove round (all workers see same committed state)
    const leafSnapshot = [...this.stateLeaves.entries()].map(
      ([idx, leaf]) => [idx, leaf] as [number, string],
    );
    const nfSnapshot = [...this.nullifiers];
    const expectedStateRoot = this.stateRoot;
    const expectedNfRoot = this.nullifierRoot;

    const outcomes = await mapPool(batch, this.config.proveConcurrency, async (job) => {
      const sender = this.getAccount(job.intent.from);
      const recipient = this.getAccount(job.intent.to);

      if (this.config.requireProof) {
        const req = buildPoseidonSpendRequest({
          depth: this.config.depth,
          seed: (this.config.seedBase ?? 42) + job.seq,
          senderSecret: sender.secret,
          senderSalt: sender.salt,
          recipientId: recipient.id, // P0 fix: real recipient
          treasuryId: this.treasuryId,
          assetId: this.assetId,
          amount: job.intent.amount,
          fee: job.fee,
          senderOldBalance: sender.balance,
          recipientOldBalance: recipient.balance,
          treasuryOldBalance: this.treasuryBalance, // P0 fix: real treasury
          noteBlinding: sender.blinding,
          recipientBlinding: recipient.blinding,
          treasuryBlinding: Fr.from(5n),
        }) as ReturnType<typeof buildPoseidonSpendRequest> & {
          network_profile?: string;
          existing_nullifiers?: string[];
          extra_state_leaves?: Array<[number, string]>;
          expected_old_state_root?: string;
          expected_old_nullifier_root?: string;
        };
        req.network_profile = this.config.profile;
        req.existing_nullifiers = nfSnapshot.map((h) =>
          h.startsWith("0x") ? h : "0x" + h,
        );
        req.extra_state_leaves = leafSnapshot.map(([i, l]) => [
          i,
          l.startsWith("0x") ? l : "0x" + l,
        ]);
        if (expectedStateRoot) {
          req.expected_old_state_root = expectedStateRoot.startsWith("0x")
            ? expectedStateRoot
            : "0x" + expectedStateRoot;
        }
        if (expectedNfRoot) {
          req.expected_old_nullifier_root = expectedNfRoot.startsWith("0x")
            ? expectedNfRoot
            : "0x" + expectedNfRoot;
        }

        const art = zkProveSpendJson(req);
        if (!art.ok || art.publicInputsHex.length !== 13) {
          this.releaseReservation(job.intent.from, job.intent.amount, job.fee);
          return {
            kind: "fail" as const,
            intentId: job.intent.id,
            error: art.error ?? "prove failed",
          };
        }
        if (!art.leaves) {
          this.releaseReservation(job.intent.from, job.intent.amount, job.fee);
          return {
            kind: "fail" as const,
            intentId: job.intent.id,
            error: "prover did not return leaf updates",
          };
        }
        const v = zkVerifyPinned(this.config.depth, 1n, art.proofHex!, art.publicInputsHex, art.vkHex);
        if (!v.ok) {
          this.releaseReservation(job.intent.from, job.intent.amount, job.fee);
          return { kind: "fail" as const, intentId: job.intent.id, error: "verify-hex failed" };
        }
        // Binding check: public recipient must match account id
        const pubRecipient = normalizeFrHex(art.publicInputsHex[5]!);
        const expectRec = normalizeFrHex(recipient.id.toHex());
        if (pubRecipient !== expectRec) {
          this.releaseReservation(job.intent.from, job.intent.amount, job.fee);
          return {
            kind: "fail" as const,
            intentId: job.intent.id,
            error: `recipient_id binding mismatch ${pubRecipient} vs ${expectRec}`,
          };
        }
        const tid = transitionIdFromPublics(art.publicInputsHex);
        this.stats.proved++;
        return {
          kind: "ok" as const,
          job: {
            intent: job.intent,
            fee: job.fee,
            transitionId: tid,
            nullifier: normalizeFrHex(art.publicInputsHex[10]!),
            publicInputsHex: art.publicInputsHex,
            oldStateRoot: normalizeFrHex(art.publicInputsHex[0]!),
            newStateRoot: normalizeFrHex(art.publicInputsHex[1]!),
            oldNullifierRoot: normalizeFrHex(art.publicInputsHex[2]!),
            newNullifierRoot: normalizeFrHex(art.publicInputsHex[3]!),
            leafUpdates: {
              senderIndex: art.leaves.senderIndex,
              senderNew: normalizeFrHex(art.leaves.senderNew),
              recipientIndex: art.leaves.recipientIndex,
              recipientNew: normalizeFrHex(art.leaves.recipientNew),
              treasuryIndex: art.leaves.treasuryIndex,
              treasuryNew: normalizeFrHex(art.leaves.treasuryNew),
              nullifierIndex: art.leaves.nullifierIndex,
              nullifier: normalizeFrHex(art.leaves.nullifier),
            },
            vkHex: art.vkHex,
            proofHex: art.proofHex,
            vkId: art.vkId,
            setupMs: art.setupMs,
            proveMs: art.proveMs,
            verifyMs: art.verifyMs,
            intakeSeq: job.seq,
          } satisfies ProvedJob,
        };
      }

      // Structural
      const tid = transitionIdFromPublics([
        String(job.seq),
        job.intent.from,
        job.intent.to,
        job.intent.amount.toString(),
      ]);
      this.stats.proved++;
      return {
        kind: "ok" as const,
        job: {
          intent: job.intent,
          fee: job.fee,
          transitionId: tid,
          nullifier: `nf-${job.seq}-${job.intent.from}`,
          publicInputsHex: [],
          oldStateRoot: this.stateRoot ?? "0",
          newStateRoot: `struct-root-${job.seq}`,
          oldNullifierRoot: this.nullifierRoot ?? "0",
          newNullifierRoot: `struct-nf-${job.seq}`,
          leafUpdates: {
            senderIndex: 0,
            senderNew: "0",
            recipientIndex: 0,
            recipientNew: "0",
            treasuryIndex: 0,
            treasuryNew: "0",
            nullifierIndex: 0,
            nullifier: `nf-${job.seq}`,
          },
          intakeSeq: job.seq,
        } satisfies ProvedJob,
      };
    });

    for (const o of outcomes) {
      if (o.kind === "fail") failed.push({ intentId: o.intentId, error: o.error });
      else proved.push(o.job);
    }
    proved.sort((a, b) => a.intakeSeq - b.intakeSeq);
    this.stats.proveWallMs += performance.now() - t0;
    return { proved, failed };
  }


  /**
   * UEP-35.3.1 — Apply a structural economic spend after external finality.
   * Uses the same balance/nullifier/transition rules as commitProved (no ZK leaf path).
   * Caller must have already accepted FinalityCertificate.
   */
  commitFinalizedStructural(input: {
    from: string;
    to: string;
    amount: bigint;
    fee: bigint;
    nullifier: string;
    transitionId: string;
    newStateRoot: string;
    newNullifierRoot?: string;
  }): CommitResult {
    const tC = performance.now();
    if (this.transitionIds.has(input.transitionId)) {
      return {
        ok: false,
        intentId: input.transitionId,
        transitionId: input.transitionId,
        error: "IDEMPOTENT_REPLAY",
        commitMs: performance.now() - tC,
      };
    }
    if (this.nullifiers.has(input.nullifier)) {
      return {
        ok: false,
        intentId: input.transitionId,
        error: "NULLIFIER_CONFLICT",
        commitMs: performance.now() - tC,
      };
    }
    let sender: AccountState;
    let recipient: AccountState;
    try {
      sender = this.getAccount(input.from);
      recipient = this.getAccount(input.to);
    } catch {
      return {
        ok: false,
        intentId: input.transitionId,
        error: "unknown account",
        commitMs: performance.now() - tC,
      };
    }
    if (input.amount <= 0n) {
      return {
        ok: false,
        intentId: input.transitionId,
        error: "amount must be positive",
        commitMs: performance.now() - tC,
      };
    }
    if (sender.balance < input.amount + input.fee) {
      this.stats.rejected++;
      return {
        ok: false,
        intentId: input.transitionId,
        error: "insufficient balance at commit",
        commitMs: performance.now() - tC,
      };
    }
    sender.balance -= input.amount + input.fee;
    recipient.balance += input.amount;
    this.treasuryBalance += input.fee;
    this.nullifiers.add(input.nullifier);
    this.transitionIds.add(input.transitionId);
    this.stateRoot = input.newStateRoot;
    if (input.newNullifierRoot) this.nullifierRoot = input.newNullifierRoot;
    this.stats.committed++;
    return {
      ok: true,
      intentId: input.transitionId,
      transitionId: input.transitionId,
      newStateRoot: input.newStateRoot,
      commitMs: performance.now() - tC,
    };
  }

  commitProved(proved: ProvedJob[]): CommitResult[] {
    const t0 = performance.now();
    const results: CommitResult[] = [];
    for (const job of proved) {
      const tC = performance.now();
      if (this.transitionIds.has(job.transitionId)) {
        this.releaseReservation(job.intent.from, job.intent.amount, job.fee);
        this.stats.rejected++;
        results.push({
          ok: false,
          intentId: job.intent.id,
          transitionId: job.transitionId,
          error: "IDEMPOTENT_REPLAY",
          commitMs: performance.now() - tC,
        });
        continue;
      }
      if (this.nullifiers.has(job.nullifier)) {
        this.releaseReservation(job.intent.from, job.intent.amount, job.fee);
        this.stats.rejected++;
        results.push({
          ok: false,
          intentId: job.intent.id,
          error: "NULLIFIER_CONFLICT",
          commitMs: performance.now() - tC,
        });
        continue;
      }
      // Chain: if we have a committed root, job must start from it
      if (this.config.requireProof && this.stateRoot) {
        if (normalizeFrHex(job.oldStateRoot) !== normalizeFrHex(this.stateRoot)) {
          this.releaseReservation(job.intent.from, job.intent.amount, job.fee);
          this.stats.rejected++;
          results.push({
            ok: false,
            intentId: job.intent.id,
            error: "STALE_ROOT",
            commitMs: performance.now() - tC,
          });
          continue;
        }
      }
      const sender = this.getAccount(job.intent.from);
      const recipient = this.getAccount(job.intent.to);
      if (sender.balance < job.intent.amount + job.fee) {
        this.releaseReservation(job.intent.from, job.intent.amount, job.fee);
        this.stats.rejected++;
        results.push({
          ok: false,
          intentId: job.intent.id,
          error: "insufficient balance at commit",
          commitMs: performance.now() - tC,
        });
        continue;
      }
      sender.balance -= job.intent.amount + job.fee;
      sender.reserved -= job.intent.amount + job.fee;
      if (sender.reserved < 0n) sender.reserved = 0n;
      recipient.balance += job.intent.amount;
      this.treasuryBalance += job.fee;
      this.nullifiers.add(job.nullifier);
      this.transitionIds.add(job.transitionId);
      // Apply leaf updates to canonical map
      if (this.config.requireProof) {
        const u = job.leafUpdates;
        this.stateLeaves.set(u.senderIndex, u.senderNew);
        this.stateLeaves.set(u.recipientIndex, u.recipientNew);
        this.stateLeaves.set(u.treasuryIndex, u.treasuryNew);
        this.stateRoot = job.newStateRoot;
        this.nullifierRoot = job.newNullifierRoot;
      } else {
        this.stateRoot = job.newStateRoot;
        this.nullifierRoot = job.newNullifierRoot;
      }
      this.stats.committed++;
      results.push({
        ok: true,
        intentId: job.intent.id,
        transitionId: job.transitionId,
        newStateRoot: job.newStateRoot,
        commitMs: performance.now() - tC,
      });
    }
    this.stats.commitWallMs += performance.now() - t0;
    return results;
  }

  async runRound() {
    const { proved, failed } = await this.provePending();
    const commits = this.commitProved(proved);
    return { proved, failed, commits };
  }

  /**
   * UEP-30.2: drain mempool in conflict-free waves.
   *
   * Structural: parallel prove + serial commit per wave.
   * ZK: parallel prove is OK for latency, but only ONE proof can commit per root.
   *     Others get STALE_ROOT and are re-proved against the new root (optimistic concurrency).
   *     Same-sender jobs never share a wave (conflict graph).
   */
  async runScheduled(): Promise<{
    waves: number;
    schedule: ReturnType<typeof scheduleStats>;
    proved: ProvedJob[];
    failed: Array<{ intentId: string; error: string }>;
    commits: CommitResult[];
    staleRetries: number;
  }> {
    const mode = this.config.conflictMode ?? DEFAULT_CONFLICT_MODE;
    const jobs = this.pending.splice(0, this.pending.length) as PendingJob[];
    const schedule = scheduleStats(jobs, mode);
    const waves = partitionIntoWaves(jobs, mode);
    const allProved: ProvedJob[] = [];
    const allFailed: Array<{ intentId: string; error: string }> = [];
    const allCommits: CommitResult[] = [];
    const staleRetries = 0;

    for (const wave of waves) {
      if (this.config.requireProof) {
        // ZK: proofs from the same old root are not composable (each new_root is exclusive).
        // Within a wave, prove+commit sequentially so roots chain. Conflict graph still
        // maximizes independence across waves (same sender never shares a wave).
        for (const j of wave) {
          this.pending = [{ intent: j.intent, fee: j.fee, seq: j.seq }];
          const { proved, failed } = await this.provePending();
          allProved.push(...proved);
          allFailed.push(...failed);
          allCommits.push(...this.commitProved(proved));
        }
      } else {
        this.pending = wave.map((j) => ({
          intent: j.intent,
          fee: j.fee,
          seq: j.seq,
        }));
        const { proved, failed } = await this.provePending();
        allProved.push(...proved);
        allFailed.push(...failed);
        allCommits.push(...this.commitProved(proved));
      }
    }
    return {
      waves: waves.length,
      schedule,
      proved: allProved,
      failed: allFailed,
      commits: allCommits,
      staleRetries,
    };
  }

  /** Inspect schedule without executing. */
  peekSchedule(): ReturnType<typeof scheduleStats> & { waves: number[] } {
    const mode = this.config.conflictMode ?? DEFAULT_CONFLICT_MODE;
    const jobs = this.pending as PendingJob[];
    const waves = partitionIntoWaves(jobs, mode);
    return {
      ...scheduleStats(jobs, mode),
      waves: waves.map((w) => w.length),
    };
  }
}
