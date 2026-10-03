/**
 * Sparse Merkle Tree matching UEP-25 `smt.rs`.
 * Empty leaf frozen as Fr(0) for this prototype (must be in genesis).
 * Status: IMPLEMENTED / TESTED
 */
import { Fr } from "./field.ts";
import { hMerkle } from "./hash.ts";

export const ACCOUNT_DEPTH = 254;
export const NULLIFIER_DEPTH = 254;
/** BN254 Fr values are < 2^254; account/nullifier keys therefore use the full field element. */
export const FULL_KEY_DEPTH = 254;
export const EMPTY_LEAF = Fr.zero();

export type MerklePath = {
  siblings: Fr[];
  indexBits: boolean[];
};

const emptyCache = new Map<number, Fr[]>();

export function emptyHashes(depth: number): Fr[] {
  const cached = emptyCache.get(depth);
  if (cached) return cached;
  const empty: Fr[] = [EMPTY_LEAF];
  for (let i = 0; i < depth; i++) {
    empty.push(hMerkle(empty[i]!, empty[i]!));
  }
  emptyCache.set(depth, empty);
  return empty;
}

export function rootFromPath(leaf: Fr, path: MerklePath): Fr {
  let cur = leaf;
  for (let i = 0; i < path.siblings.length; i++) {
    const sib = path.siblings[i]!;
    cur = path.indexBits[i] ? hMerkle(sib, cur) : hMerkle(cur, sib);
  }
  return cur;
}

export function verifyMembership(expectedRoot: Fr, leaf: Fr, path: MerklePath): boolean {
  return rootFromPath(leaf, path).eq(expectedRoot);
}

export function verifyUpdate(
  oldRoot: Fr,
  newRoot: Fr,
  oldLeaf: Fr,
  newLeaf: Fr,
  path: MerklePath,
): boolean {
  return rootFromPath(oldLeaf, path).eq(oldRoot) && rootFromPath(newLeaf, path).eq(newRoot);
}

export function verifyInsert(
  oldRoot: Fr,
  newRoot: Fr,
  emptyLeaf: Fr,
  insertedLeaf: Fr,
  path: MerklePath,
): boolean {
  return verifyUpdate(oldRoot, newRoot, emptyLeaf, insertedLeaf, path);
}

/** Compressed trie node: a leaf, or a branch whose two children are both non-empty. */
type SmtLeaf = { readonly kind: 0; readonly level: 0; readonly index: bigint; readonly hash: Fr; lift?: { to: number; value: Fr } };
type SmtBranch = { readonly kind: 1; readonly level: number; readonly index: bigint; readonly left: SmtNode; readonly right: SmtNode; readonly hash: Fr; lift?: { to: number; value: Fr } };
type SmtNode = SmtLeaf | SmtBranch;

/** Position of the highest set bit of x (x > 0). */
function highBit(x: bigint): number {
  return x.toString(2).length - 1;
}

/**
 * Native sparse tree (v0.5.0: compressed). Roots, paths and leaves are
 * identical to the plain sparse tree (every node hashed as
 * hMerkle(left, right) with precomputed empty-subtree hashes), but only the
 * non-empty leaves and the branch points where both children are non-empty
 * are stored: n leaves cost n + (n - 1) nodes instead of up to depth * n.
 * The hash of a subtree with a single non-empty child path is "lifted" with
 * the default hashes and cached. Trie nodes are immutable, so clone() shares
 * them.
 * Account/nullifier index space uses the complete BN254 field value. For legacy/custom trees,
 * callers may still use a smaller explicit depth, but protocol account/nullifier trees use 254 bits.
 */
export class SparseMerkleTree {
  readonly depth: number;
  readonly empty: Fr[];
  private readonly mask: bigint;
  private top: SmtNode | undefined;
  /** Non-empty leaves in insertion order (serialization order matches the previous implementation). */
  private leaves: Map<bigint, Fr> = new Map();

  constructor(depth: number = ACCOUNT_DEPTH) {
    if (!Number.isInteger(depth) || depth < 1 || depth > FULL_KEY_DEPTH) throw new Error("SMT_DEPTH_INVALID");
    this.depth = depth;
    this.empty = emptyHashes(depth);
    this.mask = (1n << BigInt(depth)) - 1n;
  }

  static fromLeaves(depth: number, leaves: Array<[bigint, Fr]>): SparseMerkleTree {
    const t = new SparseMerkleTree(depth);
    for (const [idx, leaf] of leaves) t.setIndex(idx, leaf);
    return t;
  }

  clone(): SparseMerkleTree {
    const t = new SparseMerkleTree(this.depth);
    t.top = this.top;
    t.leaves = new Map(this.leaves);
    return t;
  }

  /** Number of stored trie nodes (leaves + branch points). */
  storedNodeCount(): number {
    const n = this.leaves.size;
    return n === 0 ? 0 : 2 * n - 1;
  }

  /** Hash of `node`'s subtree lifted to the ancestor at level `to` (empty siblings on the way). */
  private liftTo(node: SmtNode, to: number): Fr {
    if (to === node.level) return node.hash;
    if (node.lift && node.lift.to === to) return node.lift.value;
    let cur = node.hash;
    for (let l = node.level; l < to; l++) {
      cur = ((node.index >> BigInt(l)) & 1n) === 1n ? hMerkle(this.empty[l]!, cur) : hMerkle(cur, this.empty[l]!);
    }
    node.lift = { to, value: cur };
    return cur;
  }

