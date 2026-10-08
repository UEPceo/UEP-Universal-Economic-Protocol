/**
 * Dispute liveness: capital cannot stay locked forever.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LocalEconomicState } from "./uep35-local-state.ts";
import { SmtEconomicState } from "./uep37-smt-economic-state.ts";
import {
  MAX_DISPUTE_HEIGHTS,
  disputeClockStart,
} from "./uep-econ-04.ts";
import {
  buildAcceptWithHold,
  markDelivered,
  openDispute,
  buildHoldResolveTx,
} from "./uep-econ-05.ts";

function openDisputed(st: LocalEconomicState | SmtEconomicState) {
  const { obligation, holdTx } = buildAcceptWithHold({
    offerId: "svc",
    clientId: "c",
    providerId: "p",
    price: 2000n,
    expectedResultDigest: "digest",
    clientNonce: "n1",
    holdTxId: "h1",
    currentHeight: st.sequence,
    deliverWithinHeights: 8,
  });
  assert.ok(st.applyTransfers([holdTx]).ok);
  st.obligations.set(obligation.obligationId, { ...obligation });
  const obl = st.obligations.get(obligation.obligationId)!;
  assert.ok(markDelivered(obl, "digest", st.sequence).ok);
  assert.ok(openDispute(obl, st.sequence).ok);
  return { holdTx, obligationId: obligation.obligationId };
}

describe("dispute liveness", () => {
  it("clock starts at disputedHeight", () => {
    assert.equal(disputeClockStart({ disputedHeight: 10 }, 0), 10);
    assert.equal(MAX_DISPUTE_HEIGHTS, 64);
  });

  it("still HELD just before the deadline", () => {
    const st = new LocalEconomicState({ c: 20_000n, p: 0n });
    const { holdTx } = openDisputed(st);
    for (let i = 0; i < MAX_DISPUTE_HEIGHTS - 1; i++) st.commitLogicalHeight();
    st.applyTransfers([]);
    assert.equal(st.holds.get(holdTx.holdId!)?.status, "HELD");
    assert.ok(st.held("c") > 0n);
  });

  it("at deadline: RELEASED + CLIENT_WINS + held=0", () => {
    const st = new LocalEconomicState({ c: 20_000n, p: 0n });
    const { holdTx, obligationId } = openDisputed(st);
    const start = st.obligations.get(obligationId)!.disputedHeight!;
    while (st.sequence < start + MAX_DISPUTE_HEIGHTS) st.commitLogicalHeight();
    st.applyTransfers([]);
    const h = st.holds.get(holdTx.holdId!);
    assert.ok(!h || h.status === "RELEASED");
    assert.equal(st.obligations.get(obligationId)?.status, "CLIENT_WINS");
    assert.equal(st.held("c"), 0n);
    assert.equal(st.conservationOk(), true);
  });

  it("resolve after timeout is rejected", () => {
    const st = new LocalEconomicState({ c: 20_000n, p: 0n });
    const { holdTx, obligationId } = openDisputed(st);
    while (st.sequence < MAX_DISPUTE_HEIGHTS + 2) st.commitLogicalHeight();
    st.applyTransfers([]);
    const r = st.applyTransfers([
      buildHoldResolveTx({
        txId: "late",
        from: "p",
        holdId: holdTx.holdId!,
        obligationId,
        outcome: "CLIENT_WINS",
      } as unknown as Parameters<typeof buildHoldResolveTx>[0]),
    ]);
    assert.equal(r.ok, false);
  });

  it("same-height race: expiry wins, resolve cannot double-apply", () => {
    const st = new LocalEconomicState({ c: 20_000n, p: 0n });
    const { holdTx, obligationId } = openDisputed(st);
    const start = st.obligations.get(obligationId)!.disputedHeight!;
    while (st.sequence < start + MAX_DISPUTE_HEIGHTS) st.commitLogicalHeight();
    const r = st.applyTransfers([
      buildHoldResolveTx({
        txId: "race",
        from: "p",
        holdId: holdTx.holdId!,
        obligationId,
        outcome: "CLIENT_WINS",
      } as unknown as Parameters<typeof buildHoldResolveTx>[0]),
    ]);
    assert.equal(r.ok, false);
    assert.equal(st.obligations.get(obligationId)?.status, "CLIENT_WINS");
    assert.equal(st.held("c"), 0n);
    assert.equal(st.conservationOk(), true);
  });

  it("SMT path: same timeout, tip changes, conservation holds", () => {
    const st = SmtEconomicState.genesis(
      { c: 20_000n, p: 0n },
      { testOnlyDepth: 8, isTestFixture: true, leafMode: "structural" },
    );
    const { obligationId } = openDisputed(st);
    const tipLocked = st.economicTipCommitment();
    for (let i = 0; i < 10; i++) st.commitLogicalHeight();
    st.applyTransfers([]);
    assert.equal(st.obligations.get(obligationId)?.status, "DISPUTED");
    while (st.sequence < MAX_DISPUTE_HEIGHTS + 2) st.commitLogicalHeight();
    st.applyTransfers([]);
    assert.equal(st.obligations.get(obligationId)?.status, "CLIENT_WINS");
    assert.notEqual(st.economicTipCommitment(), tipLocked);
    assert.equal(st.conservationOk(), true);
  });
});
