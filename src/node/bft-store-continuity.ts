/**
 * 0.5.84: BFT store continuity checks (experimental).
 *
 * A validator's refusal to sign two conflicting votes lives in its local safety state. That state
 * must not silently restart empty, or from an older copy, while the signing key stays the same.
 * This module provides three local, dependency-free checks:
 *
 *  A. Missing store: a validator refuses to start without its store (BFT_STORE_MISSING). The
 *     only exceptions are an explicit first start ("genesis": no anchor exists either) and an
 *     explicit re-key/rejoin ("retire": the identity starts watch-only and never signs again).
 *  B. Monotonic sequence plus hash chain: every durable write has a stateSeq and the hash of the
 *     write before it. A secondary anchor file, kept OUTSIDE the state directory by default,
 *     holds the last accepted (seq, hash). A store below the anchor, or at the anchor's seq with
 *     a different hash, is refused (BFT_STORE_STALE).
 *  C. Peer attestation: each validator signs (validatorId -> stateSeq, stateHash) after each
 *     durable write and sends it to its peers, which keep the highest one. At start the
 *     validator asks its peers. While fewer than 2f answers have arrived it does not sign.
 *     If any verified attestation is newer than its local state, it stays suspended
 *     (BFT_STORE_STALE) and must rejoin under a new identity.
 *
 * These checks are local and cooperative: they do not protect against an operator who deletes
 * the store, the anchor and every peer's attestation, nor against a modified binary. See
 * docs/STATE-PERSISTENCE-0.5.84.md (store continuity) for the residual items.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { signEd25519, stableStringify, verifyEd25519, type PrivateKeyLike } from "../core/ed25519.ts";

export type StoreAnchor = { v: 1; networkId: string; domainId: string; validatorId: string; seq: number; hash: string };
export type StorePosition = { seq: number; hash: string };
export type StartupMode = "existing" | "genesis" | "retire";
export type ContinuityOptions = {
  /** Explicit first start of a new identity (allowed only when neither store nor anchor exists). */
  init?: "genesis";
  /** Explicit re-key/rejoin: the identity is retired (watch-only, never signs). */
  rejoin?: "retire";
  /** Anchor file; defaults to `<stateDir>.bft-anchor.json` (a sibling of the state directory). */
  anchorPath?: string;
  /** Validator id written into the anchor and the attestations. */
  validatorId?: string;
};

export const RETIRED = "BFT_IDENTITY_RETIRED";
export const PENDING_PEER_CHECK = "BFT_SIGNING_PENDING_PEER_CHECK";

export function defaultAnchorPath(stateDir: string): string {
  return stateDir.replace(/[\\/]+$/, "") + ".bft-anchor.json";
}

/** Startup flags from the environment (validator processes): UEP_BFT_STORE_INIT=genesis, UEP_BFT_REJOIN=retire. */
export function continuityFromEnv(env: Record<string, string | undefined> = process.env): ContinuityOptions {
  const o: ContinuityOptions = {};
  if (env.UEP_BFT_STORE_INIT === "genesis") o.init = "genesis";
  else if (env.UEP_BFT_STORE_INIT) throw new Error("BFT_STORE_INIT_INVALID");
  if (env.UEP_BFT_REJOIN === "retire") o.rejoin = "retire";
  else if (env.UEP_BFT_REJOIN) throw new Error("BFT_REJOIN_INVALID");
  if (env.UEP_BFT_ANCHOR_PATH) o.anchorPath = env.UEP_BFT_ANCHOR_PATH;
  return o;
}

export function readAnchor(path: string): StoreAnchor | null {
  if (!existsSync(path)) return null;
  let a: StoreAnchor;
  try { a = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("BFT_STORE_ANCHOR_CORRUPT"); }
  if (!a || a.v !== 1 || !Number.isSafeInteger(a.seq) || a.seq < 0 || typeof a.hash !== "string") throw new Error("BFT_STORE_ANCHOR_CORRUPT");
  return a;
}

/** Atomic, fsynced replacement of the anchor (tmp + fsync + rename + directory fsync). */
export function writeAnchor(path: string, anchor: StoreAnchor): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, JSON.stringify(anchor)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { const d = openSync(dir, "r"); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* platform */ }
}

/**
 * Decide whether a store may be used. `storeExists` is whether any store file (current or legacy)
 * is present; `position` is the store's (seq, hash) after opening.
 * Returns "ok" (sign normally) or "retired" (watch-only); throws BFT_STORE_MISSING / BFT_STORE_STALE.
 */
