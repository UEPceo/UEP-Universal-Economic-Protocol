/**
 * UEP-ECON-04.1 — on-chain holds
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LocalEconomicState } from "./uep35-local-state.ts";
import { SmtEconomicState } from "./uep37-smt-economic-state.ts";
import { MultiNodeCluster } from "./uep35-multinode.ts";
import {
  ECON_04_VERSION,
  buildHoldOpenTx,
  buildHoldReleaseTx,
  buildHoldConsumeTx,
  makeHoldId,
} from "./uep-econ-04.ts";
import { creatorFee, requiredSenderDebit } from "../core/fee.ts";
import { snapshotEconomic, buildReceipt } from "./uep-econ-01.ts";

describe("UEP-ECON-04 on-chain hold", () => {
  it("version", () => {
    assert.equal(ECON_04_VERSION, "ECON-04.1");
  });

  it("hold_open reserves available without moving balance", () => {
    const st = new LocalEconomicState({ client: 50_000n, provider: 0n });
    const open = buildHoldOpenTx({
      txId: "h1",
      clientId: "client",
      providerId: "provider",
      obligationId: "obl-1",
      holdNonce: "n1",
      price: 5000n,
    });
    assert.equal(st.applyTransfers([open]).ok, true);
    assert.equal(st.balance("client"), 50_000n);
    assert.equal(st.held("client"), requiredSenderDebit(5000n));
    assert.equal(st.available("client"), 50_000n - requiredSenderDebit(5000n));
    assert.equal(st.holds.get(open.holdId!)?.status, "HELD");
  });

  it("F-2: cannot spend held funds via transfer", () => {
    const st = new LocalEconomicState({ client: 10_010n, other: 0n });
    const open = buildHoldOpenTx({
      txId: "h2",
      clientId: "client",
      providerId: "p",
      obligationId: "o2",
      holdNonce: "n",
      price: 10_000n,
    });
    assert.ok(st.applyTransfers([open]).ok);
    // available = 0
    const spend = {
      id: "s1",
      from: "client",
      to: "other",
      amount: 1000n,
    };
    const r = st.applyTransfers([spend]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /INSUFFICIENT/);
    assert.equal(st.balance("other"), 0n);
  });

  it("hold_consume pays provider and fee atomically", () => {
    const st = new LocalEconomicState({ client: 50_000n, provider: 0n });
    const price = 5000n;
    const open = buildHoldOpenTx({
      txId: "ho",
      clientId: "client",
      providerId: "provider",
      obligationId: "ob",
      holdNonce: "n",
      price,
    });
    assert.ok(st.applyTransfers([open]).ok);
    const consume = buildHoldConsumeTx({
      txId: "hc",
      clientId: "client",
      providerId: "provider",
      holdId: open.holdId!,
      price,
    });
    assert.ok(st.applyTransfers([consume]).ok);
    assert.equal(st.balance("provider"), price);
    assert.equal(st.treasuryBalance, creatorFee(price));
    assert.equal(st.balance("client"), 50_000n - requiredSenderDebit(price));
    assert.equal(st.held("client"), 0n);
    assert.equal(st.holds.get(open.holdId!)?.status, "CONSUMED");
  });

  it("hold_release frees available", () => {
    const st = new LocalEconomicState({ client: 20_000n, p: 0n });
    const open = buildHoldOpenTx({
      txId: "hr-o",
      clientId: "client",
      providerId: "p",
      obligationId: "ox",
      holdNonce: "1",
      price: 8000n,
    });
    assert.ok(st.applyTransfers([open]).ok);
    const rel = buildHoldReleaseTx({
      txId: "hr-r",
      clientId: "client",
      holdId: open.holdId!,
    });
    assert.ok(st.applyTransfers([rel]).ok);
    assert.equal(st.held("client"), 0n);
    // feeLocked retained by treasury
    assert.equal(st.available("client"), 20_000n - creatorFee(8000n));
    assert.equal(st.treasuryBalance, creatorFee(8000n));
  });

  it("overcommit: second hold rejected", () => {
    const st = new LocalEconomicState({ client: 10_010n, p: 0n });
    const a = buildHoldOpenTx({
      txId: "a",
      clientId: "client",
      providerId: "p",
      obligationId: "1",
      holdNonce: "a",
      price: 10_000n,
    });
    const b = buildHoldOpenTx({
      txId: "b",
      clientId: "client",
      providerId: "p",
      obligationId: "2",
      holdNonce: "b",
      price: 10_000n,
    });
    assert.ok(st.applyTransfers([a]).ok);
    assert.equal(st.applyTransfers([b]).ok, false);
  });

  it("SMT: holds change canonical commitment", () => {
    const st = SmtEconomicState.genesis(
      { client: 50_000n, provider: 0n },
      { testOnlyDepth: 8, isTestFixture: true },
    );
    const c0 = st.canonicalStateCommitment();
    const open = buildHoldOpenTx({
      txId: "smt-h",
      clientId: "client",
      providerId: "provider",
      obligationId: "o",
      holdNonce: "n",
      price: 3000n,
    });
    assert.ok(st.applyBatch([open]).ok);
    assert.notEqual(st.canonicalStateCommitment(), c0);
  });

  it("multinode: hold then consume is meaningful + conserved", () => {
    const cluster = new MultiNodeCluster(4, 4301, {
      useSmtState: true,
      smtDepth: 8,
      initialBalances: {
        client: 50_000n,
        provider: 0n,
        s0: 100n,
        r0: 0n,
      },
    });
    const price = 5000n;
    const open = buildHoldOpenTx({
      txId: "mn-open",
      clientId: "client",
      providerId: "provider",
      obligationId: "obl-mn",
      holdNonce: "n1",
      price,
    });
    let leader = cluster.leaderForNextHeight();
    assert.ok(cluster.proposeAggregateFrom(leader, [{ txs: [open] }]));
    for (let t = 0; t < 150; t++) {
      cluster.tick(20, 5);
      if (cluster.nodes.every((n) => n.economic.sequence >= 1)) break;
    }
    assert.equal(cluster.allHonestSameStateRoot(), true);
    const n0 = cluster.node("mn-0").economic;
    assert.ok("held" in n0 && (n0 as LocalEconomicState).held("client") > 0n);

    const consume = buildHoldConsumeTx({
      txId: "mn-consume",
      clientId: "client",
      providerId: "provider",
      holdId: open.holdId!,
      price,
    });
    leader = cluster.leaderForNextHeight();
    const before = snapshotEconomic(cluster.node(leader).economic);
    assert.ok(cluster.proposeAggregateFrom(leader, [{ txs: [consume] }]));
    for (let t = 0; t < 150; t++) {
      cluster.tick(20, 5);
      if (cluster.nodes.every((n) => n.economic.sequence >= 2)) break;
    }
    assert.equal(cluster.allHonestSameStateRoot(), true);
    const after = snapshotEconomic(cluster.node("mn-0").economic);
    assert.equal(after.balances.provider, price.toString());
    const receipt = buildReceipt({
      tx: { id: consume.id, from: "client", to: "provider", amount: price },
      before,
      after,
    });
    assert.equal(receipt.conservationHolds, true);
    assert.equal(receipt.economicallyMeaningful, true);
  });

  it("makeHoldId is collision-resistant for pipe labels", () => {
    assert.notEqual(
      makeHoldId("o", "c|n", "1"),
      makeHoldId("o", "c", "n|1"),
    );
  });
});
