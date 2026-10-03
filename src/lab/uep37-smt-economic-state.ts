/**
 * UEP-37.3 — SMT economic state with optional Poseidon leaves (uep-zk).
 *
 * leafMode:
 * - "structural": TS core hash leaves (Poseidon BN254 since snapshot format 6) — fast lab
 * - "poseidon-zk": Poseidon note_commitment via uep-zk for each balance leaf
 *   (same function as the TS core, so both modes give the same root)
 *
 * stateRoot():
 * - structural → SMT root (TS hMerkle)
 * - poseidon-zk → poseidonLeafSetDigest (canonical set of Poseidon leaves)
 *   until shipped uep-zk includes smt-root for full Poseidon Merkle roots
 */

import { createHash } from "node:crypto";
import { Fr } from "../core/field.ts";
import { SparseMerkleTree } from "../core/smt.ts";
import { creatorFee } from "../core/fee.ts";
import { setCommitment, canonicalFields } from "./uep-canonical-encode.ts";
import {
  applyProtocolTx,
  runDeterministicExpiries,
  holdsCommitment as computeHoldsCommitment,
  holdRecordCommitment,
  pruneTerminatedHolds,
  TOMBSTONE_MIN_AGE_HEIGHTS,
  totalHeldFor,
  type HoldRecord,
  type ProtocolBatchTx,
} from "./uep-econ-04.ts";
import { canonicalAccountId } from "./uep-account-id.ts";
import {
  computeEconomicTip,
  obligationsCommitment,
  type ObligationRecord,
} from "./uep-econ-05.ts";
import type { BatchTx } from "./uep35-batch-lab.ts";
import {
  CANONICAL_SMT_DEPTH,
  CANONICAL_ASSET_ID,
  LAB_ZERO_BLINDING,
  noteCommitmentFromAmount,
  accountIndex,
  nullifierIndex,
  leafEncodingMeta,
  isPoseidonBackendActive,
} from "./uep37-leaf-encoding.ts";
import {
  poseidonNoteLeaf,
  type StateWitnessJson,
  verifyStructuralWitness,
} from "./uep37-poseidon-leaf-provider.ts";
import { zkSmtRoot, zkSmtPath } from "./uep-zk-runner.ts";

export const SMT_STATE_VERSION = "37.4";
export const SMT_TREASURY_LABEL = "treasury";

export type LeafMode = "structural" | "poseidon-zk";

export function accountLabelToFr(label: string): Fr {
  const h = createHash("sha256")
    .update("UEP-37-ACCT|")
    .update(label, "utf8")
    .digest();
  return Fr.fromBytesBE254(h);
}

export type SmtEconomicStateOpts = {
  testOnlyDepth?: number;
  isTestFixture?: boolean;
  /** Default structural. poseidon-zk requires uep-zk. */
  leafMode?: LeafMode;
  /**
   * Lab only: assign small owner ids whose state indices are distinct at this depth.
   * Does not change production label hashing.
   */
  labDistinctIndices?: boolean;
};

export class SmtEconomicState {
  private accounts = new Map<string, bigint>();
  private treasury = 0n;
  private height = 0;
  private rootHistory: string[] = [];
  private nfRootHistory: string[] = [];
  private accountTree: SparseMerkleTree;
  private nullifierTree: SparseMerkleTree;
  private holdTree: SparseMerkleTree;
  private obligationTree: SparseMerkleTree;
  private spentNullifiers = new Set<string>();
  private blindings = new Map<string, Fr>();
  /** index → poseidon leaf hex when leafMode=poseidon-zk */
  private poseidonLeaves = new Map<string, string>();
  /** Optional circuit-aligned owner Fr per account label (P4). */
  private accountIdOverrides = new Map<string, import("../core/field.ts").Fr>();
  /** index -> account key; reject two owners on same slot. */
  private poseidonIndexOwner = new Map<string, string>();
  structuralIndexOwner = new Map<string, string>();
  readonly depth: number;
  readonly isTestFixture: boolean;
  readonly leafMode: LeafMode;
  finalizedBatchIds = new Set<string>();
  appliedTxIds = new Set<string>();
  appliedTxRollingRoot = createHash("sha256").update("UEP-APPLIED-GENESIS").digest("hex");
  /** S2-3/A.1: consumed auth nonces as "from|nonce" */
  authNonces = new Set<string>();
  holds = new Map<string, HoldRecord>();
  obligations = new Map<string, ObligationRecord>();
  retiredHoldIds = new Set<string>();
  /** P0: immutable conservation baseline. */
  genesisSupply = 0n;

