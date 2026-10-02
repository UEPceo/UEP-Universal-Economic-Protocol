/**
 * UEP-30.3 — Engine snapshot + append-only journal.
 *
 * Lab/DEV may persist secrets for round-trip tests.
 * Production wallets MUST use includeSecrets:false and keep keys offline.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Fr } from "../core/field.ts";
import {
  ExecutionEngine,
  type EngineConfig,
  type AccountState,
  type SpendIntent,
} from "./execution-engine.ts";

export const SNAPSHOT_VERSION = 1;

export type JournalEntry =
  | { type: "enqueue"; seq: number; intent: SpendIntent; fee: string; ts: number }
  | { type: "commit"; seq: number; intentId: string; transitionId: string; newStateRoot?: string; ts: number }
  | { type: "reject"; seq: number; intentId: string; error: string; ts: number }
  | { type: "snapshot"; seq: number; path: string; ts: number };

export type EngineSnapshot = {
  version: number;
  savedAt: number;
  config: EngineConfig;
  stateRoot: string | null;
  nullifierRoot: string | null;
  treasuryBalance: string;
  treasuryId: string;
  assetId: string;
  intakeSeq: number;
  /** label → account (secrets optional) */
  accounts: Array<{
    label: string;
    id: string;
    secret?: string;
    salt?: string;
    blinding: string;
    balance: string;
    reserved: string;
  }>;
  stateLeaves: Array<[number, string]>;
  nullifiers: string[];
  transitionIds: string[];
  consumedPaymentKeys?: string[];
  pending: Array<{ intent: SpendIntent; fee: string; seq: number }>;
  journal?: JournalEntry[];
};

export type SnapshotOptions = {
  includeSecrets?: boolean;
  journal?: JournalEntry[];
};

export function exportSnapshot(
  eng: ExecutionEngine,
  opts: SnapshotOptions = {},
): EngineSnapshot {
  const includeSecrets = opts.includeSecrets === true;
  const accounts: EngineSnapshot["accounts"] = [];
  // Access via public API + reflection of registered labels through a helper
  const labels = eng.listAccountLabels();
  for (const label of labels) {
    const a = eng.getAccount(label);
    accounts.push({
      label,
      id: a.id.toHex(),
      ...(includeSecrets
        ? { secret: a.secret.toHex(), salt: a.salt.toHex() }
        : {}),
      blinding: a.blinding.toHex(),
      balance: a.balance.toString(),
      reserved: a.reserved.toString(),
    });
  }
  return {
    version: SNAPSHOT_VERSION,
    savedAt: Date.now(),
    config: { ...eng.config },
    stateRoot: eng.stateRoot,
    nullifierRoot: eng.nullifierRoot,
    treasuryBalance: eng.treasuryBalance.toString(),
    treasuryId: eng.treasuryId.toHex(),
    assetId: eng.assetId.toHex(),
    intakeSeq: eng.getIntakeSeq(),
    accounts,
    stateLeaves: eng.exportStateLeaves(),
    nullifiers: eng.exportNullifiers(),
    transitionIds: eng.exportTransitionIds(),
    consumedPaymentKeys: eng.exportConsumedPaymentKeys(),
    pending: eng.exportPending().map((p) => ({
      intent: p.intent,
      fee: p.fee.toString(),
      seq: p.seq,
    })),
    journal: opts.journal ? [...opts.journal] : undefined,
  };
}

export function writeSnapshotFile(
  filePath: string,
  eng: ExecutionEngine,
  opts: SnapshotOptions = {},
): EngineSnapshot {
  return writeSnapshotAtomic(filePath, eng, opts);
}

