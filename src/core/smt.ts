/**
 * Sparse Merkle Tree matching UEP-25 `smt.rs`.
 * Depth 32. Empty leaf frozen as Fr(0) for this prototype (must be in genesis).
 * Status: IMPLEMENTED / TESTED
 */
import { Fr } from "./field.ts";
import { hMerkle } from "./hash.ts";

export const ACCOUNT_DEPTH = 32;
export const NULLIFIER_DEPTH = 32;
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

/**
 * Native sparse tree. Nodes are stored only when they differ from empty.
 * Index space is 2^depth, keyed by the low `depth` bits of a field element.
 */
export class SparseMerkleTree {
  readonly depth: number;
  readonly empty: Fr[];
  /** level -> index -> hash; level 0 is leaves */
  private nodes: Map<string, Fr> = new Map();

  constructor(depth: number = ACCOUNT_DEPTH) {
    this.depth = depth;
    this.empty = emptyHashes(depth);
  }

  static fromLeaves(depth: number, leaves: Array<[bigint, Fr]>): SparseMerkleTree {
    const t = new SparseMerkleTree(depth);
    for (const [idx, leaf] of leaves) t.setIndex(idx, leaf);
    return t;
  }

  clone(): SparseMerkleTree {
    const t = new SparseMerkleTree(this.depth);
    t.nodes = new Map(this.nodes);
    return t;
  }

  private key(level: number, index: bigint): string {
    return level + ":" + index.toString();
  }

  private getNode(level: number, index: bigint): Fr {
    return this.nodes.get(this.key(level, index)) ?? this.empty[level]!;
  }

  private setNode(level: number, index: bigint, value: Fr): void {
    const k = this.key(level, index);
    if (value.eq(this.empty[level]!)) this.nodes.delete(k);
    else this.nodes.set(k, value);
  }

  indexOf(id: Fr): bigint {
    return id.lowBits(this.depth);
  }

  getIndex(index: bigint): Fr {
    const mask = (1n << BigInt(this.depth)) - 1n;
    return this.getNode(0, index & mask);
  }

  get(id: Fr): Fr {
    return this.getIndex(this.indexOf(id));
  }

  setIndex(index: bigint, leaf: Fr): void {
    const mask = (1n << BigInt(this.depth)) - 1n;
    let idx = index & mask;
    this.setNode(0, idx, leaf);
    for (let level = 0; level < this.depth; level++) {
      const sibling = idx ^ 1n;
      const left = (idx & 1n) === 0n ? this.getNode(level, idx) : this.getNode(level, sibling);
      const right = (idx & 1n) === 0n ? this.getNode(level, sibling) : this.getNode(level, idx);
      idx >>= 1n;
      this.setNode(level + 1, idx, hMerkle(left, right));
    }
  }

  set(id: Fr, leaf: Fr): void {
    this.setIndex(this.indexOf(id), leaf);
  }

  root(): Fr {
    return this.getNode(this.depth, 0n);
  }

  pathAt(index: bigint): MerklePath {
    const mask = (1n << BigInt(this.depth)) - 1n;
    let idx = index & mask;
    const siblings: Fr[] = [];
    const indexBits: boolean[] = [];
    for (let level = 0; level < this.depth; level++) {
      const bit = (idx & 1n) === 1n;
      indexBits.push(bit);
      siblings.push(this.getNode(level, idx ^ 1n));
      idx >>= 1n;
    }
    return { siblings, indexBits };
  }

  path(id: Fr): MerklePath {
    return this.pathAt(this.indexOf(id));
  }

  toJSON(): { depth: number; leaves: Array<[string, string]> } {
    const leaves: Array<[string, string]> = [];
    for (const [k, v] of this.nodes) {
      if (k.startsWith("0:")) leaves.push([k.slice(2), v.toHex()]);
    }
    return { depth: this.depth, leaves };
  }

  static fromJSON(data: { depth: number; leaves: Array<[string, string]> }): SparseMerkleTree {
    const t = new SparseMerkleTree(data.depth);
    for (const [idx, hex] of data.leaves) t.setIndex(BigInt(idx), new Fr(hex));
    return t;
  }
}