  constructor(initial?: Record<string, bigint>, opts?: SmtEconomicStateOpts) {
    this.isTestFixture = opts?.isTestFixture === true || opts?.testOnlyDepth !== undefined;
    this.depth = opts?.testOnlyDepth ?? CANONICAL_SMT_DEPTH;
    this.leafMode = opts?.leafMode ?? "structural";
    if (!this.isTestFixture && this.depth !== CANONICAL_SMT_DEPTH) {
      throw new Error(`UEP-37: production SmtEconomicState requires depth ${CANONICAL_SMT_DEPTH}`);
    }
    this.accountTree = new SparseMerkleTree(this.depth);
    this.nullifierTree = new SparseMerkleTree(this.depth);
    this.holdTree = new SparseMerkleTree(this.depth);
    this.obligationTree = new SparseMerkleTree(this.depth);
    if (opts?.labDistinctIndices && initial) {
      // Smallest owner ids 1, 2, ... whose (account, asset) state indices are distinct.
      const used = new Set<string>();
      let slot = 1n;
      const next = (): Fr => {
        for (;;) {
          const id = new Fr(slot);
          slot += 1n;
          const idx = accountIndex(id, this.depth).toString();
          if (!used.has(idx)) {
            used.add(idx);
            return id;
          }
        }
      };
      for (const k of Object.keys(initial)) this.accountIdOverrides.set(canonicalAccountId(k), next());
      this.accountIdOverrides.set(canonicalAccountId(SMT_TREASURY_LABEL), next());
    }
    if (initial) {
      for (const [k, v] of Object.entries(initial)) {
        const id = canonicalAccountId(k);
        this.accounts.set(id, (this.accounts.get(id) ?? 0n) + v);
        this.genesisSupply += v;
        this.blindings.set(id, LAB_ZERO_BLINDING);
        this.syncAccountLeaf(id);
      }
    }
    this.syncTreasuryLeaf();
    this.rootHistory.push(this.stateRoot());
    this.nfRootHistory.push(this.nullifierRoot());
  }

  static genesis(
    balances: Record<string, bigint>,
    opts?: SmtEconomicStateOpts,
  ): SmtEconomicState {
    return new SmtEconomicState(balances, opts);
  }

  static genesisDepth(balances: Record<string, bigint>, depth: number): SmtEconomicState {
    return new SmtEconomicState(balances, { testOnlyDepth: depth, isTestFixture: true });
  }

  meta() {
    return {
      stateVersion: SMT_STATE_VERSION,
      depth: this.depth,
      isTestFixture: this.isTestFixture,
      leafMode: this.leafMode,
      encoding: leafEncodingMeta(),
      poseidonBitIdentical: isPoseidonBackendActive() || this.leafMode === "poseidon-zk",
      stateRootKind:
        this.leafMode === "poseidon-zk" ? "poseidon-smt-root" : "structural-smt",
    };
  }

  ensure(id: string, bal = 0n): void {
    const k = canonicalAccountId(id);
    if (!this.accounts.has(k)) {
      this.accounts.set(k, bal);
      this.blindings.set(k, LAB_ZERO_BLINDING);
      this.syncAccountLeaf(k);
    }
  }

  setBlinding(label: string, blinding: Fr): void {
    this.blindings.set(label, blinding);
    if (this.accounts.has(label)) this.syncAccountLeaf(label);
  }

  private leafFrFor(label: string, amount: bigint): Fr {
    const owner = this.ownerFr(label);
    const blind = this.blindings.get(label) ?? LAB_ZERO_BLINDING;
    if (this.leafMode === "poseidon-zk") {
      const hex = poseidonNoteLeaf(owner, amount, blind, CANONICAL_ASSET_ID);
      const idx = accountIndex(owner, this.depth).toString();
      const prev = this.poseidonIndexOwner.get(idx);
      const who = canonicalAccountId(label);
      if (prev && prev !== who) {
        throw new Error(`SMT_INDEX_COLLISION index=${idx} ${prev} vs ${who}`);
      }
      this.poseidonIndexOwner.set(idx, who);
      this.poseidonLeaves.set(idx, hex);
      return Fr.from("0x" + hex);
    }
    return noteCommitmentFromAmount(owner, amount, blind, CANONICAL_ASSET_ID);
  }

