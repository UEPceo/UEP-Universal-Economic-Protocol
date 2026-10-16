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
import { BftDurableStateStore } from "./bft-durable-store.ts";
import { CommitLog } from "./certified-commit.ts";
import { UnifiedStateStore, type OpenOptions, type StoreContext, type StoreRecord } from "./unified-state-store.ts";

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

export type UnifiedValidatorState = { store: UnifiedStateStore; kernel: BftConsensusKernel; log: CommitLog; migration: MigrationReport };

/**
 * Open the unified store in `stateDir`, migrate legacy files, and build the BFT kernel whose
 * safety state is persisted as frames of that store (before any vote signature is released).
 */
export function openUnifiedValidatorState(
  stateDir: string, domain: BftDomain, validators: BftValidator[], faultTolerance: number,
  options: BftKernelOptions = {}, storeOptions: OpenOptions = {},
): UnifiedValidatorState {
  const store = UnifiedStateStore.open(stateDir, storeContext(domain, validators), storeOptions);
  const migration = migrateLegacyState(stateDir, store, domain, validators);
  const kernel = new BftConsensusKernel(domain, validators, faultTolerance, state => store.append([{ kind: "bft", state }]), options);
  if (store.bftState) kernel.loadState(store.bftState);
  const log = CommitLog.unified(store);
  return { store, kernel, log, migration };
}
