/**
 * UEP-ECON-05.1 — tip, obligation binding, expiry, invariants
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LocalEconomicState } from "./uep35-local-state.ts";
import { SmtEconomicState } from "./uep37-smt-economic-state.ts";
import { MultiNodeCluster } from "./uep35-multinode.ts";
import {
  ECON_05_VERSION,
  computeEconomicTip,
  canTransition,
  buildAcceptWithHold,
  markDelivered,
} from "./uep-econ-05.ts";
import {
  buildHoldOpenTx,
  buildHoldConsumeTx,
} from "./uep-econ-04.ts";
import type { ObligationRecord } from "./uep-econ-05.ts";

describe("UEP-ECON-05 canonical economic tip", () => {
  it("version 05.1", () => {
    assert.equal(ECON_05_VERSION, "ECON-05.2.2");
  });

  it("P0: same balance + different holds → different tip", () => {
    const a = new LocalEconomicState({ c: 50_000n, p: 0n });
    const b = new LocalEconomicState({ c: 50_000n, p: 0n });
    assert.equal(a.economicTipCommitment(), b.economicTipCommitment());
    const open = buildHoldOpenTx({
      txId: "h",
      clientId: "c",
      providerId: "p",
      obligationId: "o",
      holdNonce: "n",
      price: 1000n,
    });
    assert.ok(a.applyTransfers([open]).ok);
    assert.notEqual(a.economicTipCommitment(), b.economicTipCommitment());
  });

  it("P0: same balance + different appliedTx → different tip", () => {
    const a = new LocalEconomicState({ c: 50_000n, p: 0n });
    const b = new LocalEconomicState({ c: 50_000n, p: 0n });
    assert.ok(
      a.applyTransfers([{ id: "x1", from: "c", to: "p", amount: 100n }]).ok,
    );
    assert.notEqual(a.economicTipCommitment(), b.economicTipCommitment());
  });

  it("P0 multinode: economicCommitment finalizes", () => {
    const cluster = new MultiNodeCluster(4, 4501, {
      useSmtState: true,
      smtDepth: 8,
      initialBalances: { a: 50_000n, b: 0n, s0: 100n, r0: 0n },
    });
    assert.equal(cluster.requireEconomicCommitment, true);
    assert.ok(
      cluster.proposeAggregateFrom(cluster.leaderForNextHeight(), [
        { txs: [{ id: "t1", from: "a", to: "b", amount: 1000n }] },
      ]),
    );
    for (let i = 0; i < 120; i++) {
      cluster.tick(20, 5);
      if (cluster.nodes.every((n) => n.economic.sequence >= 1)) break;
    }
    assert.equal(cluster.allHonestSameStateRoot(), true);
  });

  it("P1/P3: consume before delivery rejected; after DELIVERED ok", () => {
    const st = new LocalEconomicState({ client: 50_000n, provider: 0n });
    const { obligation, holdTx } = buildAcceptWithHold({
      offerId: "off1",
      clientId: "client",
      providerId: "provider",
      price: 3000n,
      expectedResultDigest: "digest-ok",
      clientNonce: "n1",
      holdTxId: "hold-tx",
      currentHeight: 0,
      deliverWithinHeights: 10,
    });
    assert.ok(st.applyTransfers([holdTx]).ok);
    st.obligations.set(obligation.obligationId, obligation);

    const consume = buildHoldConsumeTx({
      txId: "c1",
      clientId: "client",
      providerId: "provider",
      holdId: holdTx.holdId!,
      price: 3000n,
    });
    (consume as { obligationId?: string }).obligationId = obligation.obligationId;

    assert.equal(st.applyTransfers([consume]).ok, false);
    const o = st.obligations.get(obligation.obligationId)!;
    assert.ok(markDelivered(o, "digest-ok", st.sequence).ok);
    assert.ok(st.applyTransfers([consume]).ok);
    assert.equal(st.obligations.get(obligation.obligationId)?.status, "SETTLED");
    assert.equal(st.holds.get(holdTx.holdId!)?.status, "CONSUMED");
  });

  it("P1: consume twice rejected", () => {
    const st = new LocalEconomicState({ client: 50_000n, provider: 0n });
    const { obligation, holdTx } = buildAcceptWithHold({
      offerId: "off2",
      clientId: "client",
      providerId: "provider",
      price: 2000n,
      expectedResultDigest: "d",
      clientNonce: "n2",
      holdTxId: "ht2",
      currentHeight: 0,
    });
    assert.ok(st.applyTransfers([holdTx]).ok);
    st.obligations.set(obligation.obligationId, obligation);
    markDelivered(obligation, "d", st.sequence);
    const c1 = buildHoldConsumeTx({
      txId: "once",
      clientId: "client",
      providerId: "provider",
      holdId: holdTx.holdId!,
      price: 2000n,
    });
    (c1 as { obligationId?: string }).obligationId = obligation.obligationId;
    assert.ok(st.applyTransfers([c1]).ok);
    const c2 = buildHoldConsumeTx({
      txId: "twice",
      clientId: "client",
      providerId: "provider",
      holdId: holdTx.holdId!,
      price: 2000n,
    });
    (c2 as { obligationId?: string }).obligationId = obligation.obligationId;
    assert.equal(st.applyTransfers([c2]).ok, false);
  });

  it("P2: hold expires at deliverByHeight and frees available", () => {
    const st = new LocalEconomicState({ client: 20_000n, p: 0n });
    const { obligation, holdTx } = buildAcceptWithHold({
      offerId: "off3",
      clientId: "client",
      providerId: "p",
      price: 5000n,
      expectedResultDigest: "x",
      clientNonce: "n3",
      holdTxId: "ht3",
      currentHeight: 0,
      deliverWithinHeights: 2,
    });
    assert.ok(st.applyTransfers([holdTx]).ok);
    st.obligations.set(obligation.obligationId, obligation);
    assert.ok(st.held("client") > 0n);
    // advance height via empty commits
    st.commitLogicalHeight();
    st.commitLogicalHeight();
    // next apply runs expiries at height 2
    assert.ok(st.applyTransfers([]).ok);
    assert.equal(st.holds.get(holdTx.holdId!)?.status, "EXPIRED");
    assert.equal(st.held("client"), 0n);
    assert.equal(st.available("client") < 20_000n, true);
    assert.ok(st.treasuryBalance > 0n);
    assert.equal(st.conservationOk(), true);
    assert.equal(st.obligations.get(obligation.obligationId)?.status, "EXPIRED");
  });

  it("P3 invariants: locked = price+fee; available never negative", () => {
    const st = new LocalEconomicState({ client: 10_010n, p: 0n });
    const open = buildHoldOpenTx({
      txId: "inv",
      clientId: "client",
      providerId: "p",
      obligationId: "oi",
      holdNonce: "n",
      price: 10_000n,
    });
    assert.ok(st.applyTransfers([open]).ok);
    const h = st.holds.get(open.holdId!)!;
    assert.equal(h.locked, h.price + h.feeLocked);
    assert.equal(st.available("client") >= 0n, true);
    assert.equal(st.held("client"), h.locked);
    // cannot spend
    assert.equal(
      st.applyTransfers([{ id: "s", from: "client", to: "p", amount: 1n }]).ok,
      false,
    );
  });

  it("EXPIRED hold cannot be consumed", () => {
    const st = new LocalEconomicState({ client: 20_000n, p: 0n });
    const { obligation, holdTx } = buildAcceptWithHold({
      offerId: "off4",
      clientId: "client",
      providerId: "p",
      price: 1000n,
      expectedResultDigest: "d",
      clientNonce: "n4",
      holdTxId: "ht4",
      currentHeight: 0,
      deliverWithinHeights: 1,
    });
    assert.ok(st.applyTransfers([holdTx]).ok);
    st.obligations.set(obligation.obligationId, { ...obligation });
    st.commitLogicalHeight();
    assert.ok(st.applyTransfers([]).ok); // expire
    const o = st.obligations.get(obligation.obligationId)!;
    o.status = "DELIVERED"; // adversarial attempt
    o.deliveryDigest = "d";
    const c = buildHoldConsumeTx({
      txId: "late",
      clientId: "client",
      providerId: "p",
      holdId: holdTx.holdId!,
      price: 1000n,
    });
    (c as { obligationId?: string }).obligationId = obligation.obligationId;
    const r = st.applyTransfers([c]);
    assert.equal(r.ok, false);
  });

  it("state machine transitions", () => {
    assert.equal(canTransition("OPEN", "DELIVERED"), true);
    assert.equal(canTransition("OPEN", "SETTLED"), false);
    assert.equal(canTransition("DELIVERED", "DISPUTED"), true);
  });

  it("computeEconomicTip domain separation", () => {
    const base = {
      stateRoot: "aa",
      nullifierRoot: "bb",
      height: 1,
      appliedTxCommitment: "cc",
      authNonceCommitment: "dd",
      holdsCommitment: "ee",
      obligationsCommitment: "ff",
      treasury: "0",
    };
    assert.notEqual(
      computeEconomicTip(base),
      computeEconomicTip({ ...base, holdsCommitment: "ee2" }),
    );
  });
});
