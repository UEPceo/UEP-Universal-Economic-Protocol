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
import { randomBytes, timingSafeEqual } from "node:crypto";
import { stableStringify, sha256Hex } from "../core/ed25519.ts";
import { BftConsensusKernel, type BftDomain, type BftState, type BftValidator } from "./bft-consensus.ts";

const FORMAT_VERSION = 1;
const MAX_STORE_BYTES = 32 * 1024 * 1024;

type StorePayload = {
  formatVersion: 1;
  networkId: string;
  domainId: string;
  validatorSetHash: string;
  state: BftState;
};
type StoreEnvelope = StorePayload & { checksum: string };

function validatorSetHash(validators: readonly BftValidator[]): string {
  return sha256Hex(stableStringify([...validators].map(v => ({ id: v.id, publicKeyHex: v.publicKeyHex })).sort((a, b) => a.id.localeCompare(b.id))));
}

export class BftDurableStateStore {
  readonly path: string;
  private readonly domain: BftDomain;
  private readonly validatorsHash: string;

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
    if (!envelope || envelope.formatVersion !== FORMAT_VERSION || typeof envelope.checksum !== "string" ||
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
    return envelope.state;
  }

  /** Atomically replace the state and fsync both file and parent directory. */
  save(state: BftState): void {
    const payload: StorePayload = {
      formatVersion: FORMAT_VERSION,
      networkId: this.domain.networkId,
      domainId: this.domain.domainId,
      validatorSetHash: this.validatorsHash,
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
  }
}

/** Safe construction path: load and validate durable safety state before returning the kernel. */
export function createDurableBftConsensusKernel(
  domain: BftDomain,
  validators: BftValidator[],
  faultTolerance: number,
  statePath: string,
): BftConsensusKernel {
  const store = new BftDurableStateStore(statePath, domain, validators);
  const kernel = new BftConsensusKernel(domain, validators, faultTolerance, state => store.save(state));
  const restored = store.load();
  if (restored) kernel.loadState(restored);
  return kernel;
}
