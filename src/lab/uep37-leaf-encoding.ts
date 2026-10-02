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
 *   account index = lowBits(ownerId, DEPTH)   // DEPTH canonical = 32
 *
 * Hash permutation:
 *   - Production / circuit: Poseidon BN254 t=3 α=5 (UepPoseidon / uep-zk)
 *   - TypeScript default: UEP-25 algebraic placeholder (NOT Poseidon)
 *
 * Until TS uses a bit-identical Poseidon backend (or roots are verified via uep-zk),
 * consensus SMT roots in pure-TS are STRUCTURAL, not circuit-equivalent.
 */

import { Fr } from "../core/field.ts";
import { hLeaf, hNullifier, getHashBackend } from "../core/hash.ts";

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

/** SMT index of an account / note owner id. */
export function accountIndex(ownerId: Fr, depth: number = CANONICAL_SMT_DEPTH): bigint {
  return ownerId.lowBits(depth);
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
