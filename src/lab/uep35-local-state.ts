/**
 * UEP-35.7.1 / 36.1.2 — Per-node deterministic economic state (LAB).
 * Not Poseidon SMT. Height increments once per logical consensus transition.
 */

import { createHash } from "node:crypto";
import type { BatchTx } from "./uep35-batch-lab.ts";
import { creatorFee } from "../core/fee.ts";
import {
  applyProtocolTx,
  runDeterministicExpiries,
  holdsCommitment,
  totalHeldFor,
  type HoldRecord,
  type ProtocolBatchTx,
  pruneTerminatedHolds,
  TOMBSTONE_MIN_AGE_HEIGHTS,
} from "./uep-econ-04.ts";
import {
  computeEconomicTip,
  obligationsCommitment,
  type ObligationRecord,
} from "./uep-econ-05.ts";
import { setCommitment, canonicalFields } from "./uep-canonical-encode.ts";
import { canonicalAccountId } from "./uep-account-id.ts";

export type LocalAccount = { balance: bigint };

export class LocalEconomicState {
  private accounts = new Map<string, bigint>();
  private treasury = 0n;
  private height = 0;
  private rootHistory: string[] = ["GENESIS"];
  finalizedBatchIds = new Set<string>();
  appliedTxIds = new Set<string>();
  /** O(1) tip material — rolling root, not full-history sort */
  appliedTxRollingRoot = createHash("sha256").update("UEP-APPLIED-GENESIS").digest("hex");
  authNonces = new Set<string>();
  /** ECON-04 on-chain holds */
  holds = new Map<string, HoldRecord>();
  obligations = new Map<string, ObligationRecord>();
  retiredHoldIds = new Set<string>();
  /**
   * P0: immutable conservation baseline (sum of initial balances; treasury starts 0).
   * Survives snapshot/restore. economicValue() must always equal this.
   */
  genesisSupply = 0n;
  /** When set, every applied tx must carry matching network/domain. */
  requireDomainScope = false;
  expectedNetworkId?: string;
  expectedDomainId?: number;

  constructor(initial?: Record<string, bigint>) {
    if (initial) {
      for (const [k, v] of Object.entries(initial)) {
        const id = canonicalAccountId(k);
        this.accounts.set(id, (this.accounts.get(id) ?? 0n) + v);
        this.genesisSupply += v;
      }
    }
  }

  ensure(id: string, bal = 0n): void {
    const k = canonicalAccountId(id);
    if (!this.accounts.has(k)) this.accounts.set(k, bal);
  }

  balance(id: string): bigint {
    return this.accounts.get(canonicalAccountId(id)) ?? 0n;
  }

  /** Total economic value: all account balances + treasury (holds do not move units). */
  economicValue(): bigint {
    let s = 0n;
    for (const v of this.accounts.values()) s += v;
    return s + this.treasury;
  }

  conservationOk(): boolean {
    return this.economicValue() === this.genesisSupply;
  }

  held(id: string): bigint {
    return totalHeldFor(this.holds, canonicalAccountId(id));
  }

  available(id: string): bigint {
    return this.balance(id) - this.held(id);
  }

  holdsCommitment(): string {
    return holdsCommitment(this.holds);
  }

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

  obligationsCommitment(): string {
    return obligationsCommitment(this.obligations);
  }

  /** ECON-05: full economic tip used by proposals when enabled. */
  economicTipCommitment(): string {
    return computeEconomicTip({
      stateRoot: this.stateRoot(),
      nullifierRoot: "LOCAL_NO_NULLIFIER",
      height: this.height,
      appliedTxCommitment: this.appliedTxCommitment(),
      authNonceCommitment: this.authNonceCommitment(),
      holdsCommitment: this.holdsCommitment(),
      obligationsCommitment: this.obligationsCommitment(),
      treasury: this.treasury.toString(),
    });
  }

  previewEconomicTip(txs: BatchTx[]): string | null {
    const c = this.clone();
    const r = c.applyTransfers(txs);
    if (!r.ok) return null;
    c.height += 1;
    return c.economicTipCommitment();
  }

  get treasuryBalance(): bigint {
    return this.treasury;
  }

  get sequence(): number {
    return this.height;
  }

  previousRoot(): string {
    return this.rootHistory[this.rootHistory.length - 1]!;
  }

