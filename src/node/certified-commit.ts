/**
 * H1 (0.5.81): durable certified-commit log and the single, idempotent
 * `applyCertifiedCommit()` state transition (ADR 0007).
 *
 * A BFT precommit certificate says "the validators decided block B at height H".
 * It is not the same thing as "the ledger applied B". This module keeps the two
 * apart and joins them in one serialized transition:
 *
 *   verify certificate (quorum, signatures, proposal signature)
 *   -> expected height and previous state root
 *   -> no prior spend (nullifiers) and full spend validation
 *   -> INTENT entry (fsync)        status CERTIFIED_NOT_APPLIED
 *   -> ledger.submit(tx)           economic transition
 *   -> APPLIED entry (fsync)       status APPLIED, stores the result
 *   -> kernel.recordCommit(cert)
 *
 * The log is append-only, one JSON entry per line, each entry hash-chained to
 * the previous one and fsync'd before the call returns. A crash at any write
 * point leaves either nothing, an INTENT without APPLIED, or a torn last line;
 * `recover()` finishes the commit (roll forward, the certificate is final) or,
 * when the transaction can no longer apply deterministically, appends ABORTED
 * and leaves the ledger untouched. No partial state is ever reported as applied.
 *
 * Heights here are BFT commit heights. They come from the log (last decided
 * height + 1), or from `ledger.height` when the log is empty, so they never read
 * a clock. No external dependencies.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, ftruncateSync, writeSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sha256Hex, stableStringify } from "../core/ed25519.ts";
import { deserializeTx, serializeTx, txNullifiers, type UepTransaction } from "../core/transaction.ts";
import type { UepLedger } from "../testnet/ledger.ts";
import type { BftCertificate, BftConsensusKernel, BftProposal } from "./bft-consensus.ts";

export type WireTx = Parameters<typeof deserializeTx>[0];
export type CommitStatus = "UNKNOWN" | "CERTIFIED_NOT_APPLIED" | "APPLIED" | "ABORTED";
export type CommitEntryType = "INTENT" | "APPLIED" | "ABORTED";
export const COMMIT_LOG_VERSION = 1;
export const COMMIT_LOG_GENESIS = "0".repeat(64);

/** Points where a write happens; a fault injector may throw at any of them (crash tests). */
export type CommitWritePoint =
  | "before-intent" | "intent-torn" | "after-intent"
  | "after-apply" | "applied-torn" | "after-applied" | "after-kernel-commit";

export type CommitResult = {
  status: "APPLIED";
  height: number;
  round: number;
  blockId: string;
  certHash: string;
  txId: string;
  preRoot: string;
  /** null only for a height migrated from the 0.5.80 journal whose post-root can no longer be observed. */
  postRoot: string | null;
  /** Item 5: the asset registry (version, hash) the transition was applied under; null without a registry. */
  registry?: { version: number; hash: string } | null;
};

export type CommitLogEntry = {
  v: 1;
  seq: number;
  type: CommitEntryType;
  height: number;
  round: number;
  blockId: string;
  certHash: string;
  preRoot: string;
  postRoot: string | null;
  result: CommitResult | { status: "ABORTED"; reason: string } | null;
  /** INTENT only: everything needed to re-apply after a crash. */
  proposal?: BftProposal;
  proposalSignature?: string;
  certificate?: BftCertificate;
  tx?: WireTx;
  /** Set on entries migrated from the 0.5.80 JSON journal. */
  migratedFrom?: "bft-commit-journal-v1";
  prevHash: string;
  hash: string;
};

const encode = (_k: string, v: unknown) => typeof v === "bigint" ? { $b: v.toString() } : v;
const decode = (_k: string, v: unknown) => v && typeof v === "object" && "$b" in v && typeof (v as { $b: unknown }).$b === "string" ? BigInt((v as { $b: string }).$b) : v;
export const txToWire = (tx: UepTransaction): WireTx => JSON.parse(JSON.stringify(serializeTx(tx), encode)) as WireTx;
export const txFromWire = (wire: WireTx): UepTransaction => deserializeTx(JSON.parse(JSON.stringify(wire), decode) as WireTx);

