/**
 * Durable write-ahead store for the experimental UEP BFT safety kernel.
 *
 * The store is intentionally synchronous: the kernel calls save() before it
 * releases a vote signature or advances a safety lock/commit. Use a local
 * filesystem with atomic rename and fsync semantics. This is not a distributed
 * database and does not by itself make the BFT kernel production-ready.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { checkStartup, readAnchor, retireAnchor, writeAnchor, RETIRED, type ContinuityOptions, type StorePosition } from "./bft-store-continuity.ts";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { stableStringify, sha256Hex } from "../core/ed25519.ts";
import { BftConsensusKernel, type BftDomain, type BftState, type BftValidator, type BftKernelOptions } from "./bft-consensus.ts";

// 0.5.84: format 2 adds stateSeq (monotonic) and prevChecksum (hash chain). Format 1 files still load
// (as seq 0) and are rewritten as format 2 on the next save.
const FORMAT_VERSION = 2;
const MAX_STORE_BYTES = 32 * 1024 * 1024;

type StorePayload = {
  formatVersion: 1 | 2;
  networkId: string;
  domainId: string;
  validatorSetHash: string;
  stateSeq?: number;
  prevChecksum?: string;
  state: BftState;
};
export type DurableStoreFaultPoint = "fsynced-before-rename";
type StoreEnvelope = StorePayload & { checksum: string };

function validatorSetHash(validators: readonly BftValidator[]): string {
  return sha256Hex(stableStringify([...validators].map(v => ({ id: v.id, publicKeyHex: v.publicKeyHex })).sort((a, b) => a.id.localeCompare(b.id))));
}

export class BftDurableStateStore {
  readonly path: string;
  private readonly domain: BftDomain;
  private readonly validatorsHash: string;
  /** (seq, checksum) of the last loaded or saved envelope; null before the first load/save. */
  position: StorePosition | null = null;
  /** Called after each durable save (anchor update, peer attestation). */
  onSaved?: (position: StorePosition) => void;
  /** Crash-test hook (EXP-104). */
  faultInjector?: (point: DurableStoreFaultPoint) => void;

  constructor(path: string, domain: BftDomain, validators: readonly BftValidator[]) {
    if (!path || !domain?.networkId || !domain?.domainId || !validators.length) throw new Error("BFT_STORE_CONFIG_INVALID");
    this.path = path;
    this.domain = { networkId: domain.networkId, domainId: domain.domainId };
    this.validatorsHash = validatorSetHash(validators);
  }

  load(): BftState | null {
    if (!existsSync(this.path)) return null;
    let raw: string;
    try {
      const bytes = readFileSync(this.path);
      if (bytes.byteLength > MAX_STORE_BYTES) throw new Error("BFT_STORE_TOO_LARGE");
      raw = bytes.toString("utf8");
    } catch (error) {
      if (error instanceof Error && error.message === "BFT_STORE_TOO_LARGE") throw error;
      throw new Error("BFT_STORE_READ_FAILED", { cause: error });
    }

    let envelope: StoreEnvelope;
    try { envelope = JSON.parse(raw) as StoreEnvelope; }
    catch (error) { throw new Error("BFT_STORE_CORRUPT_JSON", { cause: error }); }
    if (!envelope || (envelope.formatVersion !== 1 && envelope.formatVersion !== 2) || typeof envelope.checksum !== "string" ||
        (envelope.formatVersion === 2 && (!Number.isSafeInteger(envelope.stateSeq) || (envelope.stateSeq as number) < 1 || typeof envelope.prevChecksum !== "string")) ||
        !envelope.state || envelope.networkId !== this.domain.networkId || envelope.domainId !== this.domain.domainId ||
        envelope.validatorSetHash !== this.validatorsHash) {
      throw new Error("BFT_STORE_CONTEXT_OR_FORMAT_MISMATCH");
    }
    const { checksum, ...payload } = envelope;
    const expected = sha256Hex(stableStringify(payload));
    const expectedBytes = Buffer.from(expected, "hex");
    const actualBytes = /^[0-9a-f]{64}$/.test(checksum) ? Buffer.from(checksum, "hex") : Buffer.alloc(0);
    if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) {
      throw new Error("BFT_STORE_CHECKSUM_MISMATCH");
    }
    this.position = { seq: envelope.formatVersion === 2 ? envelope.stateSeq! : 0, hash: checksum };
    return envelope.state;
  }

  /** Atomically replace the state and fsync both file and parent directory. */
  save(state: BftState): void {
    const payload: StorePayload = {
      formatVersion: FORMAT_VERSION,
      networkId: this.domain.networkId,
      domainId: this.domain.domainId,
      validatorSetHash: this.validatorsHash,
      stateSeq: (this.position?.seq ?? 0) + 1,
      prevChecksum: this.position?.hash ?? "",
      state,
    };
    const envelope: StoreEnvelope = { ...payload, checksum: sha256Hex(stableStringify(payload)) };
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tempPath = join(directory, `.${basename(this.path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(tempPath, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(envelope) + "\n", { encoding: "utf8" });
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      this.faultInjector?.("fsynced-before-rename");
      renameSync(tempPath, this.path);
      // Persist the rename itself where the platform supports directory fsync.
      let dirFd: number | undefined;
      try { dirFd = openSync(directory, "r"); fsyncSync(dirFd); }
      finally { if (dirFd !== undefined) closeSync(dirFd); }
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      try { unlinkSync(tempPath); } catch {}
      throw new Error("BFT_STORE_DURABLE_WRITE_FAILED", { cause: error });
    }
    this.position = { seq: payload.stateSeq!, hash: envelope.checksum };
    this.onSaved?.(this.position);
  }
}

/** Default anchor of a legacy store file: a sibling of its directory, named after directory and file. */
export function legacyAnchorPath(statePath: string): string {
  return `${dirname(statePath)}.${basename(statePath)}.bft-anchor.json`;
}

/**
 * Safe construction path: load and validate durable safety state before returning the kernel.
 * 0.5.84 store continuity: refuses a missing store (BFT_STORE_MISSING) unless `continuity.init`
 * is "genesis" and no anchor exists, or `continuity.rejoin` is "retire" (watch-only identity);
 * refuses a store older than its anchor (BFT_STORE_STALE). A format-1 store without an anchor is
 * accepted once (compat migration) and anchored.
 */
export function createDurableBftConsensusKernel(
  domain: BftDomain,
  validators: BftValidator[],
  faultTolerance: number,
  statePath: string,
  options: BftKernelOptions = {},
  continuity: ContinuityOptions = {},
): BftConsensusKernel {
  const store = new BftDurableStateStore(statePath, domain, validators);
  const anchorPath = continuity.anchorPath ?? legacyAnchorPath(statePath);
  const anchor = readAnchor(anchorPath);
  const exists = existsSync(statePath);
  const restored = exists ? store.load() : null;
  const verdict = checkStartup(exists, anchor, store.position, continuity, domain);
  const kernel = new BftConsensusKernel(domain, validators, faultTolerance, state => store.save(state), options);
  if (restored) kernel.loadState(restored);
  if (verdict === "retired") { retireAnchor(anchorPath, domain, continuity.validatorId); kernel.suspendSigning(RETIRED); return kernel; }
  const writeAnchorAt = (p: StorePosition) => writeAnchor(anchorPath, { v: 1, networkId: domain.networkId, domainId: domain.domainId, validatorId: continuity.validatorId ?? "", seq: p.seq, hash: p.hash });
  store.onSaved = writeAnchorAt;
  if (!exists) store.save(kernel.exportState()); // genesis: create the store (and anchor) at once
  else if (store.position && (!anchor || store.position.seq > anchor.seq)) writeAnchorAt(store.position);
  return kernel;
}
