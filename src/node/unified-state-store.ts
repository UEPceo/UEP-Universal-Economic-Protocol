/**
 * 0.5.84 item 1: one durable, transactional backend for the certified state of a node:
 * the commit journal (certified-commit log entries), the BFT safety state and the economic
 * state head (height, state root, tx count, optional signed ledger snapshot).
 *
 * Layout in <stateDir>:
 *   uep-state.wal          append-only write-ahead log of frames (fsync per frame)
 *   uep-state.checkpoint   compacted view, replaced atomically (tmp + fsync + rename + dir fsync)
 *
 * Frame (binary, little endian):
 *   "UEPW" | u32 payloadLength | 32-byte SHA-256(domain || prevHash || payload) | payload (UTF-8 JSON)
 * payload = { v: 1, seq, prevHash, records: StoreRecord[] }
 *
 * A frame is the atomic unit: every record in it becomes visible together or not at all.
 * The certified committer writes the APPLIED journal entry, the post-apply economic head and the
 * BFT state in ONE frame, so after any interruption the three agree. Only the last frame can be
 * incomplete (torn); it is truncated at open. A bad checksum or a broken hash chain anywhere else
 * is corruption and the store refuses to open (no silent repair).
 *
 * Compaction writes a checkpoint holding the materialized view and the (seq, hash) of the last
 * frame it covers, then starts an empty WAL. Frames with seq <= checkpoint.seq are skipped at open,
 * so a crash between the two steps is harmless and opening twice gives the same view (idempotent).
 *
 * No external dependencies. This is a single-node store on a local filesystem that honours fsync
 * and rename; it is not a replicated database.
 */
import { closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { BftState } from "./bft-consensus.ts";
import type { CommitLogEntry } from "./certified-commit.ts";

export const UNIFIED_WAL_FILE = "uep-state.wal";
export const UNIFIED_CHECKPOINT_FILE = "uep-state.checkpoint";
export const UNIFIED_STORE_VERSION = 1;
const MAGIC = Buffer.from("UEPW", "ascii");
const HEADER = 4 + 4 + 32;
const MAX_FRAME = 64 * 1024 * 1024;
const GENESIS = "0".repeat(64);

export type EconomicHead = { height: number; stateRoot: string; txCount: number };
export type StoreRecord =
  | { kind: "commit"; entry: CommitLogEntry }
  | { kind: "bft"; state: BftState }
  | { kind: "economic"; head: EconomicHead }
  /** Signed ledger snapshot (UepLedger.snapshot()), JSON with {$b} bigints; optional, nodes holding snapshot keys only. */
  | { kind: "ledger-snapshot"; json: string; head: EconomicHead }
  | { kind: "migrated"; from: string[] }
  /** 0.5.84 item 2: last certified checkpoint built or accepted (certified-checkpoint.ts). */
  | { kind: "checkpoint"; checkpoint: unknown }
  /** 0.5.84 store continuity: explicit first start (genesis) or retirement of this identity. No view change. */
  | { kind: "init"; mode: "genesis" | "retire"; validatorId: string };

export type StoreContext = { networkId: string; domainId: string; validatorSetHash: string };

export type StoreView = {
  commits: CommitLogEntry[];
  bft: BftState | null;
  economic: EconomicHead | null;
  ledgerSnapshot: { json: string; head: EconomicHead } | null;
  migratedFrom: string[];
  checkpoint?: unknown;
};

type Frame = { v: 1; seq: number; prevHash: string; records: StoreRecord[] };
type Checkpoint = { v: 1; context: StoreContext; seq: number; headHash: string; view: StoreView; checksum: string };

/** Write points of the store (crash tests). */
export type StoreWritePoint = "frame-torn" | "after-frame" | "checkpoint-fsynced" | "checkpoint-written" | "wal-reset";

const sha = (...parts: (string | Buffer)[]) => { const h = createHash("sha256"); for (const p of parts) h.update(p); return h.digest(); };
const frameDigest = (prevHash: string, payload: Buffer) => sha("uep-unified-wal-v1:", prevHash, ":", payload);
const emptyView = (): StoreView => ({ commits: [], bft: null, economic: null, ledgerSnapshot: null, migratedFrom: [] });

function fsyncDir(dir: string): void {
  try { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* not supported on every platform */ }
}

function atomicWrite(path: string, data: string, beforeRename?: () => void): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  beforeRename?.();
  renameSync(tmp, path);
  fsyncDir(join(path, ".."));
}

export function applyRecord(view: StoreView, r: StoreRecord): void {
  switch (r.kind) {
    case "commit": view.commits.push(r.entry); break;
    case "bft": view.bft = r.state; break;
    case "economic": view.economic = r.head; break;
    case "ledger-snapshot": view.ledgerSnapshot = { json: r.json, head: r.head }; view.economic = r.head; break;
    case "migrated": view.migratedFrom.push(...r.from); break;
    case "checkpoint": view.checkpoint = r.checkpoint; break;
    case "init": break;
    default: throw new Error("UNIFIED_STORE_CORRUPT: unknown record kind");
  }
}