export function checkStartup(storeExists: boolean, anchor: StoreAnchor | null, position: StorePosition | null, opts: ContinuityOptions, ctx: { networkId: string; domainId: string }): "ok" | "retired" {
  if (opts.rejoin === "retire") return "retired";
  if (anchor && (anchor.networkId !== ctx.networkId || anchor.domainId !== ctx.domainId)) throw new Error("BFT_STORE_ANCHOR_CONTEXT_MISMATCH");
  if (anchor && anchor.seq === RETIRED_SEQ) throw new Error("BFT_STORE_STALE: identity retired (rejoin with a new identity)");
  if (!storeExists) {
    if (opts.init === "genesis" && !anchor) return "ok";
    throw new Error("BFT_STORE_MISSING");
  }
  if (anchor && position) {
    if (position.seq < anchor.seq) throw new Error(`BFT_STORE_STALE: store seq ${position.seq} < anchor seq ${anchor.seq}`);
    if (position.seq === anchor.seq && position.hash !== anchor.hash) throw new Error("BFT_STORE_STALE: store hash differs from anchor at the same seq");
  }
  return "ok";
}

/**
 * Mark an identity as retired in its anchor: no later store can reach this seq, so any start without
 * the retire flag fails with BFT_STORE_STALE. Retirement is one-way; a new identity (new key and
 * validator-set change) is the only way back.
 */
export const RETIRED_SEQ = Number.MAX_SAFE_INTEGER;
export function retireAnchor(path: string, ctx: { networkId: string; domainId: string }, validatorId = ""): void {
  writeAnchor(path, { v: 1, networkId: ctx.networkId, domainId: ctx.domainId, validatorId, seq: RETIRED_SEQ, hash: "retired" });
}

// ---- C. peer attestation ---------------------------------------------------------------------

export type StateAttestationBody = { v: 1; networkId: string; domainId: string; validatorId: string; stateSeq: number; stateHash: string };
export type StateAttestation = StateAttestationBody & { signature: string };

const attestMessage = (b: StateAttestationBody) => `uep-bft-state-attest-v1:${stableStringify(b)}`;

export function signStateAttestation(body: StateAttestationBody, key: PrivateKeyLike): StateAttestation {
  return { ...body, signature: signEd25519(attestMessage(body), key) };
}

export function verifyStateAttestation(a: unknown, publicKeyHex: string, ctx: { networkId: string; domainId: string }): a is StateAttestation {
  const x = a as StateAttestation;
  if (!x || x.v !== 1 || x.networkId !== ctx.networkId || x.domainId !== ctx.domainId || typeof x.validatorId !== "string" ||
      !Number.isSafeInteger(x.stateSeq) || x.stateSeq < 0 || typeof x.stateHash !== "string" || typeof x.signature !== "string") return false;
  const { signature, ...body } = x;
  try { return verifyEd25519(attestMessage(body), signature, publicKeyHex); } catch { return false; }
}

/** Compare the local position with verified peer attestations of this validator. */
export function compareWithAttestations(local: StorePosition, attestations: readonly StateAttestation[]): { stale: boolean; maxSeen: number } {
  let stale = false, maxSeen = 0;
  for (const a of attestations) {
    maxSeen = Math.max(maxSeen, a.stateSeq);
    if (a.stateSeq > local.seq) stale = true;
    if (a.stateSeq === local.seq && a.stateHash !== local.hash) stale = true;
  }
  return { stale, maxSeen };
}

/** Peer-side registry: highest verified attestation per validator, persisted atomically. */
export class AttestationRegistry {
  private readonly byValidator = new Map<string, StateAttestation>();
  private readonly path: string | null;
  constructor(path: string | null) {
    this.path = path;
    if (path && existsSync(path)) {
      try { for (const a of JSON.parse(readFileSync(path, "utf8")) as StateAttestation[]) this.byValidator.set(a.validatorId, a); }
      catch { throw new Error("BFT_ATTESTATION_REGISTRY_CORRUPT"); }
    }
  }
  get(validatorId: string): StateAttestation | null { return this.byValidator.get(validatorId) ?? null; }
  /** Keep `a` if it is newer than the stored one; returns whether it was kept. */
  offer(a: StateAttestation): boolean {
    const cur = this.byValidator.get(a.validatorId);
    if (cur && cur.stateSeq >= a.stateSeq) return false;
    this.byValidator.set(a.validatorId, a);
    if (this.path) {
      const tmp = `${this.path}.tmp`;
      const fd = openSync(tmp, "w", 0o600);
      try { writeSync(fd, JSON.stringify([...this.byValidator.values()])); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, this.path);
    }
    return true;
  }
}

export const ATTESTATION_REGISTRY_FILE = "bft-peer-attestations.json";
export const attestationRegistryPath = (stateDir: string) => join(stateDir, ATTESTATION_REGISTRY_FILE);
