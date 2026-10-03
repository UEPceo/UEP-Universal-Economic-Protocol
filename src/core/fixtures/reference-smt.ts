/**
 * Reference (uncompressed) sparse Merkle tree: the implementation used up to
 * v0.4.7, kept verbatim for root-equivalence tests and the memory benchmark.
 * It stores every non-empty node (up to depth nodes per leaf). TEST ONLY.
 */
import { Fr } from "../field.ts";
import { hMerkle } from "../hash.ts";
import { ACCOUNT_DEPTH, FULL_KEY_DEPTH, emptyHashes, type MerklePath } from "../smt.ts";

export class ReferenceSparseMerkleTree {
  readonly depth: number;
  readonly empty: Fr[];
  /** level -> index -> hash; level 0 is leaves */
  private nodes: Map<string, Fr> = new Map();

  storedNodeCount(): number {
    return this.nodes.size;
  }

  constructor(depth: number = ACCOUNT_DEPTH) {
    this.depth = depth;
    this.empty = emptyHashes(depth);
  }

  static fromLeaves(depth: number, leaves: Array<[bigint, Fr]>): ReferenceSparseMerkleTree {
    const t = new ReferenceSparseMerkleTree(depth);
    for (const [idx, leaf] of leaves) t.setIndex(idx, leaf);
    return t;
  }

  clone(): ReferenceSparseMerkleTree {
    const t = new ReferenceSparseMerkleTree(this.depth);
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
    if (this.depth >= FULL_KEY_DEPTH) return id.n;
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

  static fromJSON(data: { depth: number; leaves: Array<[string, string]> }): ReferenceSparseMerkleTree {
    const t = new ReferenceSparseMerkleTree(data.depth);
    for (const [idx, hex] of data.leaves) t.setIndex(BigInt(idx), new Fr(hex));
    return t;
  }
}