  private syncAccountLeaf(label: string): void {
    const bal = this.accounts.get(label) ?? 0n;
    const owner = this.ownerFr(label);
    const idx = accountIndex(owner, this.depth);
    const who = canonicalAccountId(label);
    const prev = this.structuralIndexOwner.get(idx.toString());
    if (prev && prev !== who) {
      throw new Error(`SMT_INDEX_COLLISION index=${idx} ${prev} vs ${who}`);
    }
    this.structuralIndexOwner.set(idx.toString(), who);
    const leaf = this.leafFrFor(label, bal);
    this.accountTree.setIndex(idx, leaf);
  }

  private syncTreasuryLeaf(): void {
    const owner = this.ownerFr(SMT_TREASURY_LABEL);
    {
      const idx = accountIndex(owner, this.depth).toString();
      const who = canonicalAccountId(SMT_TREASURY_LABEL);
      for (const m of [this.structuralIndexOwner, this.poseidonIndexOwner]) {
        const prev = m.get(idx);
        if (prev && prev !== who) throw new Error(`SMT_INDEX_COLLISION index=${idx} ${prev} vs ${who}`);
        m.set(idx, who);
      }
    }
    const leaf = this.leafFrFor(SMT_TREASURY_LABEL, this.treasury);
    // leafFrFor uses accounts map for non-treasury; force treasury amount
    if (this.leafMode === "poseidon-zk") {
      const hex = poseidonNoteLeaf(
        owner,
        this.treasury,
        LAB_ZERO_BLINDING,
        CANONICAL_ASSET_ID,
      );
      this.poseidonLeaves.set(accountIndex(owner, this.depth).toString(), hex);
      this.accountTree.setIndex(
        accountIndex(owner, this.depth),
        Fr.from("0x" + hex),
      );
    } else {
      this.accountTree.setIndex(
        accountIndex(owner, this.depth),
        noteCommitmentFromAmount(owner, this.treasury, LAB_ZERO_BLINDING, CANONICAL_ASSET_ID),
      );
    }
  }

  listPoseidonLeaves(): Array<{ index: number; leafHex: string }> {
    return this.poseidonLeavesList();
  }

  private poseidonLeavesList(): Array<{ index: number; leafHex: string }> {
    const out: Array<{ index: number; leafHex: string }> = [];
    for (const [idx, leaf] of this.poseidonLeaves) {
      out.push({ index: Number(idx), leafHex: leaf });
    }
    return out;
  }

  /** Real Poseidon SMT root via uep-zk smt-root (authority). */
  private poseidonSmtRootNow(): string {
    return zkSmtRoot(this.depth, this.poseidonLeavesList());
  }

  /** Circuit spends include the recipient even at zero. The tree must too. */
  ensureAccount(label: string): void {
    const id = canonicalAccountId(label);
    if (!this.accounts.has(id)) {
      this.accounts.set(id, 0n);
      this.blindings.set(id, LAB_ZERO_BLINDING);
      this.syncAccountLeaf(id);
    }
  }

  balance(id: string): bigint {
    return this.accounts.get(canonicalAccountId(id)) ?? 0n;
  }

  bindAccountId(label: string, id: Fr): void {
    this.accountIdOverrides.set(canonicalAccountId(label), id);
    const k = canonicalAccountId(label);
    if (this.accounts.has(k)) this.syncAccountLeaf(k);
    if (k === canonicalAccountId(SMT_TREASURY_LABEL)) this.syncTreasuryLeaf();
  }

  ownerFr(label: string): Fr {
    return this.accountIdOverrides.get(canonicalAccountId(label)) ?? accountLabelToFr(label);
  }

  held(id: string): bigint {
    return totalHeldFor(this.holds, canonicalAccountId(id));
  }

