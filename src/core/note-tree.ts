/**
 * Append-only Merkle tree of note commitments (v0.4.4).
 *
 * Every note (signed faucet mint or transaction output) is appended in
 * creation order. The root is part of ledger state and snapshots, and every
 * spend carries a membership proof of its input commitment against a root
 * the ledger has seen ("anchor"). A replica that only knows roots can verify
 * note existence; spent-ness is still decided by the nullifier set.
 *
 * Status: IMPLEMENTED / TESTED (testnet; hash backend = UEP-25 prototype hash).
 */
import { Fr } from "./field.ts";
import { SparseMerkleTree, rootFromPath } from "./smt.ts";

/** 2^32 notes per ledger. */
export const NOTE_TREE_DEPTH = 32;

/** Serialized membership proof (hex strings so it travels inside a transaction envelope). */
export type NoteMembershipProof = {
  /** Position of the commitment in the tree (decimal string). */
  leafIndex: string;
  /** Root the proof was produced against (must be a root the verifier knows). */
  root: string;
  /** Sibling hashes from leaf to root (NOTE_TREE_DEPTH entries). */
  siblings: string[];
};

export class NoteCommitmentTree {
  private readonly tree = new SparseMerkleTree(NOTE_TREE_DEPTH);
  private readonly indexByCommitment = new Map<string, number>();
  /** root hex -> number of leaves when that root was current. */
  private readonly history = new Map<string, number>();
  private count = 0;

  constructor() {
    this.history.set(this.tree.root().toHex(), 0);
  }

  get size(): number {
    return this.count;
  }

  root(): Fr {
    return this.tree.root();
  }

  /** Append a commitment; returns its leaf index. Duplicate commitments are refused. */
  append(commitment: Fr): number {
    const key = commitment.toHex();
    if (this.indexByCommitment.has(key)) throw new Error("NOTE_TREE_DUPLICATE");
    if (commitment.eq(Fr.zero())) throw new Error("NOTE_TREE_EMPTY_LEAF");
    if (this.count >= 2 ** NOTE_TREE_DEPTH) throw new Error("NOTE_TREE_FULL");
    const index = this.count;
    this.tree.setIndex(BigInt(index), commitment);
    this.indexByCommitment.set(key, index);
    this.count++;
    this.history.set(this.tree.root().toHex(), this.count);
    return index;
  }

  indexOf(commitment: Fr): number | undefined {
    return this.indexByCommitment.get(commitment.toHex());
  }

  /** Leaf count at which `rootHex` was the current root, if it ever was. */
  sizeAtRoot(rootHex: string): number | undefined {
    return this.history.get(rootHex);
  }

  /** Membership proof for `commitment` against the current root. */
  prove(commitment: Fr): NoteMembershipProof {
    const index = this.indexOf(commitment);
    if (index === undefined) throw new Error("NOTE_TREE_NOT_MEMBER");
    const path = this.tree.pathAt(BigInt(index));
    return { leafIndex: String(index), root: this.root().toHex(), siblings: path.siblings.map((s) => s.toHex()) };
  }

  /**
   * Verify that `commitment` is a member under a root this tree has had, at a
   * position that existed when that root was current. Optional `maxAnchorSize`
   * requires the anchor to predate a given leaf count.
   */
  verify(commitment: Fr, proof: NoteMembershipProof | undefined, maxAnchorSize = Number.POSITIVE_INFINITY): boolean {
    if (!proof) return false;
    const anchorSize = this.history.get(proof.root);
    if (anchorSize === undefined || anchorSize > maxAnchorSize) return false;
    return verifyNoteMembership(commitment, proof) && Number(proof.leafIndex) < anchorSize;
  }
}

/** Stateless check that `proof` links `commitment` to `proof.root` (no anchor check). */
export function verifyNoteMembership(commitment: Fr, proof: NoteMembershipProof): boolean {
  if (!proof || typeof proof.leafIndex !== "string" || !/^[0-9]+$/.test(proof.leafIndex) || !Array.isArray(proof.siblings) || proof.siblings.length !== NOTE_TREE_DEPTH || typeof proof.root !== "string") return false;
  const index = BigInt(proof.leafIndex);
  if (index >= 2n ** BigInt(NOTE_TREE_DEPTH)) return false;
  try {
    const siblings = proof.siblings.map((s) => new Fr(s));
    const indexBits = siblings.map((_, level) => ((index >> BigInt(level)) & 1n) === 1n);
    return rootFromPath(commitment, { siblings, indexBits }).eq(new Fr(proof.root));
  } catch {
    return false;
  }
}
