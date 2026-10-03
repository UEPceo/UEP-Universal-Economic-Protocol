/**
 * UEP-37.1 — Frozen leaf / nullifier encoding for consensus SMT.
 *
 * Canonical composition (matches uep-26-spend-circuit/hash_gadget.rs):
 *
 *   note_commitment(owner, asset, amount, blinding) =
 *     H_LEAF( H_LEAF( owner, H_LEAF(asset, amount) ), blinding )
 *
 *   note_nonce(commitment, blinding) = H_LEAF(commitment, blinding)
 *   nullifier(secret, nonce)         = H_NULLIFIER(secret, nonce)
 *
 *   state key     = H_ACCOUNT(ownerId, assetId)   // one leaf per (account, asset)
 *   state index   = lowBits(state key, DEPTH)     // DEPTH canonical = 32
 *
 * The truncated index can collide (birthday bound at D=32); a collision is
 * rejected (SMT_INDEX_COLLISION), never resolved by overwriting a leaf.
 *
 * Hash permutation:
 *   - Circuit: Poseidon BN254 t=3 α=5 (UepPoseidon / uep-zk)
 *   - TypeScript core: the same Poseidon BN254 (src/core/poseidon.ts, snapshot format 6),
 *     so pure-TS leaves are bit-identical to the circuit's (checked in uep37.1/uep37.2).
 */

import { Fr } from "../core/field.ts";
import { hAccount, hLeaf, hNullifier, getHashBackend } from "../core/hash.ts";

/** Production SMT depth (SpendCircuit / StateWitness). */
export const CANONICAL_SMT_DEPTH = 32 as const;

/** Fast fixture depth for unit tests only — never for production config. */
export const TEST_ONLY_SMT_DEPTH = 16 as const;

export const LEAF_ENCODING_VERSION = "37.1";

/** Fixed asset id used by lab economic state (Fr(1)). */
export const CANONICAL_ASSET_ID = Fr.from(1n);

/**
 * Lab accounts without real spend secrets use blinding = 0.
 * Real notes from SpendCircuit must use the note's actual blinding.
 */
export const LAB_ZERO_BLINDING = Fr.zero();

export type HashBackendKind = "uep25-placeholder" | "public-sha256-field" | "poseidon-bn254" | "unknown";

export function activeHashBackendKind(): HashBackendKind {
  const name = getHashBackend().name;
  if (name.includes("poseidon") && !name.includes("poseidon2")) return "poseidon-bn254";
  if (name.includes("uep25") || name.includes("placeholder")) return "uep25-placeholder";
  // Public core reference backend (v0.3.2+): ordered SHA-256 -> BN254 field.
  if (name.includes("sha256-field")) return "public-sha256-field";
  return "unknown";
}

/** True only when active backend is real Poseidon BN254. */
export function isPoseidonBackendActive(): boolean {
  return activeHashBackendKind() === "poseidon-bn254";
}

/**
 * Frozen note commitment (circuit §4.2).
 * Same nesting regardless of Hash2 permutation underneath.
 */
export function noteCommitment(
  owner: Fr,
  asset: Fr,
  amount: Fr,
  blinding: Fr,
): Fr {
  const innerAsset = hLeaf(asset, amount);
  const payload = hLeaf(owner, innerAsset);
  return hLeaf(payload, blinding);
}

export function noteCommitmentFromAmount(
  owner: Fr,
  amount: bigint,
  blinding: Fr = LAB_ZERO_BLINDING,
  asset: Fr = CANONICAL_ASSET_ID,
): Fr {
  return noteCommitment(owner, asset, Fr.from(amount), blinding);
}

export function noteNonce(commitment: Fr, blinding: Fr): Fr {
  return hLeaf(commitment, blinding);
}

export function nullifierFrom(secret: Fr, nonce: Fr): Fr {
  return hNullifier(secret, nonce);
}

/** State-tree key of the (account, asset) balance leaf: H_ACCOUNT(owner, asset). Same as uep-zk `state-index`. */
export function stateKey(ownerId: Fr, asset: Fr = CANONICAL_ASSET_ID): Fr {
  return hAccount(ownerId, asset);
}

/** SMT index of the (account, asset) balance leaf: lowBits(H_ACCOUNT(owner, asset), depth). */
export function accountIndex(ownerId: Fr, depth: number = CANONICAL_SMT_DEPTH, asset: Fr = CANONICAL_ASSET_ID): bigint {
  return stateKey(ownerId, asset).lowBits(depth);
}

/** Nullifier tree index. */
export function nullifierIndex(nullifier: Fr, depth: number = CANONICAL_SMT_DEPTH): bigint {
  return nullifier.lowBits(depth);
}

/**
 * Assert production config never silently uses TEST_ONLY depth.
 */
export function assertCanonicalDepth(depth: number, context: string): void {
  if (depth !== CANONICAL_SMT_DEPTH) {
    throw new Error(
      `UEP-37.1: non-canonical SMT depth ${depth} in ${context}. ` +
        `Production depth is ${CANONICAL_SMT_DEPTH}. ` +
        `Use TEST_ONLY_SMT_DEPTH only in explicit unit tests.`,
    );
  }
}

export type LeafEncodingMeta = {
  version: typeof LEAF_ENCODING_VERSION;
  canonicalDepth: typeof CANONICAL_SMT_DEPTH;
  formula: "note_commitment = H_LEAF(H_LEAF(owner, H_LEAF(asset, amount)), blinding)";
  hashBackend: HashBackendKind;
  poseidonBitIdentical: boolean;
};

export function leafEncodingMeta(): LeafEncodingMeta {
  const kind = activeHashBackendKind();
  return {
    version: LEAF_ENCODING_VERSION,
    canonicalDepth: CANONICAL_SMT_DEPTH,
    formula: "note_commitment = H_LEAF(H_LEAF(owner, H_LEAF(asset, amount)), blinding)",
    hashBackend: kind,
    poseidonBitIdentical: kind === "poseidon-bn254",
  };
}