  available(id: string): bigint {
    return this.balance(id) - this.held(id);
  }


  get treasuryBalance(): bigint {
    return this.treasury;
  }

  get sequence(): number {
    return this.height;
  }

  economicValue(): bigint {
    let s = 0n;
    for (const v of this.accounts.values()) s += v;
    return s + this.treasury;
  }

  conservationOk(): boolean {
    return this.economicValue() === this.genesisSupply;
  }

  previousRoot(): string {
    return this.rootHistory[this.rootHistory.length - 1]!;
  }

  stateRoot(): string {
    if (this.leafMode === "poseidon-zk") return this.poseidonSmtRootNow();
    return this.accountTree.root().toHex();
  }

  /** Structural SMT root always available (TS backend). */
  structuralSmtRoot(): string {
    return this.accountTree.root().toHex();
  }

  previousNullifierRoot(): string {
    return this.nfRootHistory[this.nfRootHistory.length - 1]!;
  }

  nullifierRoot(): string {
    return this.nullifierTree.root().toHex();
  }

  /**
   * Phase A.1 P0-1/P0-3 — consensus-facing commitment.
   * Commits account/economic root + nullifier root + height + appliedTx set.
   * Does NOT change SpendCircuit yet; proposals/finality should use this when available.
   */
  appliedTxCommitment(): string {
    return this.appliedTxRollingRoot;
  }

  private absorbAppliedIds(ids: Iterable<string>): void {
    for (const id of [...ids].sort()) {
      this.appliedTxRollingRoot = createHash("sha256")
        .update(canonicalFields([this.appliedTxRollingRoot, id]))
        .digest("hex");
    }
  }

  authNonceCommitment(): string {
    return setCommitment(this.authNonces);
  }

  holdsCommitment(): string {
    return computeHoldsCommitment(this.holds);
  }

  holdsSmtRoot(): string {
    return this.holdTree.root().toHex();
  }

  obligationsSmtRoot(): string {
    return this.obligationTree.root().toHex();
  }

  private indexOfId(kind: string, id: string): bigint {
    const h = createHash("sha256").update(`UEP-37-${kind}|`).update(id).digest();
    const n = Fr.fromBytesBE254(h).n;
    return n % (1n << BigInt(this.depth));
  }

  resyncHoldObligationTrees(): void {
    this.holdTree = new SparseMerkleTree(this.depth);
    this.obligationTree = new SparseMerkleTree(this.depth);
    for (const h of this.holds.values()) {
      if (h.status !== "HELD") continue;
      const leaf = Fr.fromBytesBE254(
        createHash("sha256").update(holdRecordCommitment(h)).digest(),
      );
      this.holdTree.setIndex(this.indexOfId("HOLD", h.holdId), leaf);
    }
    for (const o of this.obligations.values()) {
      if (o.status === "SETTLED" || o.status === "CANCELLED" || o.status === "EXPIRED" || o.status === "CLIENT_WINS" || o.status === "PROVIDER_WINS") {
        continue;
      }
      const raw = createHash("sha256")
        .update(o.obligationId)
        .update(o.status)
        .update(o.holdId)
        .digest();
      this.obligationTree.setIndex(this.indexOfId("OBL", o.obligationId), Fr.fromBytesBE254(raw));
    }
  }

  obligationsCommitment(): string {
    return obligationsCommitment(this.obligations);
  }

  economicTipCommitment(): string {
    return computeEconomicTip({
      stateRoot: this.stateRoot(),
      nullifierRoot: this.nullifierRoot(),
      height: this.height,
      appliedTxCommitment: this.appliedTxCommitment(),
      authNonceCommitment: this.authNonceCommitment(),
      holdsCommitment: this.holdsCommitment(),
      obligationsCommitment: this.obligationsCommitment(),
      treasury: this.treasury.toString(),
      holdsSmtRoot: this.holdsSmtRoot(),
      obligationsSmtRoot: this.obligationsSmtRoot(),
    });
  }

  previewEconomicTip(txs: BatchTx[]): string | null {
    const c = this.clone();
    const r = c.applyTransfers(txs);
    if (!r.ok) return null;
    c.height += 1;
    return c.economicTipCommitment();
  }

