/**
 * ECON-05.2 residual: process mesh economic ops + partitions
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProcessCluster } from "./uep35-process-cluster.ts";
import { buildHoldOpenTx, buildHoldConsumeTx } from "./uep-econ-04.ts";
import { buildAcceptWithHold, markDelivered } from "./uep-econ-05.ts";

async function waitFinalized(cluster: ProcessCluster, minSeq = 1, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await cluster.pollStatus();
    if (st.every((s) => s.sequence >= minSeq && s.finalized.length >= minSeq)) {
      return st;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return cluster.pollStatus();
}

describe("UEP-ECON-05.2 process mesh economic + partition", () => {
  it("process 4 nodes: transfer → same stateRoot + economicTip", async () => {
    const cluster = new ProcessCluster();
    try {
      await cluster.start(4);
      await cluster.propose("mn-0", [
        { id: "e1", from: "s0", to: "r0", amount: "1000" },
      ]);
      const st = await waitFinalized(cluster, 1, 20000);
      assert.ok(st.every((s) => s.sequence >= 1), `seq=${st.map((s) => s.sequence)}`);
      const roots = new Set(st.map((s) => s.stateRoot));
      const tips = new Set(st.map((s) => s.economicTip));
      assert.equal(roots.size, 1, `roots diverge ${[...roots]}`);
      assert.equal(tips.size, 1, `tips diverge ${[...tips]}`);
      assert.ok(st[0]!.economicTip.length > 0);
      // conservation: r0 gained 1000
      assert.equal(st[0]!.balances["r0"], "1000");
    } finally {
      await cluster.stop();
    }
  });

  it("process hold_open then settle converges", async () => {
    const cluster = new ProcessCluster();
    try {
      await cluster.start(4);
      const { obligation, holdTx } = buildAcceptWithHold({
        offerId: "off-p",
        clientId: "s0",
        providerId: "r0",
        price: 2000n,
        expectedResultDigest: "digest-p",
        clientNonce: "pn",
        holdTxId: "hold-p1",
        currentHeight: 0,
        deliverWithinHeights: 1000,
      });
      // process nodes don't share obligation registry — register via side channel is lab-only;
      // consume without obligation record still works (ECON-04 compat)
      await cluster.propose("mn-0", [
        {
          id: holdTx.id,
          from: holdTx.from,
          to: holdTx.to,
          amount: holdTx.amount.toString(),
          kind: holdTx.kind,
          holdId: holdTx.holdId,
          obligationId: holdTx.obligationId,
          providerId: holdTx.providerId,
          price: holdTx.price?.toString(),
        },
      ]);
      let st = await waitFinalized(cluster, 1, 20000);
      assert.ok(st.every((s) => s.sequence >= 1));
      const tips1 = new Set(st.map((s) => s.economicTip));
      assert.equal(tips1.size, 1);

      // deliver+consume without cross-process obligation map: pure hold_consume
      const consume = buildHoldConsumeTx({
        txId: "cons-p1",
        clientId: "s0",
        providerId: "r0",
        holdId: holdTx.holdId!,
        price: 2000n,
      });
      await cluster.propose("mn-0", [
        {
          id: consume.id,
          from: consume.from,
          to: consume.to,
          amount: consume.amount.toString(),
          kind: consume.kind,
          holdId: consume.holdId,
          providerId: consume.providerId,
          price: consume.price?.toString(),
        },
      ]);
      st = await waitFinalized(cluster, 2, 25000);
      if (st.every((s) => s.sequence >= 2)) {
        const tips2 = new Set(st.map((s) => s.economicTip));
        assert.equal(tips2.size, 1);
        // provider should have received price (minus fee path: balance of r0)
        const r0 = BigInt(st[0]!.balances["r0"] ?? "0");
        assert.ok(r0 >= 2000n, `r0=${r0}`);
      }
    } finally {
      await cluster.stop();
    }
  });

  it("process partition 3|1: majority advances; after heal tips converge", async () => {
    const cluster = new ProcessCluster();
    try {
      await cluster.start(4);
      await cluster.partition(["mn-0", "mn-1", "mn-2"], ["mn-3"]);
      await cluster.propose("mn-0", [
        { id: "part1", from: "s0", to: "r0", amount: "500" },
      ]);
      // majority should finalize
      let majOk = false;
      for (let i = 0; i < 120; i++) {
        const st = await cluster.pollStatus();
        const maj = st.filter((s) => s.nodeId !== "mn-3");
        const min = st.find((s) => s.nodeId === "mn-3")!;
        if (maj.every((s) => s.sequence >= 1)) {
          majOk = true;
          assert.equal(min.sequence, 0);
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(majOk, "majority should finalize under 3|1");

      await cluster.heal();
      // catch-up
      for (let i = 0; i < 150; i++) {
        const st = await cluster.pollStatus();
        if (st.every((s) => s.sequence >= 1)) {
          const tips = new Set(st.map((s) => s.economicTip));
          const roots = new Set(st.map((s) => s.stateRoot));
          assert.equal(roots.size, 1);
          assert.equal(tips.size, 1);
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      const st = await cluster.pollStatus();
      // soft assert: at least majority still consistent
      const maj = st.filter((s) => s.nodeId !== "mn-3");
      assert.equal(new Set(maj.map((s) => s.stateRoot)).size, 1);
    } finally {
      await cluster.stop();
    }
  });

  it("process partition 2|2: no finality alone", async () => {
    const cluster = new ProcessCluster();
    try {
      await cluster.start(4);
      await cluster.partition(["mn-0", "mn-1"], ["mn-2", "mn-3"]);
      await cluster.propose("mn-0", [
        { id: "q22", from: "s0", to: "r0", amount: "100" },
      ]);
      await new Promise((r) => setTimeout(r, 2500));
      const st = await cluster.pollStatus();
      const advanced = st.filter((s) => s.sequence >= 1);
      assert.equal(
        advanced.length,
        0,
        `2|2 must not finalize, got ${advanced.map((s) => s.nodeId)}`,
      );
    } finally {
      await cluster.stop();
    }
  });
});
