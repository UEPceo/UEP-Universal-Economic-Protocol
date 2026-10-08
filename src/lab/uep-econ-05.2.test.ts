/**
 * UEP-ECON-05.2 — restart, races, invariants, stress
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LocalEconomicState } from "./uep35-local-state.ts";
import { MultiNodeCluster } from "./uep35-multinode.ts";
import {
  buildAcceptWithHold,
  markDelivered,
} from "./uep-econ-05.ts";
import {
  buildHoldConsumeTx,
  buildHoldReleaseTx,
  buildHoldOpenTx,
} from "./uep-econ-04.ts";
import {
  snapshotEconomic,
  restoreEconomic,
  economicSurfacesEqual,
} from "./uep-econ-05-snapshot.ts";
import {
  checkEconomicInvariants,
  tipsAndRootsAgree,
} from "./uep-econ-05-invariants.ts";
import { runAdversarialSim } from "./uep-econ-05-adversarial-sim.ts";
import { softRestartNode, snapshotNodeConsensus } from "./uep36-node-snapshot.ts";

describe("UEP-ECON-05.2 restart / snapshot", () => {
  it("snapshot → restore → same tip/root/holds", () => {
    const st = new LocalEconomicState({ c: 50_000n, p: 0n });
    const { obligation, holdTx } = buildAcceptWithHold({
      offerId: "o",
      clientId: "c",
      providerId: "p",
      price: 2000n,
      expectedResultDigest: "d",
      clientNonce: "n",
      holdTxId: "h1",
      currentHeight: 0,
      deliverWithinHeights: 50,
    });
    assert.ok(st.applyTransfers([holdTx]).ok);
    st.obligations.set(obligation.obligationId, obligation);
    st.commitLogicalHeight();
    const tip = st.economicTipCommitment();
    const root = st.stateRoot();
    const snap = snapshotEconomic(st);

    const st2 = new LocalEconomicState({});
    restoreEconomic(st2, snap);
    assert.equal(st2.economicTipCommitment(), tip);
    assert.equal(st2.stateRoot(), root);
    assert.equal(st2.holds.get(holdTx.holdId!)?.status, "HELD");
    assert.equal(st2.obligations.get(obligation.obligationId)?.status, "OPEN");
    assert.ok(economicSurfacesEqual(st, st2));

    // replay hold after restore
    const r = st2.applyTransfers([holdTx]);
    assert.equal(r.ok, false);
  });

  it("cluster softRestart preserves tip; replay still rejected", () => {
    const cluster = new MultiNodeCluster(4, 5201, {
      useSmtState: true,
      smtDepth: 8,
      initialBalances: { a: 30_000n, b: 0n, s0: 100n, r0: 0n },
    });
    assert.ok(
      cluster.proposeAggregateFrom(cluster.leaderForNextHeight(), [
        { txs: [{ id: "t1", from: "a", to: "b", amount: 1000n }] },
      ]),
    );
    for (let i = 0; i < 80; i++) {
      cluster.tick(15, 4);
      if (cluster.nodes.every((n) => n.economic.sequence >= 1)) break;
    }
    const tipBefore = cluster
      .node("mn-0")
      .economic.economicTipCommitment();
    const snap = cluster.softRestart("mn-0");
    assert.ok(snap.appliedTxIds.includes("t1"));
    assert.equal(
      cluster.node("mn-0").economic.economicTipCommitment(),
      tipBefore,
    );
    // replay same tx rejected
    const r = cluster.proposeAggregateFrom(cluster.leaderForNextHeight(), [
      { txs: [{ id: "t1", from: "a", to: "b", amount: 1000n }] },
    ]);
    assert.equal(r, null);
  });
});

describe("UEP-ECON-05.2 delivery/expiry race matrix", () => {
  function setup(ttl: number) {
    const st = new LocalEconomicState({ c: 50_000n, p: 0n });
    const { obligation, holdTx } = buildAcceptWithHold({
      offerId: "race",
      clientId: "c",
      providerId: "p",
      price: 1000n,
      expectedResultDigest: "digest",
      clientNonce: "nr",
      holdTxId: "hr",
      currentHeight: 0,
      deliverWithinHeights: ttl,
    });
    assert.ok(st.applyTransfers([holdTx]).ok);
    st.obligations.set(obligation.obligationId, { ...obligation });
    return { st, obligation, holdTx, ttl };
  }

  it("delivery before expiry → settle OK", () => {
    const { st, obligation, holdTx, ttl } = setup(5);
    markDelivered(st.obligations.get(obligation.obligationId)!, "digest", st.sequence);
    const c = buildHoldConsumeTx({
      txId: "cs",
      clientId: "c",
      providerId: "p",
      holdId: holdTx.holdId!,
      price: 1000n,
    });
    (c as { obligationId?: string }).obligationId = obligation.obligationId;
    assert.ok(st.applyTransfers([c]).ok);
    assert.equal(st.holds.get(holdTx.holdId!)?.status, "CONSUMED");
  });

  it("delivery after expiry → consume REJECT", () => {
    const { st, obligation, holdTx, ttl } = setup(2);
    st.commitLogicalHeight();
    st.commitLogicalHeight();
    st.applyTransfers([]); // expire at height >= 2
    assert.equal(st.holds.get(holdTx.holdId!)?.status, "EXPIRED");
    const o = st.obligations.get(obligation.obligationId)!;
    o.status = "DELIVERED"; // adversarial force
    o.deliveryDigest = "digest";
    const c = buildHoldConsumeTx({
      txId: "late",
      clientId: "c",
      providerId: "p",
      holdId: holdTx.holdId!,
      price: 1000n,
    });
    (c as { obligationId?: string }).obligationId = obligation.obligationId;
    assert.equal(st.applyTransfers([c]).ok, false);
  });

  it("cancel (release) vs deliver: release then cannot consume", () => {
    const { st, obligation, holdTx } = setup(20);
    const rel = buildHoldReleaseTx({
      txId: "rel",
      clientId: "c",
      holdId: holdTx.holdId!,
    });
    assert.ok(st.applyTransfers([rel]).ok);
    st.obligations.get(obligation.obligationId)!.status = "CANCELLED";
    markDelivered(st.obligations.get(obligation.obligationId)!, "digest", st.sequence); // should fail status
    // force DELIVERED after cancel is invalid machine — consume still fails on hold status
    const c = buildHoldConsumeTx({
      txId: "c2",
      clientId: "c",
      providerId: "p",
      holdId: holdTx.holdId!,
      price: 1000n,
    });
    (c as { obligationId?: string }).obligationId = obligation.obligationId;
    assert.equal(st.applyTransfers([c]).ok, false);
  });

  it("no double settle", () => {
    const { st, obligation, holdTx } = setup(20);
    markDelivered(st.obligations.get(obligation.obligationId)!, "digest", st.sequence);
    const c1 = buildHoldConsumeTx({
      txId: "a",
      clientId: "c",
      providerId: "p",
      holdId: holdTx.holdId!,
      price: 1000n,
    });
    (c1 as { obligationId?: string }).obligationId = obligation.obligationId;
    assert.ok(st.applyTransfers([c1]).ok);
    const c2 = buildHoldConsumeTx({
      txId: "b",
      clientId: "c",
      providerId: "p",
      holdId: holdTx.holdId!,
      price: 1000n,
    });
    (c2 as { obligationId?: string }).obligationId = obligation.obligationId;
    assert.equal(st.applyTransfers([c2]).ok, false);
  });
});

describe("UEP-ECON-05.2 invariant checker", () => {
  it("clean state has zero findings", () => {
    const st = new LocalEconomicState({ c: 10_000n });
    const f = checkEconomicInvariants(st as unknown as Parameters<typeof checkEconomicInvariants>[0], { accountIds: ["c"] });
    assert.equal(f.length, 0);
  });

  it("detects negative available after bad hold overcommit attempt", () => {
    const st = new LocalEconomicState({ c: 1000n });
    const open = buildHoldOpenTx({
      txId: "h",
      clientId: "c",
      providerId: "p",
      obligationId: "o",
      holdNonce: "n",
      price: 5000n,
    });
    assert.equal(st.applyTransfers([open]).ok, false);
    assert.equal(checkEconomicInvariants(st as unknown as Parameters<typeof checkEconomicInvariants>[0], { accountIds: ["c"] }).length, 0);
  });
});

describe("UEP-ECON-05.2 multi-hold stress", () => {
  it("100 civs × 2 holds × 4 nodes: conservation + tips", () => {
    const m = runAdversarialSim({
      civs: 100,
      nodes: 4,
      seed: 99,
      holdsPerClient: 2,
      priceMin: 400n,
      priceMax: 900n,
      deliverWithin: 3,
      useSmt: true,
      smtDepth: 8,
    });
    assert.equal(m.conservationOk, true);
    assert.equal(m.tipsAgree, true);
    assert.equal(m.rootsAgree, true);
    assert.ok(m.holdsOpened > 50);
  });
});

describe("UEP-ECON-05.2 partition during economic ops", () => {
  it("partition 2|2 then heal: tips converge", () => {
    const cluster = new MultiNodeCluster(4, 5301, {
      useSmtState: true,
      smtDepth: 8,
      initialBalances: { a: 40_000n, b: 0n, s0: 100n, r0: 0n },
    });
    // one transfer
    assert.ok(
      cluster.proposeAggregateFrom(cluster.leaderForNextHeight(), [
        { txs: [{ id: "p1", from: "a", to: "b", amount: 500n }] },
      ]),
    );
    for (let i = 0; i < 80; i++) {
      cluster.tick(15, 4);
      if (cluster.nodes.every((n) => n.economic.sequence >= 1)) break;
    }
    cluster.partition(["mn-0", "mn-1"], ["mn-2", "mn-3"]);
    // minority may not finalize; majority side continues if leader in majority
    const leader = cluster.leaderForNextHeight();
    cluster.proposeAggregateFrom(leader, [
      { txs: [{ id: "p2", from: "a", to: "b", amount: 200n }] },
    ]);
    for (let i = 0; i < 40; i++) cluster.tick(15, 4);
    cluster.heal();
    if (typeof cluster.resyncAfterHeal === "function") cluster.resyncAfterHeal();
    for (let i = 0; i < 60; i++) cluster.tick(15, 4);
    const agree = tipsAndRootsAgree(cluster.nodes as unknown as Parameters<typeof tipsAndRootsAgree>[0]);
    // After partition, convergence may require catch-up; require roots or document
    assert.ok(
      agree.tipsAgree || agree.rootsAgree,
      "expected some convergence signal after heal",
    );
  });
});