export type OpenOptions = {
  /** Compact automatically after this many frames (default 512; 0 disables). */
  autoCompactFrames?: number;
  /** Crash-test hook; throwing at "frame-torn" writes half a frame, then afterTornWrite runs, then the error propagates. */
  faultInjector?: (point: StoreWritePoint) => void;
  afterTornWrite?: () => void;
  /** Called after each durable frame with its (seq, hash): store-continuity anchor and peer attestation. */
  onAppended?: (seq: number, hash: string) => void;
};

export class UnifiedStateStore {
  readonly dir: string;
  readonly context: StoreContext;
  readonly walPath: string;
  readonly checkpointPath: string;
  /** Bytes dropped from a torn last frame at open (0 if none). */
  readonly repairedTornBytes: number = 0;
  private view: StoreView = emptyView();
  private seq = 0;
  private head = GENESIS;
  private framesSinceCheckpoint = 0;
  private readonly inject: (p: StoreWritePoint) => void;
  private readonly afterTorn?: () => void;
  private readonly autoCompact: number;
  private readonly onAppended?: (seq: number, hash: string) => void;

  private constructor(dir: string, context: StoreContext, opts: OpenOptions) {
    this.dir = dir;
    this.context = { ...context };
    this.walPath = join(dir, UNIFIED_WAL_FILE);
    this.checkpointPath = join(dir, UNIFIED_CHECKPOINT_FILE);
    this.inject = opts.faultInjector ?? (() => {});
    this.afterTorn = opts.afterTornWrite;
    this.autoCompact = opts.autoCompactFrames ?? 512;
    this.onAppended = opts.onAppended;
  }

  static exists(dir: string): boolean {
    return existsSync(join(dir, UNIFIED_WAL_FILE)) || existsSync(join(dir, UNIFIED_CHECKPOINT_FILE));
  }

  /** Open (or create) the store; verifies context, checkpoint checksum, every frame checksum and the hash chain. */
  static open(dir: string, context: StoreContext, opts: OpenOptions = {}): UnifiedStateStore {
    if (!dir || !context?.networkId || !context?.domainId || !context?.validatorSetHash) throw new Error("UNIFIED_STORE_CONFIG_INVALID");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const s = new UnifiedStateStore(dir, context, opts);
    s.loadCheckpoint();
    s.replayWal();
    return s;
  }

  private loadCheckpoint(): void {
    if (!existsSync(this.checkpointPath)) return;
    let cp: Checkpoint;
    try { cp = JSON.parse(readFileSync(this.checkpointPath, "utf8")); } catch { throw new Error("UNIFIED_STORE_CORRUPT: checkpoint is not JSON"); }
    const { checksum, ...rest } = cp;
    const want = sha("uep-unified-checkpoint-v1:", JSON.stringify(rest));
    const got = /^[0-9a-f]{64}$/.test(checksum ?? "") ? Buffer.from(checksum, "hex") : Buffer.alloc(0);
    if (cp.v !== 1 || got.length !== 32 || !timingSafeEqual(want, got)) throw new Error("UNIFIED_STORE_CORRUPT: checkpoint checksum");
    this.checkContext(cp.context);
    this.view = cp.view;
    this.seq = cp.seq;
    this.head = cp.headHash;
  }

  private checkContext(c: StoreContext): void {
    if (c.networkId !== this.context.networkId || c.domainId !== this.context.domainId || c.validatorSetHash !== this.context.validatorSetHash) {
      throw new Error("UNIFIED_STORE_CONTEXT_MISMATCH");
    }
  }

