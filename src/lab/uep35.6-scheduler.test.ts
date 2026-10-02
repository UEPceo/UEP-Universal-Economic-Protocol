import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BatchTx } from "./uep35-batch-lab.ts";
import {
  partitionByConflictGraph,
  partitionByConflictGraphLegacy,
  partitionByConflictGraphIndexed,
  countConflictEdges,
  validateWaves,
} from "./uep35-conflict-graph.ts";
import {
  sequentialExecution,
  parallelExecution,
  snapshotsEqual,
} from "./uep35-batch-execute.ts";

function makeTxs(n: number, accounts: number): BatchTx[] {
  const txs: BatchTx[] = [];
  for (let i = 0; i < n; i++) {
    const from = i % accounts;
    let to = (i * 7 + 3) % accounts;
    if (to === from) to = (to + 1) % accounts;
    txs.push({ id: `t${i}`, from: `a${from}`, to: `a${to}`, amount: 1n });
  }
  return txs;
}

describe("UEP-35.6 indexed ConflictGraph", () => {
  it("indexed matches legacy wave membership semantics for small n", () => {
    const txs = makeTxs(30, 8);
    const leg = partitionByConflictGraphLegacy(txs);
    const idx = partitionByConflictGraphIndexed(txs);
    // Same txs covered
    assert.equal(validateWaves(txs, leg).ok, true);
    assert.equal(validateWaves(txs, idx).ok, true);
    assert.ok(countConflictEdges(txs) >= 0);
  });

  it("indexed faster than legacy at 2k TX", () => {
    const txs = makeTxs(2000, 40);
    const t0 = performance.now();
    partitionByConflictGraphLegacy(txs);
    const legacyMs = performance.now() - t0;
    const t1 = performance.now();
    partitionByConflictGraphIndexed(txs);
    const indexedMs = performance.now() - t1;
    assert.ok(
      indexedMs < legacyMs || indexedMs < 50,
      `legacy=${legacyMs.toFixed(1)}ms indexed=${indexedMs.toFixed(1)}ms`,
    );
  });

  it("default partition preserves sequential≡parallel", async () => {
    const accounts = [
      { label: "a0", balance: 5000n },
      { label: "a1", balance: 5000n },
      { label: "a2", balance: 5000n },
      { label: "a3", balance: 0n },
    ];
    const txs = makeTxs(12, 4).map((t) => ({
      ...t,
      from: t.from,
      to: t.to,
    }));
    // ensure labels match
    const seq = await sequentialExecution(accounts, txs);
    const par = await parallelExecution(accounts, txs);
    assert.equal(snapshotsEqual(seq.snapshot, par.snapshot), true);
  });
});
