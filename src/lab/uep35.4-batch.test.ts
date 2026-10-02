import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  seedLabEngine,
  runStructuralBatch,
  partitionBySender,
  type BatchTx,
} from "./uep35-batch-lab.ts";

describe("UEP-35.4 batch / parallel structural lab", () => {
  it("batch of independent spends conserves value", async () => {
    const engine = seedLabEngine([
      { label: "alice", balance: 10_000n },
      { label: "bob", balance: 0n },
      { label: "carol", balance: 0n },
    ]);
    const total0 =
      engine.getAccount("alice").balance +
      engine.getAccount("bob").balance +
      engine.getAccount("carol").balance +
      engine.treasuryBalance;

    const txs: BatchTx[] = [];
    for (let i = 0; i < 20; i++) {
      txs.push({
        id: `tx-${i}`,
        from: "alice",
        to: i % 2 === 0 ? "bob" : "carol",
        amount: 10n,
      });
    }
    // Same sender → sequential waves
    const waves = partitionBySender(txs);
    assert.equal(waves.length, 20); // one per alice tx

    // Use distinct senders for parallel wave
    const eng2 = seedLabEngine([
      { label: "s0", balance: 1000n },
      { label: "s1", balance: 1000n },
      { label: "s2", balance: 1000n },
      { label: "r0", balance: 0n },
      { label: "r1", balance: 0n },
      { label: "r2", balance: 0n },
    ]);
    const parallel: BatchTx[] = [
      { id: "p0", from: "s0", to: "r0", amount: 50n },
      { id: "p1", from: "s1", to: "r1", amount: 50n },
      { id: "p2", from: "s2", to: "r2", amount: 50n },
    ];
    assert.equal(partitionBySender(parallel).length, 1);

    const res = await runStructuralBatch(eng2, "batch-1", parallel);
    assert.equal(res.accepted, 3);
    assert.ok(res.commits.filter((c) => c.ok).length >= 1);

    const total1 =
      eng2.getAccount("s0").balance +
      eng2.getAccount("s1").balance +
      eng2.getAccount("s2").balance +
      eng2.getAccount("r0").balance +
      eng2.getAccount("r1").balance +
      eng2.getAccount("r2").balance +
      eng2.treasuryBalance;
    // Conservation across accounts + treasury
    const total0b = 1000n * 3n;
    assert.equal(total1, total0b);
  });

  it("over-budget enqueue rejects without applying", async () => {
    const engine = seedLabEngine([{ label: "a", balance: 5n }, { label: "b", balance: 0n }]);
    const res = await runStructuralBatch(engine, "b2", [
      { id: "x", from: "a", to: "b", amount: 1000n },
    ]);
    assert.equal(res.accepted, 0);
    assert.equal(res.rejected, 1);
    assert.equal(engine.getAccount("a").balance, 5n);
  });
});