export function certificateHash(certificate: BftCertificate): string {
  return sha256Hex(`uep-bft-certificate-v1:${stableStringify(certificate)}`);
}

function entryHash(entry: Omit<CommitLogEntry, "hash">): string {
  return sha256Hex(`uep-commit-log-v1:${stableStringify(entry)}`);
}

/** Append-only, hash-chained, fsync'd commit log (one JSON entry per line). */
export class CommitLog {
  /** null: in-memory log (no state directory; nothing survives a restart). */
  readonly path: string | null;
  private entries: CommitLogEntry[] = [];
  /** Bytes dropped from a torn last line at open (0 if none). */
  readonly repairedTornBytes: number = 0;

  constructor(path: string | null) {
    this.path = path;
    if (path === null) return;
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) {
      const fd = openSync(path, "wx", 0o600);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      fsyncDir(dirname(path));
      return;
    }
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n");
    const complete = raw.endsWith("\n") || raw.length === 0;
    // A crash during append can only leave the last line incomplete (no newline).
    const tail = complete ? "" : lines.pop()!;
    if (complete) lines.pop();
    let prev = COMMIT_LOG_GENESIS;
    for (const [i, line] of lines.entries()) {
      let entry: CommitLogEntry;
      try { entry = JSON.parse(line); } catch { throw new Error(`COMMIT_LOG_CORRUPT: entry ${i} is not JSON`); }
      const { hash, ...rest } = entry;
      if (entry.v !== 1 || entry.seq !== i || entry.prevHash !== prev || entryHash(rest) !== hash) {
        throw new Error(`COMMIT_LOG_CORRUPT: entry ${i} breaks the hash chain`);
      }
      prev = hash;
      this.entries.push(entry);
    }
    if (tail.length) {
      const fd = openSync(path, "r+");
      try { ftruncateSync(fd, Buffer.byteLength(raw) - Buffer.byteLength(tail)); fsyncSync(fd); } finally { closeSync(fd); }
      this.repairedTornBytes = Buffer.byteLength(tail);
    }
    this.checkStructure();
  }

  all(): readonly CommitLogEntry[] { return this.entries; }
  get headHash(): string { return this.entries.at(-1)?.hash ?? COMMIT_LOG_GENESIS; }

  append(fields: Omit<CommitLogEntry, "v" | "seq" | "prevHash" | "hash">, torn = false): CommitLogEntry {
    const base = { v: 1 as const, seq: this.entries.length, ...fields, prevHash: this.headHash };
    const entry: CommitLogEntry = { ...base, hash: entryHash(base) };
    const line = JSON.stringify(entry) + "\n";
    if (this.path === null) {
      if (torn) throw new Error("CRASH_INJECTED: torn write");
      this.entries.push(entry);
      return entry;
    }
    const fd = openSync(this.path, "a");
    try {
      if (torn) {
        // Crash simulation: half a line reaches the disk, then the process dies.
        writeSync(fd, line.slice(0, Math.max(1, Math.floor(line.length / 2))));
        fsyncSync(fd);
        throw new Error("CRASH_INJECTED: torn write");
      }
      writeSync(fd, line);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    this.entries.push(entry);
    return entry;
  }

  /** Per height: INTENT first, then at most one APPLIED or ABORTED; heights strictly increase. */
  private checkStructure(): void {
    let lastHeight = 0;
    const open = new Map<number, CommitLogEntry>();
    const done = new Set<number>();
    for (const e of this.entries) {
      if (e.type === "INTENT") {
        if (e.height <= lastHeight || open.size || !e.proposal || !e.certificate || !e.tx || typeof e.proposalSignature !== "string") {
          throw new Error(`COMMIT_LOG_CORRUPT: unexpected INTENT at height ${e.height}`);
        }
        lastHeight = e.height; open.set(e.height, e);
      } else {
        const intent = open.get(e.height);
        if (!intent || done.has(e.height) || intent.blockId !== e.blockId || intent.certHash !== e.certHash) {
          throw new Error(`COMMIT_LOG_CORRUPT: ${e.type} without matching INTENT at height ${e.height}`);
        }
        open.delete(e.height); done.add(e.height);
      }
    }
  }
}

function fsyncDir(dir: string): void {
  try { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* not supported on every platform */ }
}

