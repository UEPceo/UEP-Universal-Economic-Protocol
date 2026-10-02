/**
 * Nullifier lifecycle. N = H_NULLIFIER(secret, nonce)
 * Status: IMPLEMENTED / TESTED
 */
import { Fr } from "./field.ts";
import { hNullifier } from "./hash.ts";
import { NULLIFIER_DEPTH, SparseMerkleTree, EMPTY_LEAF, verifyInsert } from "./smt.ts";

export function deriveNullifier(secret: Fr, nonce: Fr): Fr {
  return hNullifier(secret, nonce);
}

export class NullifierSet {
  private seen = new Set<string>();
  readonly tree: SparseMerkleTree;

  constructor(tree?: SparseMerkleTree) {
    this.tree = tree ?? new SparseMerkleTree(NULLIFIER_DEPTH);
  }

  contains(n: Fr): boolean {
    return this.seen.has(n.toHex());
  }

  /**
   * Insert once. Returns true if this is the first time.
   * Also updates the nullifier SMT (empty leaf → nullifier leaf).
   */
  insertOnce(n: Fr): boolean {
    const key = n.toHex();
    if (this.seen.has(key)) return false;
    const oldRoot = this.tree.root();
    const path = this.tree.path(n);
    if (!this.tree.get(n).eq(EMPTY_LEAF)) return false;
    this.tree.set(n, n);
    const ok = verifyInsert(oldRoot, this.tree.root(), EMPTY_LEAF, n, path);
    if (!ok) {
      // Should be unreachable if path was taken from the same tree.
      this.tree.set(n, EMPTY_LEAF);
      return false;
    }
    this.seen.add(key);
    return true;
  }

  root(): Fr {
    return this.tree.root();
  }

  toJSON() {
    return { seen: [...this.seen], tree: this.tree.toJSON() };
  }

  static fromJSON(data: { seen: string[]; tree: { depth: number; leaves: Array<[string, string]> } }) {
    const set = new NullifierSet(SparseMerkleTree.fromJSON(data.tree));
    for (const s of data.seen) set.seen.add(s);
    return set;
  }
}
