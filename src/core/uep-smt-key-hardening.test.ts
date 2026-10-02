import test from "node:test";
import assert from "node:assert/strict";
import { Fr } from "./field.ts";
import { SparseMerkleTree, ACCOUNT_DEPTH, NULLIFIER_DEPTH } from "./smt.ts";
import { NullifierSet } from "./nullifier.ts";

test("account SMT uses the full field key, not only the low 32 bits", () => {
  assert.equal(ACCOUNT_DEPTH, 254);
  const low = 0x12345678n;
  const a = new Fr(low);
  const b = new Fr(low + (1n << 32n));
  const t = new SparseMerkleTree(ACCOUNT_DEPTH);
  t.set(a, new Fr(11n));
  const rootA = t.root();
  t.set(b, new Fr(22n));
  const rootAB = t.root();
  assert.notEqual(rootA.toHex(), rootAB.toHex());
  assert.equal(t.get(a).n, 11n);
  assert.equal(t.get(b).n, 22n);
});

test("nullifier SMT does not alias nullifiers sharing the low 32 bits", () => {
  assert.equal(NULLIFIER_DEPTH, 254);
  const low = 0xabcdef01n;
  const a = new Fr(low);
  const b = new Fr(low + (1n << 32n));
  const set = new NullifierSet();
  assert.equal(set.insertOnce(a), true);
  assert.equal(set.insertOnce(b), true);
  assert.equal(set.contains(a), true);
  assert.equal(set.contains(b), true);
});
