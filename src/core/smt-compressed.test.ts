/** v0.5.0 compressed SMT: identical roots, paths and serialization to the reference tree. */
import assert from "node:assert/strict";
import test from "node:test";
import { Fr } from "./field.ts";
import { SparseMerkleTree, verifyInsert, verifyMembership, EMPTY_LEAF } from "./smt.ts";
import { ReferenceSparseMerkleTree } from "./fixtures/reference-smt.ts";

/** Deterministic PRNG (xorshift64*). */
function rng(seed: bigint) {
  let x = seed;
  return () => {
    x ^= x << 13n; x &= (1n << 64n) - 1n;
    x ^= x >> 7n;
    x ^= x << 17n; x &= (1n << 64n) - 1n;
    return x;
  };
}

function randomIndex(next: () => bigint, depth: number): bigint {
  let v = 0n;
  for (let i = 0; i < Math.ceil(depth / 64); i++) v = (v << 64n) | next();
  return v & ((1n << BigInt(depth)) - 1n);
}

for (const depth of [4, 8, 32, 254]) {
  test(`root equivalence with the reference tree (depth ${depth}): inserts, updates, deletes, paths, JSON`, () => {
    const next = rng(BigInt(depth) * 7919n + 1n);
    const a = new SparseMerkleTree(depth);
    const b = new ReferenceSparseMerkleTree(depth);
    assert.ok(a.root().eq(b.root()));
    const used: bigint[] = [];
    const ops = depth === 254 ? 120 : 200;
    for (let i = 0; i < ops; i++) {
      const r = next() % 10n;
      let idx: bigint;
      // Reuse indices (updates / deletes) and pick clustered ones (long shared prefixes).
      if (used.length > 0 && r < 3n) idx = used[Number(next() % BigInt(used.length))]!;
      else if (used.length > 0 && r < 5n) idx = (used[Number(next() % BigInt(used.length))]! ^ (1n << (next() % BigInt(Math.min(depth, 6))))) & ((1n << BigInt(depth)) - 1n);
      else idx = randomIndex(next, depth);
      const value = r === 9n ? EMPTY_LEAF : new Fr(next() % 1000n);
      a.setIndex(idx, value);
      b.setIndex(idx, value);
      used.push(idx);
      assert.ok(a.root().eq(b.root()), `root diverged at op ${i}`);
      if (i % 10 === 0) {
        const probe = r < 5n ? idx : randomIndex(next, depth);
        const pa = a.pathAt(probe);
        const pb = b.pathAt(probe);
        assert.deepEqual(pa.indexBits, pb.indexBits);
        assert.ok(pa.siblings.every((s, k) => s.eq(pb.siblings[k]!)), `path diverged at op ${i}`);
        assert.ok(a.getIndex(probe).eq(b.getIndex(probe)));
      }
    }
    assert.deepEqual(a.toJSON(), b.toJSON());
    assert.ok(SparseMerkleTree.fromJSON(a.toJSON()).root().eq(b.root()));
    // Compression: at most 2n - 1 stored nodes.
    const leaves = a.toJSON().leaves.length;
    assert.equal(a.storedNodeCount(), leaves === 0 ? 0 : 2 * leaves - 1);
  });
}

test("clone is independent and insert proofs verify", () => {
  const t = new SparseMerkleTree(254);
  for (let i = 1n; i <= 20n; i++) t.set(new Fr(i * 1_000_003n), new Fr(i));
  const c = t.clone();
  const id = new Fr(42n);
  const oldRoot = t.root();
  const path = t.path(id);
  t.set(id, new Fr(7n));
  assert.ok(verifyInsert(oldRoot, t.root(), EMPTY_LEAF, new Fr(7n), path));
  assert.ok(verifyMembership(t.root(), new Fr(7n), t.path(id)));
  assert.ok(c.root().eq(oldRoot));
  assert.ok(c.get(id).eq(EMPTY_LEAF));
  // Delete everything: back to the empty root.
  for (const [idx] of t.toJSON().leaves) t.setIndex(BigInt(idx), EMPTY_LEAF);
  assert.ok(t.root().eq(new SparseMerkleTree(254).root()));
  assert.equal(t.storedNodeCount(), 0);
});