/** Atomic snapshot: write temp + fsync rename. */
export function writeSnapshotAtomic(
  filePath: string,
  eng: ExecutionEngine,
  opts: SnapshotOptions = {},
): EngineSnapshot {
  const snap = exportSnapshot(eng, opts);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp." + process.pid;
  const body = JSON.stringify(snap, null, 2);
  fs.writeFileSync(tmp, body);
  const fd = fs.openSync(tmp, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  return snap;
}

export function snapshotChecksum(snap: EngineSnapshot): string {
  const body = JSON.stringify(snap);
  return createHash("sha256").update(body).digest("hex");
}

export function readSnapshotFile(filePath: string): EngineSnapshot {
  const raw = fs.readFileSync(filePath, "utf8");
  const snap = JSON.parse(raw) as EngineSnapshot;
  if (snap.version !== SNAPSHOT_VERSION) {
    throw new Error(`unsupported snapshot version ${snap.version}`);
  }
  return snap;
}

/**
 * Rebuild engine from snapshot. Requires secrets in snapshot for ZK mode
 * (or structural-only recovery without prove).
 */
export function loadSnapshot(snap: EngineSnapshot): ExecutionEngine {
  const eng = new ExecutionEngine(snap.config);
  eng.treasuryId = new Fr(snap.treasuryId);
  eng.assetId = new Fr(snap.assetId);
  eng.treasuryBalance = BigInt(snap.treasuryBalance);
  eng.stateRoot = snap.stateRoot;
  eng.nullifierRoot = snap.nullifierRoot;
  eng.setIntakeSeq(snap.intakeSeq);

  for (const a of snap.accounts) {
    if (!a.secret || !a.salt) {
      // Structural account without spend capability
      eng.registerAccount(a.label, {
        id: new Fr(a.id),
        secret: Fr.from(0n),
        salt: Fr.from(0n),
        blinding: new Fr(a.blinding),
        balance: BigInt(a.balance),
      });
      eng.getAccount(a.label).reserved = BigInt(a.reserved);
      continue;
    }
    eng.registerAccount(a.label, {
      id: new Fr(a.id),
      secret: new Fr(a.secret),
      salt: new Fr(a.salt),
      blinding: new Fr(a.blinding),
      balance: BigInt(a.balance),
    });
    eng.getAccount(a.label).reserved = BigInt(a.reserved);
  }

  eng.importStateLeaves(snap.stateLeaves);
  eng.importNullifiers(snap.nullifiers);
  eng.importTransitionIds(snap.transitionIds);
  if (snap.consumedPaymentKeys) eng.importConsumedPaymentKeys(snap.consumedPaymentKeys);
  eng.importPending(
    snap.pending.map((p) => ({
      intent: p.intent,
      fee: BigInt(p.fee),
      seq: p.seq,
    })),
  );
  return eng;
}

export function loadSnapshotFile(filePath: string): ExecutionEngine {
  return loadSnapshot(readSnapshotFile(filePath));
}

/** Append-only journal file (one JSON object per line). */
function jsonSafe(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}

export function journalLineChecksum(lineBody: string): string {
  return createHash("sha256").update(lineBody, "utf8").digest("hex").slice(0, 16);
}

/** Append journal line with integrity prefix: <checksum> <json> */
export function appendJournalLine(filePath: string, entry: JournalEntry): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = jsonSafe(entry);
  const cs = journalLineChecksum(body);
  fs.appendFileSync(filePath, `${cs} ${body}\n`);
}

export function readJournal(filePath: string): JournalEntry[] {
  if (!fs.existsSync(filePath)) return [];
  const out: JournalEntry[] = [];
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    // New format: "<16hex> {json}"
    const sp = t.indexOf(" ");
    if (sp === 16 && /^[0-9a-f]{16}$/.test(t.slice(0, 16))) {
      const cs = t.slice(0, 16);
      const body = t.slice(17);
      if (journalLineChecksum(body) !== cs) {
        throw new Error("JOURNAL_CORRUPT: checksum mismatch");
      }
      out.push(JSON.parse(body) as JournalEntry);
    } else {
      // Legacy plain JSON line
      out.push(JSON.parse(t) as JournalEntry);
    }
  }
  return out;
}
