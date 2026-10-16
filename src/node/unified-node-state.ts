/**
 * 0.5.84 item 1: wiring of the unified state store (unified-state-store.ts) into a validator:
 * BFT kernel persistence, the certified-commit journal and a one-time migration from the
 * 0.5.81-0.5.83 files (bft-commit-log.jsonl, bft-kernel.json).
 *
 * Migration is idempotent: the legacy files are copied into ONE frame, then renamed to
 * *.migrated. A crash after the frame and before the rename leaves a non-empty store, so the
 * next open skips the copy and only finishes the renames.
 */
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { stableStringify, sha256Hex } from "../core/ed25519.ts";
import { BftConsensusKernel, type BftDomain, type BftKernelOptions, type BftValidator } from "./bft-consensus.ts";
import { BftDurableStateStore, legacyAnchorPath } from "./bft-durable-store.ts";
import { CommitLog } from "./certified-commit.ts";
import { UnifiedStateStore, type OpenOptions, type StoreContext, type StoreRecord } from "./unified-state-store.ts";
import { checkStartup, defaultAnchorPath, readAnchor, retireAnchor, writeAnchor, RETIRED, type ContinuityOptions, type StorePosition } from "./bft-store-continuity.ts";

export const LEGACY_COMMIT_LOG_FILE = "bft-commit-log.jsonl";
export const LEGACY_BFT_KERNEL_FILE = "bft-kernel.json";

export function validatorSetHash(validators: readonly BftValidator[]): string {
  return sha256Hex(stableStringify([...validators].map(v => ({ id: v.id, publicKeyHex: v.publicKeyHex })).sort((a, b) => a.id.localeCompare(b.id))));
}

export function storeContext(domain: BftDomain, validators: readonly BftValidator[]): StoreContext {
  return { networkId: domain.networkId, domainId: domain.domainId, validatorSetHash: validatorSetHash(validators) };
}

export type MigrationReport = { migrated: boolean; commits: number; bftState: boolean; renamed: string[] };

/** Copy legacy files into the unified store once (one atomic frame), then rename them. */
export function migrateLegacyState(stateDir: string, store: UnifiedStateStore, domain: BftDomain, validators: BftValidator[]): MigrationReport {
  const logPath = join(stateDir, LEGACY_COMMIT_LOG_FILE);
  const kernelPath = join(stateDir, LEGACY_BFT_KERNEL_FILE);
  const report: MigrationReport = { migrated: false, commits: 0, bftState: false, renamed: [] };
  const empty = store.frameSeq === 0;
  if (empty && (existsSync(logPath) || existsSync(kernelPath))) {
    const records: StoreRecord[] = [];
    if (existsSync(logPath)) {
      const legacy = new CommitLog(logPath); // verifies the hash chain, repairs a torn last line
      for (const entry of legacy.all()) records.push({ kind: "commit", entry });
      report.commits = legacy.all().length;
    }
    if (existsSync(kernelPath)) {
      const state = new BftDurableStateStore(kernelPath, domain, validators).load(); // checksum + context
      if (state) { records.push({ kind: "bft", state }); report.bftState = true; }
    }
    records.push({ kind: "migrated", from: [LEGACY_COMMIT_LOG_FILE, LEGACY_BFT_KERNEL_FILE].filter(f => existsSync(join(stateDir, f))) });
    store.append(records);
    report.migrated = true;
  }
  if (store.frameSeq > 0) {
    for (const p of [logPath, kernelPath]) if (existsSync(p)) { renameSync(p, p + ".migrated"); report.renamed.push(p); }
  }
  return report;
}

export type ContinuityState = {
  verdict: "ok" | "retired";
  anchorPath: string;
  /** Current (seq, hash) of the store. */
  position(): StorePosition;
  /** Callbacks run after each durable frame (peer attestation). */
  onDurable: Set<(p: StorePosition) => void>;
};
export type UnifiedValidatorState = { store: UnifiedStateStore; kernel: BftConsensusKernel; log: CommitLog; migration: MigrationReport; continuity: ContinuityState };

