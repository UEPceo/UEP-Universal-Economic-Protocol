import test from "node:test";
import assert from "node:assert/strict";
import { walletOutputBlinding } from "./client-note.ts";

test("a non-zero blinding domain is not a fixed offset of the counter", () => {
  const domain = 0xabcdefn;
  const a = walletOutputBlinding(1n, 2n, domain);
  const b = walletOutputBlinding(2n, 2n, domain);
  assert.notEqual(b.n - a.n, 16n);
  assert.notEqual(walletOutputBlinding(1n, 2n, domain).n, walletOutputBlinding(1n, 2n, 0n).n);
});
