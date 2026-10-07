/**
 * Binary Merkle tree with the RFC 6962 / RFC 9162 shape (SHA-256).
 *
 *   leaf hash  = SHA-256(0x00 || leaf bytes)
 *   node hash  = SHA-256(0x01 || left || right)
 *   MTH(D[n])  = split at k, the largest power of two smaller than n
 *
 * An odd node is never duplicated, so [a, b, c] and [a, b, c, c] have
 * different roots (the incoming settlement batch tree duplicated it). Audit
 * paths are verified against a known tree size (RFC 9162 section 2.1.3.2).
 *
 * Used by the relay category (chunk and wrap trees) and by the settlement
 * receipt batch. It is a business-layer commitment, not the ledger's Poseidon
 * sparse Merkle tree (src/core/smt*.ts).
 */
import { createHash } from "node:crypto";

export const MERKLE_LEAF_PREFIX = 0x00;
export const MERKLE_NODE_PREFIX = 0x01;

function sha256(...parts: Uint8Array[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

/** RFC 9162 leaf hash of raw leaf bytes. */
export function merkleLeafHash(data: Uint8Array): Buffer {
  return sha256(Uint8Array.of(MERKLE_LEAF_PREFIX), data);
}

export function merkleNodeHash(left: Uint8Array, right: Uint8Array): Buffer {
  return sha256(Uint8Array.of(MERKLE_NODE_PREFIX), left, right);
}

function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** Root over already-hashed leaves (each 32 bytes). */
export function merkleRoot(leafHashes: readonly Buffer[]): Buffer {
  const n = leafHashes.length;
  if (n === 0) throw new Error("MERKLE_EMPTY_TREE");
  if (n === 1) return leafHashes[0]!;
  const k = splitPoint(n);
  return merkleNodeHash(merkleRoot(leafHashes.slice(0, k)), merkleRoot(leafHashes.slice(k)));
}

/** Inclusion path of leaf `index` (siblings from the leaf up). */
export function merklePath(leafHashes: readonly Buffer[], index: number): Buffer[] {
  const n = leafHashes.length;
  if (!Number.isSafeInteger(index) || index < 0 || index >= n) throw new Error("MERKLE_INDEX");
  if (n === 1) return [];
  const k = splitPoint(n);
  if (index < k) return [...merklePath(leafHashes.slice(0, k), index), merkleRoot(leafHashes.slice(k))];
  return [...merklePath(leafHashes.slice(k), index - k), merkleRoot(leafHashes.slice(0, k))];
}

/** RFC 9162 section 2.1.3.2 inclusion-proof verification. Never throws. */
export function verifyMerklePath(leafHash: Uint8Array, index: number, size: number, path: readonly Uint8Array[], root: Uint8Array): boolean {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || index < 0 || size < 1 || index >= size) return false;
  if (!Array.isArray(path)) return false;
  let fn = index;
  let sn = size - 1;
  let r: Buffer = Buffer.from(leafHash);
  for (const p of path) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = merkleNodeHash(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = merkleNodeHash(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && r.equals(Buffer.from(root));
}

/**
 * v0.5.3: RFC 9162 section 2.1.4.1 consistency proof that the tree over the
 * first `m` leaves is a prefix of the tree over all `leafHashes` (size n).
 */
export function merkleConsistencyProof(leafHashes: readonly Buffer[], m: number): Buffer[] {
  const n = leafHashes.length;
  if (!Number.isSafeInteger(m) || m < 1 || m > n) throw new Error("MERKLE_CONSISTENCY_SIZE");
  const sub = (leaves: readonly Buffer[], k: number, complete: boolean): Buffer[] => {
    const size = leaves.length;
    if (k === size) return complete ? [] : [merkleRoot(leaves)];
    const split = splitPoint(size);
    if (k <= split) return [...sub(leaves.slice(0, split), k, complete), merkleRoot(leaves.slice(split))];
    return [...sub(leaves.slice(split), k - split, false), merkleRoot(leaves.slice(0, split))];
  };
  return sub(leafHashes, m, true);
}

/** RFC 9162 section 2.1.4.2 consistency-proof verification. Never throws. */
export function verifyMerkleConsistency(
  firstSize: number,
  secondSize: number,
  firstRoot: Uint8Array,
  secondRoot: Uint8Array,
  proof: readonly Uint8Array[],
): boolean {
  if (!Number.isSafeInteger(firstSize) || !Number.isSafeInteger(secondSize) || firstSize < 1 || firstSize > secondSize) return false;
  if (!Array.isArray(proof)) return false;
  const r1 = Buffer.from(firstRoot);
  const r2 = Buffer.from(secondRoot);
  if (firstSize === secondSize) return proof.length === 0 && r1.equals(r2);
  let path = proof.map((p) => Buffer.from(p));
  // Step 1: if first_size is an exact power of 2, prepend first_hash.
  if ((firstSize & (firstSize - 1)) === 0) path = [r1, ...path];
  if (path.length === 0) return false;
  let fn = firstSize - 1;
  let sn = secondSize - 1;
  // Step 3: shift right until LSB(fn) is not set.
  while (fn % 2 === 1) {
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  let fr = path[0]!;
  let sr = path[0]!;
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = merkleNodeHash(c, fr);
      sr = merkleNodeHash(c, sr);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      sr = merkleNodeHash(sr, c);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return fr.equals(r1) && sr.equals(r2) && sn === 0;
}
