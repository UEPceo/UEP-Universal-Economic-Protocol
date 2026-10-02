/**
 * UEP-37.3 — Poseidon note leaves via uep-zk (real BN254).
 * Caches results; fails hard if binary missing when mode requires it.
 */
import { createHash } from "node:crypto";
import { Fr } from "../core/field.ts";
import { zkNoteCommit, padFrHex, runUepZk } from "./uep-zk-runner.ts";
import { findUepZkBinary } from "./zk-bridge.ts";
import {
  CANONICAL_ASSET_ID,
  LAB_ZERO_BLINDING,
  accountIndex,
  CANONICAL_SMT_DEPTH,
} from "./uep37-leaf-encoding.ts";

const cache = new Map<string, string>();

function cacheKey(
  owner: string,
  asset: string,
  amount: string,
  blinding: string,
): string {
  return [padFrHex(owner), padFrHex(asset), padFrHex(amount), padFrHex(blinding)].join("|");
}

export function requireUepZk(): void {
  if (!findUepZkBinary()) {
    throw new Error(
      "UEP-37.3: uep-zk required for poseidon-zk leaves (run `npm run build:uep-zk` or set UEP_ZK_BIN)",
    );
  }
}

/** Poseidon note_commitment hex (64). Throws if uep-zk fails. */
export function poseidonNoteLeaf(
  owner: Fr,
  amount: bigint,
  blinding: Fr = LAB_ZERO_BLINDING,
  asset: Fr = CANONICAL_ASSET_ID,
): string {
  requireUepZk();
  const o = owner.toHex();
  const a = asset.toHex();
  const amt = Fr.from(amount).toHex();
  const b = blinding.toHex();
  const k = cacheKey(o, a, amt, b);
  const hit = cache.get(k);
  if (hit) return hit;
  const leaf = zkNoteCommit(o, a, amt, b);
  if (!leaf) {
    throw new Error(`uep-zk note-commit failed for owner=${o} amount=${amount}`);
  }
  cache.set(k, leaf);
  return leaf;
}

export function poseidonNoteLeafFr(
  owner: Fr,
  amount: bigint,
  blinding?: Fr,
  asset?: Fr,
): Fr {
  return Fr.from("0x" + poseidonNoteLeaf(owner, amount, blinding, asset));
}

/** Canonical digest of Poseidon leaf set (until Poseidon SMT root is in binary). */
export function poseidonLeafSetDigest(
  entries: Array<{ index: bigint; leafHex: string }>,
): string {
  const sorted = [...entries].sort((a, b) =>
    a.index < b.index ? -1 : a.index > b.index ? 1 : 0,
  );
  const h = createHash("sha256");
  h.update("UEP-37.3-POSEIDON-LEAF-SET|");
  for (const e of sorted) {
    h.update(e.index.toString());
    h.update(":");
    h.update(e.leafHex.toLowerCase().padStart(64, "0"));
    h.update("|");
  }
  return h.digest("hex");
}

export function clearPoseidonLeafCache(): void {
  cache.clear();
}

export type StateWitnessJson = {
  depth: number;
  index: string;
  leaf: string;
  root: string;
  siblings: string[];
  indexBits: boolean[];
  /** How root was computed */
  rootKind: "structural-smt" | "poseidon-smt-root" | "poseidon-leaf-set-digest";
};

/**
 * Build a structural (TS hash backend) membership witness for a leaf at index.
 * Path uses SparseMerkleTree from smt.ts — NOT Poseidon H_MERKLE until smt-root ships.
 */
export function verifyStructuralWitness(w: StateWitnessJson): boolean {
  if (w.siblings.length !== w.depth || w.indexBits.length !== w.depth) return false;
  const idx = BigInt(w.index);
  for (let i = 0; i < w.depth; i++) {
    const bit = ((idx >> BigInt(i)) & 1n) === 1n;
    if (w.indexBits[i] !== bit) return false;
  }
  return true;
}

export function ownerIndex(owner: Fr, depth: number = CANONICAL_SMT_DEPTH): bigint {
  return accountIndex(owner, depth);
}

/** low-bits via uep-zk for cross-check */
export function zkLowBits(valueHex: string, depth: number): number {
  requireUepZk();
  const r = runUepZk(["low-bits", padFrHex(valueHex), String(depth)]);
  if (!r.ok) throw new Error(r.stderr || "low-bits failed");
  const m = r.stdout.match(/index=(\d+)/);
  if (!m) throw new Error("low-bits parse");
  return Number(m[1]);
}