export type CertifiedCommitInput = { proposal: BftProposal; proposalSignature: string; certificate: BftCertificate; tx: UepTransaction };

export type CommitterOptions = {
  /** Crash-test hook: called at every write point; throwing there simulates a crash. */
  faultInjector?: (point: CommitWritePoint) => void;
};

export class CertifiedCommitter {
  readonly log: CommitLog;
  private readonly kernel: BftConsensusKernel;
  private readonly getLedger: () => UepLedger;
  private readonly inject: (point: CommitWritePoint) => void;

  constructor(log: CommitLog, kernel: BftConsensusKernel, getLedger: () => UepLedger, opts: CommitterOptions = {}) {
    this.log = log;
    this.kernel = kernel;
    this.getLedger = getLedger;
    this.inject = opts.faultInjector ?? (() => {});
  }

  /** Status of a BFT height in the commit log. A certificate alone never reads as APPLIED. */
  status(height: number): CommitStatus {
    let s: CommitStatus = "UNKNOWN";
    for (const e of this.log.all()) if (e.height === height) s = e.type === "INTENT" ? "CERTIFIED_NOT_APPLIED" : e.type;
    return s;
  }

  /** Stored result for a height, if APPLIED. */
  result(height: number): CommitResult | undefined {
    const e = this.log.all().find(x => x.height === height && x.type === "APPLIED");
    return e?.result as CommitResult | undefined;
  }

  /** Heights with a durable INTENT but no APPLIED/ABORTED yet. */
  pending(): number[] {
    return this.log.all().filter(e => e.type === "INTENT" && this.status(e.height) === "CERTIFIED_NOT_APPLIED").map(e => e.height);
  }

  /** Last decided (applied or aborted) BFT height, or the ledger height when the log is empty. */
  lastDecidedHeight(): number {
    const decided = this.log.all().filter(e => e.type !== "INTENT");
    return decided.length ? decided.at(-1)!.height : this.getLedger().height;
  }

  expectedHeight(): number { return this.lastDecidedHeight() + 1; }

  /** Root the next commit must build on: the last APPLIED post-root, or the live ledger root when nothing applied yet. */
  expectedParentRoot(): string {
    const applied = this.log.all().filter(e => e.type === "APPLIED");
    return applied.at(-1)?.postRoot ?? this.getLedger().stateRoot().toHex();
  }

  /**
   * The single certified state transition. Idempotent: the same decided block
   * at the same height returns the stored result without touching balances; a
   * different block at a decided height is BFT_COMMIT_CONFLICT.
   */
  applyCertifiedCommit(input: CertifiedCommitInput): CommitResult {
    const { proposal, proposalSignature, certificate, tx } = input;
    this.verify(proposal, proposalSignature, certificate, tx);
    const certHash = certificateHash(certificate);

    const existing = this.log.all().filter(e => e.height === proposal.height);
    if (existing.length) {
      const intent = existing[0]!;
      if (intent.blockId !== proposal.blockId) throw new Error("BFT_COMMIT_CONFLICT");
      const final = existing.find(e => e.type !== "INTENT");
      if (final?.type === "APPLIED") {
        this.kernel.recordCommit(intent.certificate!);
        return structuredClone(final.result as CommitResult);
      }
      if (final?.type === "ABORTED") throw new Error(`BFT_COMMIT_ABORTED: ${(final.result as { reason: string }).reason}`);
      return this.finish(intent); // certified, not yet applied: finish it
    }

    const ledger = this.getLedger();
    if (proposal.height !== this.expectedHeight()) throw new Error("BFT_HEIGHT_MISMATCH");
    this.checkRegistry(ledger);
    const preRoot = ledger.stateRoot().toHex();
    if (proposal.parentRoot !== preRoot || preRoot !== this.expectedParentRoot()) throw new Error("BFT_PARENT_STATE_MISMATCH");
    this.checkSpend(ledger, tx);

    this.inject("before-intent");
    const intent = this.log.append({
      type: "INTENT", height: proposal.height, round: proposal.round, blockId: proposal.blockId, certHash,
      preRoot, postRoot: null, result: null,
      proposal: structuredClone(proposal), proposalSignature, certificate: structuredClone(certificate), tx: txToWire(tx),
    }, this.injectTorn("intent-torn"));
    this.inject("after-intent");
    return this.finish(intent);
  }