  canonicalStateCommitment(): string {
    return createHash("sha256")
      .update(
        [
          "UEP-CANONICAL-STATE-A1",
          this.stateRoot(),
          this.nullifierRoot(),
          String(this.height),
          this.appliedTxCommitment(),
          this.authNonceCommitment(),
          this.holdsCommitment(),
        ].join("|"),
      )
      .digest("hex");
  }

  emptyRoot(): string {
    return new SparseMerkleTree(this.depth).root().toHex();
  }

  hasNullifier(nfHex: string): boolean {
    return this.spentNullifiers.has(nfHex);
  }

  getPoseidonLeaf(label: string): string | undefined {
    const owner = this.ownerFr(label);
    return this.poseidonLeaves.get(accountIndex(owner, this.depth).toString());
  }

  insertNullifier(nullifier: Fr): { ok: true } | { ok: false; reason: string } {
    const hex = nullifier.toHex();
    if (this.spentNullifiers.has(hex)) {
      return { ok: false, reason: "NULLIFIER_ALREADY_SPENT" };
    }
    this.spentNullifiers.add(hex);
    this.nullifierTree.setIndex(nullifierIndex(nullifier, this.depth), nullifier);
    return { ok: true };
  }

  balancesSnapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of [...this.accounts.keys()].sort()) {
      out[k] = this.accounts.get(k)!.toString();
    }
    out["__treasury__"] = this.treasury.toString();
    return out;
  }

  applyTransfers(
    txs: BatchTx[],
  ): { ok: true } | { ok: false; reason: string } {
    let snapAcc = new Map(this.accounts);
    let snapTreas = this.treasury;
    let snapTree = this.accountTree.clone();
    let snapPoseidon = new Map(this.poseidonLeaves);
    let snapHolds = new Map(
      [...this.holds.entries()].map(([k, v]) => [k, { ...v }]),
    );
    let snapObs = new Map(
      [...this.obligations.entries()].map(([k, v]) => [k, { ...v }]),
    );
    const snapNf = new Set(this.spentNullifiers);
    const touched = new Set<string>();

    const newlyApplied = new Set<string>();
    const newlyNonces = new Set<string>();
    // ECON-05: expire abandoned holds at current logical height before new ops
    runDeterministicExpiries({
      holds: this.holds,
      obligations: this.obligations,
      height: this.height,
      balance: (id) => this.balance(id),
      ensure: (id, bal) => this.ensure(id, bal ?? 0n),
      getTreasury: () => this.treasury,
      setTreasury: (v) => {
        this.treasury = v;
      },
      setBalance: (id, v) => {
        this.accounts.set(id, v);
      },
    });
    snapAcc = new Map(this.accounts);
    snapTreas = this.treasury;
    snapTree = this.accountTree.clone();
    snapPoseidon = new Map(this.poseidonLeaves);
    snapHolds = new Map(
      [...this.holds.entries()].map(([k, v]) => [k, { ...v }]),
    );
    snapObs = new Map(
      [...this.obligations.entries()].map(([k, v]) => [k, { ...v }]),
    );
    for (const tx of txs) {
      if (!tx.id) {
        this.accounts = snapAcc;
        this.treasury = snapTreas;
        this.accountTree = snapTree;
        this.poseidonLeaves = snapPoseidon;
        this.holds = snapHolds;
        this.obligations = snapObs;
        return { ok: false, reason: "MISSING_TX_ID" };
      }
      if (this.appliedTxIds.has(tx.id) || newlyApplied.has(tx.id)) {
        this.accounts = snapAcc;
        this.treasury = snapTreas;
        this.accountTree = snapTree;
        this.poseidonLeaves = snapPoseidon;
        this.holds = snapHolds;
        this.obligations = snapObs;
        return { ok: false, reason: "TX_REPLAY" };
      }
      if (tx.auth) {
        const nk = `${tx.from}|${tx.auth.nonce}`;
        if (this.authNonces.has(nk) || newlyNonces.has(nk)) {
          this.accounts = snapAcc;
          this.treasury = snapTreas;
          this.accountTree = snapTree;
          this.poseidonLeaves = snapPoseidon;
          this.holds = snapHolds;
        this.obligations = snapObs;
          return { ok: false, reason: "NONCE_REPLAY" };
        }
      }
      const pr = applyProtocolTx(
        {
          holds: this.holds,
          obligations: this.obligations,
          retiredHoldIds: this.retiredHoldIds,
          height: this.height,
          balance: (id) => this.balance(id),
          ensure: (id, bal) => this.ensure(id, bal ?? 0n),
          getTreasury: () => this.treasury,
          setTreasury: (v) => {
            this.treasury = v;
          },
          setBalance: (id, v) => {
            this.accounts.set(id, v);
          },
        },
        tx as ProtocolBatchTx,
      );
      if (!pr.ok) {
        this.accounts = snapAcc;
        this.treasury = snapTreas;
        this.accountTree = snapTree;
        this.poseidonLeaves = snapPoseidon;
        this.holds = snapHolds;
        this.obligations = snapObs;
        return pr;
      }
      touched.add(tx.from);
      if (tx.to) touched.add(tx.to);
      newlyApplied.add(tx.id);
      if (tx.auth) newlyNonces.add(`${tx.from}|${tx.auth.nonce}`);
    }
    try {
      for (const id of touched) this.syncAccountLeaf(id);
      this.syncTreasuryLeaf();
    } catch (e) {
      this.accounts = snapAcc;
      this.treasury = snapTreas;
      this.accountTree = snapTree;
      this.poseidonLeaves = snapPoseidon;
      this.holds = snapHolds;
      this.obligations = snapObs;
      return {
        ok: false,
        reason: e instanceof Error ? e.message : String(e),
      };
    }
    this.absorbAppliedIds(newlyApplied);
    for (const id of newlyApplied) this.appliedTxIds.add(id);
    for (const nk of newlyNonces) this.authNonces.add(nk);
    pruneTerminatedHolds(
      this.holds,
      this.retiredHoldIds,
      this.height,
      TOMBSTONE_MIN_AGE_HEIGHTS,
    );
    this.resyncHoldObligationTrees();
    if (!this.conservationOk()) {
      this.accounts = snapAcc;
      this.treasury = snapTreas;
      this.accountTree = snapTree;
      this.poseidonLeaves = snapPoseidon;
      this.holds = snapHolds;
      this.obligations = snapObs;
      return { ok: false, reason: "CONSERVATION_BROKEN" };
    }
    return { ok: true };
  }

  commitLogicalHeight(nullifiers: Fr[] = []): string {
    for (const nf of nullifiers) {
      const r = this.insertNullifier(nf);
      if (!r.ok) throw new Error(r.reason);
    }
    this.height += 1;
    const root = this.stateRoot();
    this.rootHistory.push(root);
    this.nfRootHistory.push(this.nullifierRoot());
    return root;
  }

  applyBatch(
    txs: BatchTx[],
    nullifiers: Fr[] = [],
  ): { ok: true; stateRoot: string; nullifierRoot: string } | { ok: false; reason: string } {
    // P0-2: full staging — never mutate self on failure
    const staged = this.clone();
    const r = staged.applyTransfers(txs);
    if (!r.ok) return r;
    try {
      for (const nf of nullifiers) {
        const ir = staged.insertNullifier(nf);
        if (!ir.ok) return { ok: false, reason: ir.reason };
      }
      staged.height += 1;
      const stateRoot = staged.stateRoot();
      staged.rootHistory.push(stateRoot);
      staged.nfRootHistory.push(staged.nullifierRoot());
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    // Commit only on full success
    this.accounts = staged.accounts;
    this.treasury = staged.treasury;
    this.height = staged.height;
    this.rootHistory = staged.rootHistory;
    this.nfRootHistory = staged.nfRootHistory;
    this.accountTree = staged.accountTree;
    this.nullifierTree = staged.nullifierTree;
    this.spentNullifiers = staged.spentNullifiers;
    this.blindings = staged.blindings;
    this.poseidonLeaves = staged.poseidonLeaves;
    this.finalizedBatchIds = staged.finalizedBatchIds;
    this.appliedTxIds = staged.appliedTxIds;
    this.appliedTxRollingRoot = staged.appliedTxRollingRoot;
    this.authNonces = staged.authNonces;
    this.holds = staged.holds;
    this.obligations = staged.obligations;
    this.retiredHoldIds = staged.retiredHoldIds;
    this.holdTree = staged.holdTree;
    this.obligationTree = staged.obligationTree;
    this.genesisSupply = staged.genesisSupply;
    return {
      ok: true,
      stateRoot: this.stateRoot(),
      nullifierRoot: this.nullifierRoot(),
    };
  }

  /**
   * Structural StateWitness for an account label (path under TS SMT).
   * Leaf is Poseidon when leafMode=poseidon-zk; siblings use TS hMerkle.
   */
  stateWitnessFor(label: string): StateWitnessJson {
    const owner = this.ownerFr(label);
    const idx = accountIndex(owner, this.depth);
    if (this.leafMode === "poseidon-zk") {
      const w = zkSmtPath(this.depth, idx, this.poseidonLeavesList());
      return {
        depth: w.depth,
        index: w.index,
        leaf: w.leaf,
        root: w.root,
        siblings: w.siblings,
        indexBits: w.indexBits,
        rootKind: "poseidon-smt-root",
      };
    }
    const path = this.accountTree.pathAt(idx);
    const leafFr = this.accountTree.getIndex(idx);
    return {
      depth: this.depth,
      index: idx.toString(),
      leaf: leafFr.toHex(),
      root: this.structuralSmtRoot(),
      siblings: path.siblings.map((s) => s.toHex()),
      indexBits: path.indexBits,
      rootKind: "structural-smt",
    };
  }

  markFinalized(batchId: string): void {
    this.finalizedBatchIds.add(batchId);
  }

  isFinalized(batchId: string): boolean {
    return this.finalizedBatchIds.has(batchId);
  }

  clone(): SmtEconomicState {
    const c = new SmtEconomicState(undefined, {
      testOnlyDepth: this.isTestFixture ? this.depth : undefined,
      isTestFixture: this.isTestFixture,
      leafMode: this.leafMode,
    });
    c.accounts = new Map(this.accounts);
    c.treasury = this.treasury;
    c.height = this.height;
    c.rootHistory = [...this.rootHistory];
    c.nfRootHistory = [...this.nfRootHistory];
    c.accountTree = this.accountTree.clone();
    c.nullifierTree = this.nullifierTree.clone();
    c.holdTree = this.holdTree.clone();
    c.obligationTree = this.obligationTree.clone();
    c.spentNullifiers = new Set(this.spentNullifiers);
    c.blindings = new Map(this.blindings);
    c.poseidonLeaves = new Map(this.poseidonLeaves);
    c.accountIdOverrides = new Map(this.accountIdOverrides);
    c.poseidonIndexOwner = new Map(this.poseidonIndexOwner);
    c.structuralIndexOwner = new Map(this.structuralIndexOwner);
    c.finalizedBatchIds = new Set(this.finalizedBatchIds);
    c.appliedTxIds = new Set(this.appliedTxIds);
    c.appliedTxRollingRoot = this.appliedTxRollingRoot;
    c.genesisSupply = this.genesisSupply;
    c.retiredHoldIds = new Set(this.retiredHoldIds);
    c.authNonces = new Set(this.authNonces);
    c.holds = new Map(
      [...this.holds.entries()].map(([k, v]) => [k, { ...v }]),
    );
    c.obligations = new Map(
      [...this.obligations.entries()].map(([k, v]) => [k, { ...v }]),
    );
    return c;
  }

  observableEquals(other: SmtEconomicState): boolean {
    if (this.height !== other.height) return false;
    if (this.treasury !== other.treasury) return false;
    if (this.stateRoot() !== other.stateRoot()) return false;
    if (this.nullifierRoot() !== other.nullifierRoot()) return false;
    if (this.appliedTxCommitment() !== other.appliedTxCommitment()) return false;
    const a = this.balancesSnapshot();
    const b = other.balancesSnapshot();
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if ((a[k] ?? "0") !== (b[k] ?? "0")) return false;
    }
    return true;
  }

  previewRoot(txs: BatchTx[]): string | null {
    const clone = this.clone();
    const r = clone.applyBatch(txs);
    return r.ok ? r.stateRoot : null;
  }
}

export { verifyStructuralWitness };