  private branch(level: number, a: SmtNode, b: SmtNode): SmtBranch {
    // Children are ordered by bit (level - 1) of their index.
    const aRight = ((a.index >> BigInt(level - 1)) & 1n) === 1n;
    const left = aRight ? b : a;
    const right = aRight ? a : b;
    const index = (a.index >> BigInt(level)) << BigInt(level);
    return { kind: 1, level, index, left, right, hash: hMerkle(this.liftTo(left, level - 1), this.liftTo(right, level - 1)) };
  }

  /** Level of the lowest common ancestor of two distinct indices. */
  private splitLevel(a: bigint, b: bigint): number {
    return highBit(a ^ b) + 1;
  }

  private insert(node: SmtNode | undefined, idx: bigint, leaf: SmtLeaf): SmtNode {
    if (!node) return leaf;
    if (node.kind === 0) {
      if (node.index === idx) return leaf;
      return this.branch(this.splitLevel(node.index, idx), node, leaf);
    }
    // Outside this branch's subtree: split above it.
    if (idx >> BigInt(node.level) !== node.index >> BigInt(node.level)) {
      return this.branch(this.splitLevel(node.index, idx), node, leaf);
    }
    const goRight = ((idx >> BigInt(node.level - 1)) & 1n) === 1n;
    const left = goRight ? node.left : this.insert(node.left, idx, leaf);
    const right = goRight ? this.insert(node.right, idx, leaf) : node.right;
    return this.branch(node.level, left, right);
  }

  private remove(node: SmtNode | undefined, idx: bigint): SmtNode | undefined {
    if (!node) return undefined;
    if (node.kind === 0) return node.index === idx ? undefined : node;
    if (idx >> BigInt(node.level) !== node.index >> BigInt(node.level)) return node;
    const goRight = ((idx >> BigInt(node.level - 1)) & 1n) === 1n;
    const left = goRight ? node.left : this.remove(node.left, idx);
    const right = goRight ? this.remove(node.right, idx) : node.right;
    if (left === node.left && right === node.right) return node;
    if (!left) return right;
    if (!right) return left;
    return this.branch(node.level, left, right);
  }

  indexOf(id: Fr): bigint {
    if (this.depth >= FULL_KEY_DEPTH) return id.n;
    return id.lowBits(this.depth);
  }

  getIndex(index: bigint): Fr {
    return this.leaves.get(index & this.mask) ?? EMPTY_LEAF;
  }

  get(id: Fr): Fr {
    return this.getIndex(this.indexOf(id));
  }

  setIndex(index: bigint, leaf: Fr): void {
    const idx = index & this.mask;
    if (leaf.eq(EMPTY_LEAF)) {
      if (!this.leaves.has(idx)) return;
      this.leaves.delete(idx);
      this.top = this.remove(this.top, idx);
      return;
    }
    this.leaves.set(idx, leaf);
    this.top = this.insert(this.top, idx, { kind: 0, level: 0, index: idx, hash: leaf });
  }

  set(id: Fr, leaf: Fr): void {
    this.setIndex(this.indexOf(id), leaf);
  }

  root(): Fr {
    return this.top ? this.liftTo(this.top, this.depth) : this.empty[this.depth]!;
  }

  pathAt(index: bigint): MerklePath {
    const idx = index & this.mask;
    const siblings: Fr[] = this.empty.slice(0, this.depth);
    const indexBits: boolean[] = [];
    for (let level = 0; level < this.depth; level++) indexBits.push(((idx >> BigInt(level)) & 1n) === 1n);
    let node = this.top;
    while (node) {
      const outside = node.kind === 0 ? node.index !== idx : idx >> BigInt(node.level) !== node.index >> BigInt(node.level);
      if (outside) {
        // The target's path leaves this subtree at the split level; its sibling there is this subtree.
        const d = this.splitLevel(node.index, idx) - 1;
        siblings[d] = this.liftTo(node, d);
        break;
      }
      if (node.kind === 0) break;
      const goRight = ((idx >> BigInt(node.level - 1)) & 1n) === 1n;
      const other = goRight ? node.left : node.right;
      siblings[node.level - 1] = this.liftTo(other, node.level - 1);
      node = goRight ? node.right : node.left;
    }
    return { siblings, indexBits };
  }

  path(id: Fr): MerklePath {
    return this.pathAt(this.indexOf(id));
  }

  toJSON(): { depth: number; leaves: Array<[string, string]> } {
    const leaves: Array<[string, string]> = [];
    for (const [k, v] of this.leaves) leaves.push([k.toString(), v.toHex()]);
    return { depth: this.depth, leaves };
  }

  static fromJSON(data: { depth: number; leaves: Array<[string, string]> }): SparseMerkleTree {
    const t = new SparseMerkleTree(data.depth);
    for (const [idx, hex] of data.leaves) t.setIndex(BigInt(idx), new Fr(hex));
    return t;
  }
}