  /**
   * After a restart: verify the log against the restored ledger, then finish
   * every certified-not-applied height in order. Returns how many heights were
   * (re)applied to the ledger. `ledger` may be an older snapshot: APPLIED
   * heights missing from it are re-applied from the log, checking each root.
   */
  recover(): { reapplied: number; finished: number; aborted: number } {
    let reapplied = 0, finished = 0, aborted = 0;
    const intents = this.log.all().filter(e => e.type === "INTENT");
    for (const intent of intents) {
      this.verifyIntent(intent);
      const ledger = this.getLedger();
      const st = this.status(intent.height);
      const inLedger = ledgerHasTx(ledger, intent.blockId);
      if (st === "APPLIED") {
        if (!inLedger) {
          const res = this.result(intent.height)!;
          if (ledger.stateRoot().toHex() !== intent.preRoot) throw new Error(`BFT_RECOVERY_DIVERGED: height ${intent.height}`);
          const r = ledger.submit(txFromWire(intent.tx!));
          if ("error" in r) throw new Error(`BFT_RECOVERY_DIVERGED: height ${intent.height}: ${r.error.code}`);
          if (res.postRoot && ledger.stateRoot().toHex() !== res.postRoot) throw new Error(`BFT_RECOVERY_DIVERGED: height ${intent.height} post-root`);
          reapplied++;
        }
        this.kernel.recordCommit(intent.certificate!);
      } else if (st === "CERTIFIED_NOT_APPLIED") {
        const before = ledgerHasTx(ledger, intent.blockId);
        const out = this.finishOrAbort(intent);
        if (out === "aborted") aborted++; else { finished++; if (!before) reapplied++; }
      }
    }
    return { reapplied, finished, aborted };
  }

  private finishOrAbort(intent: CommitLogEntry): "finished" | "aborted" {
    try { this.finish(intent); return "finished"; } catch (e) {
      const msg = (e as Error).message;
      if (!msg.startsWith("BFT_APPLY_REJECTED")) throw e;
      return "aborted";
    }
  }

  /** Complete a durable INTENT: apply (unless the exact tx is already the ledger head), then APPLIED, then kernel commit. */
  private finish(intent: CommitLogEntry): CommitResult {
    const ledger = this.getLedger();
    const tx = txFromWire(intent.tx!);
    if (!ledgerHasTx(ledger, intent.blockId)) {
      if (ledger.stateRoot().toHex() !== intent.preRoot) {
        this.abort(intent, "PARENT_STATE_MISMATCH");
        throw new Error("BFT_APPLY_REJECTED: PARENT_STATE_MISMATCH");
      }
      const r = ledger.submit(tx);
      if ("error" in r) {
        this.abort(intent, r.error.code);
        throw new Error(`BFT_APPLY_REJECTED: ${r.error.code}`);
      }
      this.inject("after-apply");
    } else if (lastTxId(ledger) !== intent.blockId && intent.migratedFrom === undefined) {
      // Present but not the head: the post-root of this height cannot be observed any more.
      throw new Error(`BFT_RECOVERY_DIVERGED: height ${intent.height} is not the ledger head`);
    }
    const observable = lastTxId(ledger) === intent.blockId;
    const result: CommitResult = {
      status: "APPLIED", height: intent.height, round: intent.round, blockId: intent.blockId, certHash: intent.certHash,
      txId: tx.txId.toHex(), preRoot: intent.preRoot, postRoot: observable ? ledger.stateRoot().toHex() : null,
      registry: registryOf(ledger),
    };
    this.log.append({ type: "APPLIED", height: intent.height, round: intent.round, blockId: intent.blockId, certHash: intent.certHash,
      preRoot: intent.preRoot, postRoot: result.postRoot, result }, this.injectTorn("applied-torn"));
    this.inject("after-applied");
    this.kernel.recordCommit(intent.certificate!);
    this.inject("after-kernel-commit");
    return structuredClone(result);
  }