/**
 * Open the unified store in `stateDir`, migrate legacy files, and build the BFT kernel whose
 * safety state is persisted as frames of that store (before any vote signature is released).
 */
export function openUnifiedValidatorState(
  stateDir: string, domain: BftDomain, validators: BftValidator[], faultTolerance: number,
  options: BftKernelOptions = {}, storeOptions: OpenOptions = {}, continuityOptions: ContinuityOptions = {},
): UnifiedValidatorState {
  // 0.5.84 store continuity (A + B): check presence and freshness BEFORE anything is written.
  const anchorPath = continuityOptions.anchorPath ?? defaultAnchorPath(stateDir);
  const anchor = readAnchor(anchorPath);
  const exists = UnifiedStateStore.exists(stateDir) || existsSync(join(stateDir, LEGACY_COMMIT_LOG_FILE)) || existsSync(join(stateDir, LEGACY_BFT_KERNEL_FILE));
  // Nothing on disk: decide before opening (opening creates the WAL file).
  const earlyVerdict = exists ? null : checkStartup(false, anchor, null, continuityOptions, domain);
  let anchoring = false;
  const onDurable = new Set<(p: StorePosition) => void>();
  const userOnAppended = storeOptions.onAppended;
  const store = UnifiedStateStore.open(stateDir, storeContext(domain, validators), {
    ...storeOptions,
    onAppended: (seq, hash) => {
      userOnAppended?.(seq, hash);
      if (!anchoring) return;
      writeAnchor(anchorPath, { v: 1, networkId: domain.networkId, domainId: domain.domainId, validatorId: continuityOptions.validatorId ?? "", seq, hash });
      for (const f of onDurable) { try { f({ seq, hash }); } catch { /* attestation is best effort */ } }
    },
  });
  const position = (): StorePosition => ({ seq: store.frameSeq, hash: store.headHash });
  const verdict = earlyVerdict ?? checkStartup(true, anchor, UnifiedStateStore.exists(stateDir) ? position() : null, continuityOptions, domain);
  if (verdict === "retired") retireAnchor(anchorPath, domain, continuityOptions.validatorId);
  else anchoring = true;
  const legacyKernel = join(stateDir, LEGACY_BFT_KERNEL_FILE);
  if (verdict === "ok" && store.frameSeq === 0 && existsSync(legacyKernel)) {
    // Legacy file about to be migrated: it must not be older than its own (0.5.84 legacy) anchor.
    const legacyStore = new BftDurableStateStore(legacyKernel, domain, validators);
    legacyStore.load();
    checkStartup(true, readAnchor(legacyAnchorPath(legacyKernel)), legacyStore.position, {}, domain);
  }
  const migration = migrateLegacyState(stateDir, store, domain, validators);
  // Genesis start: write a first frame at once, so a crash before any vote still leaves a store.
  if (!exists) store.append([{ kind: "init", mode: verdict === "retired" ? "retire" : "genesis", validatorId: continuityOptions.validatorId ?? "" }]);
  // Compat: a store written before 0.5.84 has no anchor; anchor its current position once.
  if (anchoring && store.frameSeq > 0 && (!anchor || store.frameSeq > anchor.seq)) writeAnchor(anchorPath, { v: 1, networkId: domain.networkId, domainId: domain.domainId, validatorId: continuityOptions.validatorId ?? "", ...position() });
  const kernel = new BftConsensusKernel(domain, validators, faultTolerance, state => store.append([{ kind: "bft", state }]), options);
  if (store.bftState) kernel.loadState(store.bftState);
  if (verdict === "retired") kernel.suspendSigning(RETIRED);
  const log = CommitLog.unified(store);
  return { store, kernel, log, migration, continuity: { verdict, anchorPath, position, onDurable } };
}