  /** Snapshot of all balances for full observable equality. */
  balancesSnapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of [...this.accounts.keys()].sort()) {
      out[k] = this.accounts.get(k)!.toString();
    }
    return out;
  }

  /** Deterministic state commitment (LAB). Includes height. */
  stateRoot(): string {
    const h = createHash("sha256");
    h.update("UEP-35.7.1-STATE|");
    const keys = [...this.accounts.keys()].sort();
    for (const k of keys) {
      h.update(`${k}=${this.accounts.get(k)!.toString()};`);
    }
    h.update(`treasury=${this.treasury};height=${this.height};`);
    return h.digest("hex");
  }

  /**
   * Apply transfers only — does NOT increment consensus height.
   * Used for multi-wave scheduling within one logical transition.
   */
  applyTransfers(
    txs: BatchTx[],
  ): { ok: true } | { ok: false; reason: string } {
    let snap = new Map(this.accounts);
    let treas = this.treasury;
    let snapHolds = new Map(
      [...this.holds.entries()].map(([k, v]) => [k, { ...v }]),
    );
    let snapObs = new Map(
      [...this.obligations.entries()].map(([k, v]) => [k, { ...v }]),
    );
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
    // Expiries are height-driven protocol, not batch txs: keep them if a later tx fails.
    snap = new Map(this.accounts);
    treas = this.treasury;
    snapHolds = new Map(
      [...this.holds.entries()].map(([k, v]) => [k, { ...v }]),
    );
    snapObs = new Map(
      [...this.obligations.entries()].map(([k, v]) => [k, { ...v }]),
    );
    for (const tx of txs) {
      if (this.requireDomainScope) {
        if (!tx.networkId || tx.domainId === undefined) {
          this.accounts = snap;
          this.treasury = treas;
          this.holds = snapHolds;
          this.obligations = snapObs;
          return { ok: false, reason: "INVALID_OR_MISSING_DOMAIN_ID" };
        }
        if (
          this.expectedNetworkId !== undefined &&
          tx.networkId !== this.expectedNetworkId
        ) {
          this.accounts = snap;
          this.treasury = treas;
          this.holds = snapHolds;
          this.obligations = snapObs;
          return { ok: false, reason: "NETWORK_MISMATCH" };
        }
        if (
          this.expectedDomainId !== undefined &&
          tx.domainId !== this.expectedDomainId
        ) {
          this.accounts = snap;
          this.treasury = treas;
          this.holds = snapHolds;
          this.obligations = snapObs;
          return { ok: false, reason: "DOMAIN_MISMATCH" };
        }
      }
      if (!tx.id) {
        this.accounts = snap;
        this.treasury = treas;
        this.holds = snapHolds;
        this.obligations = snapObs;
        return { ok: false, reason: "MISSING_TX_ID" };
      }
      if (this.appliedTxIds.has(tx.id) || newlyApplied.has(tx.id)) {
        this.accounts = snap;
        this.treasury = treas;
        this.holds = snapHolds;
        this.obligations = snapObs;
        return { ok: false, reason: "TX_REPLAY" };
      }
      if (tx.auth) {
        const nk = `${tx.from}|${tx.auth.nonce}`;
        if (this.authNonces.has(nk) || newlyNonces.has(nk)) {
          this.accounts = snap;
          this.treasury = treas;
          this.holds = snapHolds;
        this.obligations = snapObs;
          return { ok: false, reason: "NONCE_REPLAY" };
        }
        newlyNonces.add(nk);
      }
      const pr = applyProtocolTx(
        {
          holds: this.holds,
          obligations: this.obligations,
          retiredHoldIds: this.retiredHoldIds,
          height: this.height,
          balance: (id) => this.balance(id),
          ensure: (id, bal) => this.ensure(id, bal),
          getTreasury: () => this.treasury,
          setTreasury: (v) => {
            this.treasury = v;
          },
          setBalance: (id, v) => {
            this.accounts.set(canonicalAccountId(id), v);
          },
        },
        tx as ProtocolBatchTx,
      );
      if (!pr.ok) {
        this.accounts = snap;
        this.treasury = treas;
        this.holds = snapHolds;
        this.obligations = snapObs;
        return pr;
      }
      newlyApplied.add(tx.id);
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
    if (!this.conservationOk()) {
      this.accounts = snap;
      this.treasury = treas;
      this.holds = snapHolds;
      this.obligations = snapObs;
      return { ok: false, reason: "CONSERVATION_BROKEN" };
    }
    return { ok: true };
  }

  /**
   * Complete one logical consensus height: bump height and record root.
   * Call once after all waves of a batch/aggregate are applied.
   */
  commitLogicalHeight(): string {
    this.height += 1;
    const root = this.stateRoot();
    this.rootHistory.push(root);
    return root;
  }

  /**
   * Apply batch as a single logical transition (transfers + one height bump).
   */
  applyBatch(
    txs: BatchTx[],
  ): { ok: true; stateRoot: string } | { ok: false; reason: string } {
    const r = this.applyTransfers(txs);
    if (!r.ok) return r;
    return { ok: true, stateRoot: this.commitLogicalHeight() };
  }

  markFinalized(batchId: string): void {
    this.finalizedBatchIds.add(batchId);
  }

  isFinalized(batchId: string): boolean {
    return this.finalizedBatchIds.has(batchId);
  }

  clone(): LocalEconomicState {
    const c = new LocalEconomicState();
    for (const [k, v] of this.accounts) c.accounts.set(k, v);
    c.treasury = this.treasury;
    c.height = this.height;
    c.rootHistory = [...this.rootHistory];
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

  /** Full observable equality: balances, treasury, height, stateRoot. */
  observableEquals(other: LocalEconomicState): boolean {
    if (this.height !== other.height) return false;
    if (this.treasury !== other.treasury) return false;
    if (this.stateRoot() !== other.stateRoot()) return false;
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