  /**
   * Item 5: the registry may only move forward. A ledger with no registry after one was used, an older
   * version, or another manifest at the same version is BFT_REGISTRY_REGRESSION (the node refuses to apply).
   */
  private checkRegistry(ledger: UepLedger): void {
    const last = [...this.log.all()].reverse().find(e => e.type === "APPLIED" && (e.result as CommitResult | null)?.registry !== undefined);
    const prev = (last?.result as CommitResult | undefined)?.registry ?? null;
    if (!prev) return;
    const now = registryOf(ledger);
    if (!now || now.version < prev.version || (now.version === prev.version && now.hash !== prev.hash)) throw new Error("BFT_REGISTRY_REGRESSION");
  }

  private abort(intent: CommitLogEntry, reason: string): void {
    this.log.append({ type: "ABORTED", height: intent.height, round: intent.round, blockId: intent.blockId, certHash: intent.certHash,
      preRoot: intent.preRoot, postRoot: null, result: { status: "ABORTED", reason } });
  }

  private injectTorn(point: CommitWritePoint): boolean {
    try { this.inject(point); return false; } catch { return true; }
  }

  private verify(proposal: BftProposal, proposalSignature: string, certificate: BftCertificate, tx: UepTransaction): void {
    const k = this.kernel;
    if (!certificate || certificate.phase !== "precommit" || certificate.height !== proposal.height || certificate.round !== proposal.round ||
        certificate.blockId !== proposal.blockId || !k.verifyCertificate(certificate)) throw new Error("BFT_COMMIT_CERTIFICATE_INVALID");
    if (!k.verifyProposal(proposal, proposalSignature)) throw new Error("BFT_COMMIT_PROPOSAL_SIGNATURE_INVALID");
    if (proposal.blockId !== tx.txId.toHex()) throw new Error("BFT_TX_ID_MISMATCH");
  }

  private verifyIntent(intent: CommitLogEntry): void {
    const tx = txFromWire(intent.tx!);
    this.verify(intent.proposal!, intent.proposalSignature!, intent.certificate!, tx);
    if (intent.migratedFrom === undefined && certificateHash(intent.certificate!) !== intent.certHash) throw new Error("COMMIT_LOG_CORRUPT: certificate hash");
  }

  private checkSpend(ledger: UepLedger, tx: UepTransaction): void {
    if (ledgerHasTx(ledger, tx.txId.toHex())) throw new Error("BFT_TX_ALREADY_APPLIED");
    if (txNullifiers(tx).some(nf => ledger.hasCommittedNullifier(nf))) throw new Error("NULLIFIER_SPENT");
    const checked = ledger.validateSpend(tx);
    if ("error" in checked) throw new Error(checked.error.code);
  }
}

function registryOf(ledger: UepLedger): { version: number; hash: string } | null {
  const b = ledger.assetRegistryBinding();
  return b ? { version: b.version, hash: b.hash } : null;
}

function ledgerHasTx(ledger: UepLedger, txId: string): boolean {
  return ledger.txs.some(t => t.txId.toHex() === txId);
}
function lastTxId(ledger: UepLedger): string | undefined {
  return ledger.txs.at(-1)?.txId.toHex();
}

/**
 * Migration shim: the 0.5.80 JSON journal (`bft-commit-journal.json`, version 1)
 * becomes INTENT entries of the commit log. Applied flags are not trusted as
 * results (the journal stored no post-root); recover() re-establishes them
 * against the restored ledger. Returns the number of migrated records.
 */
export function migrateJournalV1(journalPath: string, log: CommitLog): number {
  if (!existsSync(journalPath) || log.all().length) return 0;
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  if (journal?.version !== 1 || !Array.isArray(journal.records)) throw new Error("BFT_JOURNAL_INVALID");
  const records = [...journal.records].sort((a, b) => a.proposal.height - b.proposal.height);
  for (const r of records) {
    log.append({ type: "INTENT", height: r.proposal.height, round: r.proposal.round, blockId: r.proposal.blockId,
      certHash: certificateHash(r.certificate), preRoot: r.proposal.parentRoot, postRoot: null, result: null,
      proposal: r.proposal, proposalSignature: r.proposalSignature, certificate: r.certificate, tx: r.tx, migratedFrom: "bft-commit-journal-v1" });
  }
  return records.length;
}
