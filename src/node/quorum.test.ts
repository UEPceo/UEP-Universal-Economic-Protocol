import test from "node:test";
import assert from "node:assert/strict";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { TxQuorum } from "./quorum.ts";

function voters(n: number) {
  const keys = Array.from({ length: n }, () => generateEd25519KeyPair());
  const map = new Map(keys.map((key, i) => [`node-${i}`, key.publicKeyHex]));
  return { keys, map };
}

test("two of three confirm one spend, and the conflicting spend does not", () => {
  const { keys, map } = voters(3);
  const quorum = new TxQuorum(map, 2);
  const first = ["null-1"];
  const votes = [0, 1].map((i) => quorum.vote(`node-${i}`, "tx-a", first, keys[i]!.privateKey));
  const accepted = quorum.confirm("tx-a", first, votes);
  assert.equal(accepted.length, 2);
  quorum.markSpent("tx-a", first, accepted);
  assert.equal(quorum.isConfirmed("tx-a"), true);
  const other = quorum.vote("node-2", "tx-b", first, keys[2]!.privateKey);
  assert.throws(() => quorum.confirm("tx-b", first, [other, votes[0]!]), /QUORUM_NULLIFIER_SPENT|QUORUM_NOT_MET|QUORUM_EQUIVOCATION/);
});

test("a voter cannot sign two spends of the same nullifier", () => {
  const { keys, map } = voters(3);
  const quorum = new TxQuorum(map, 2);
  quorum.vote("node-0", "tx-a", ["null-1"], keys[0]!.privateKey);
  assert.throws(() => quorum.vote("node-0", "tx-b", ["null-1"], keys[0]!.privateKey), /QUORUM_EQUIVOCATION/);
});

test("a restarted quorum keeps the vote and rejects a conflicting one", () => {
  const { keys, map } = voters(1);
  const first = new TxQuorum(map, 1);
  first.vote("node-0", "tx-a", ["null-1"], keys[0]!.privateKey);
  const second = new TxQuorum(map, 1);
  const accepted = first.confirm("tx-a", ["null-1"], [first.vote("node-0", "tx-a", ["null-1"], keys[0]!.privateKey)]);
  first.markSpent("tx-a", ["null-1"], accepted);
  second.loadState(first.exportState());
  assert.equal(second.isConfirmed("tx-a"), true);
  assert.throws(() => second.vote("node-0", "tx-b", ["null-1"], keys[0]!.privateKey), /QUORUM_EQUIVOCATION/);
});

test("a vote from another domain does not confirm", () => {
  const { keys, map } = voters(2);
  const earth = new TxQuorum(map, 2, { networkId: "uep-testnet-1", domainId: "EARTH" });
  const mars = new TxQuorum(map, 2, { networkId: "uep-testnet-1", domainId: "MARS" });
  const votes = ["node-0", "node-1"].map((id, i) => earth.vote(id, "tx-a", ["null-1"], keys[i]!.privateKey));
  assert.throws(() => mars.confirm("tx-a", ["null-1"], votes), /QUORUM_NOT_MET/);
  assert.equal(earth.confirm("tx-a", ["null-1"], votes).length, 2);
});