  private replayWal(): void {
    if (!existsSync(this.walPath)) {
      const fd = openSync(this.walPath, "wx", 0o600);
      try { writeSync(fd, this.walHeader()); fsyncSync(fd); } finally { closeSync(fd); }
      fsyncDir(this.dir);
      return;
    }
    const buf = readFileSync(this.walPath);
    const hdr = Buffer.from(this.walHeader());
    if (buf.length < hdr.length || !buf.subarray(0, hdr.length).equals(hdr)) {
      // A WAL header is written before any frame; anything else is a foreign or damaged file.
      if (buf.length < hdr.length && hdr.subarray(0, buf.length).equals(buf)) { this.truncate(0, buf.length); this.rewriteHeader(); return; }
      throw new Error("UNIFIED_STORE_CONTEXT_MISMATCH");
    }
    let off = hdr.length;
    while (off < buf.length) {
      const rest = buf.length - off;
      const torn = () => { this.truncate(off, rest); };
      if (rest < HEADER) { torn(); break; }
      if (!buf.subarray(off, off + 4).equals(MAGIC)) throw new Error(`UNIFIED_STORE_CORRUPT: bad frame magic at ${off}`);
      const len = buf.readUInt32LE(off + 4);
      if (len > MAX_FRAME) throw new Error(`UNIFIED_STORE_CORRUPT: frame too large at ${off}`);
      if (rest < HEADER + len) { torn(); break; }
      const digest = buf.subarray(off + 8, off + 40);
      const payload = buf.subarray(off + HEADER, off + HEADER + len);
      const isLast = off + HEADER + len === buf.length;
      let frame: Frame | null = null;
      try { frame = JSON.parse(payload.toString("utf8")); } catch { frame = null; }
      if (!frame || typeof frame.prevHash !== "string" || !Array.isArray(frame.records) || !timingSafeEqual(frameDigest(frame.prevHash, payload), digest)) {
        // The last frame may be complete in length but not in content (pages persisted out of order): torn.
        if (isLast) { torn(); break; }
        throw new Error(`UNIFIED_STORE_CORRUPT: frame checksum at ${off}`);
      }
      if (frame.seq <= this.seq) {
        // Already covered by the checkpoint (crash between checkpoint rename and WAL reset).
        off += HEADER + len; continue;
      }
      if (frame.v !== 1 || frame.seq !== this.seq + 1 || frame.prevHash !== this.head) {
        throw new Error(`UNIFIED_STORE_CORRUPT: hash chain broken at seq ${frame.seq}${isLast ? " (last frame)" : ""}`);
      }
      for (const r of frame.records) applyRecord(this.view, r);
      this.seq = frame.seq;
      this.head = digest.toString("hex");
      this.framesSinceCheckpoint++;
      off += HEADER + len;
    }
  }

  private walHeader(): string {
    return `UEP-UNIFIED-WAL v${UNIFIED_STORE_VERSION} ${JSON.stringify(this.context)}\n`;
  }

  private rewriteHeader(): void {
    const fd = openSync(this.walPath, "r+");
    try { writeSync(fd, this.walHeader(), 0); fsyncSync(fd); } finally { closeSync(fd); }
  }

  private truncate(at: number, dropped: number): void {
    const fd = openSync(this.walPath, "r+");
    try { ftruncateSync(fd, at); fsyncSync(fd); } finally { closeSync(fd); }
    (this as { repairedTornBytes: number }).repairedTornBytes = dropped;
  }

  /** Current materialized view (a deep copy). */
  snapshot(): StoreView { return structuredClone(this.view); }
  get commits(): readonly CommitLogEntry[] { return this.view.commits; }
  get bftState(): BftState | null { return this.view.bft; }
  get economicHead(): EconomicHead | null { return this.view.economic; }
  get headHash(): string { return this.head; }
  get checkpoint(): unknown { return this.view.checkpoint ?? null; }
  get frameSeq(): number { return this.seq; }

  /**
   * Append one atomic frame and fsync it. Returns only after the frame is durable; callers must not
   * report anything in `records` as final before this returns. `torn` simulates a crash mid-write.
   */
  append(records: StoreRecord[], opts: { torn?: boolean; afterTornWrite?: () => void } = {}): void {
    if (!records.length) return;
    const frame: Frame = { v: 1, seq: this.seq + 1, prevHash: this.head, records };
    const payload = Buffer.from(JSON.stringify(frame), "utf8");
    if (payload.length > MAX_FRAME) throw new Error("UNIFIED_STORE_FRAME_TOO_LARGE");
    const digest = frameDigest(this.head, payload);
    const header = Buffer.alloc(HEADER);
    MAGIC.copy(header, 0); header.writeUInt32LE(payload.length, 4); digest.copy(header, 8);
    const bytes = Buffer.concat([header, payload]);
    let torn = opts.torn === true;
    if (!torn) { try { this.inject("frame-torn"); } catch { torn = true; } }
    const fd = openSync(this.walPath, "a");
    try {
      if (torn) {
        writeSync(fd, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
        fsyncSync(fd);
        (opts.afterTornWrite ?? this.afterTorn)?.();
        throw new Error("CRASH_INJECTED: torn frame");
      }
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    for (const r of records) applyRecord(this.view, r);
    this.seq = frame.seq;
    this.head = digest.toString("hex");
    this.framesSinceCheckpoint++;
    this.inject("after-frame");
    this.onAppended?.(this.seq, this.head);
    if (this.autoCompact > 0 && this.framesSinceCheckpoint >= this.autoCompact) this.compact();
  }

  /** Frames written since the last checkpoint. */
  get pendingFrames(): number { return this.framesSinceCheckpoint; }

  /** Write a checkpoint of the current view, then start an empty WAL. Safe to interrupt at any point. */
  compact(): void {
    const body = { v: 1 as const, context: this.context, seq: this.seq, headHash: this.head, view: this.view };
    const checksum = sha("uep-unified-checkpoint-v1:", JSON.stringify(body)).toString("hex");
    atomicWrite(this.checkpointPath, JSON.stringify({ ...body, checksum }), () => this.inject("checkpoint-fsynced"));
    this.inject("checkpoint-written");
    atomicWrite(this.walPath, this.walHeader());
    this.inject("wal-reset");
    this.framesSinceCheckpoint = 0;
  }
}
