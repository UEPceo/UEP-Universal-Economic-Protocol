/**
 * v0.5.3 no-dependency rule: with the oracle healthy, stale, down, paused or
 * with one source out of band, every path that moves funds already in flight
 * stays reachable (fund, deliver, settle, cancel, refund, dispute, arbiter
 * resolution, reservation expiry, dispute timeout, IoT hold / telemetry /
 * settle, swap settle / expire, ledger transfer), value stays conserved, and
 * new oracle-bound operations follow the signed price by default (the outcome
 * is recorded on the order) unless their signed terms say BLOCK_NEW.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import * as T from "../marketplace/testkit.ts";
import { IoTM2MService, IOT_M2M_CATEGORY } from "../service/iot-m2m.ts";
import * as IT from "../service/iot-testkit.ts";
import { SettlementIndex } from "../category/settlement-index.ts";
import { SwapCategory, swapHashlock, swapIntentId, type SwapIntentBody } from "../category/swap.ts";
import { OracleAggregator } from "./index.ts";
import { OracleRegistry } from "./registry.ts";
import { OraclePolicyGate } from "./policy-gate.ts";
import { createOracleTestKey, makeQuote, registerOracleTestKey, signQuote, resetOracleSequence } from "./testkit.ts";

const EUR = "uep-test/teur";
const ENERGY = "uep-test/tenergy";
const bytes = Buffer.from("payload");
let seqBase = 1n;

function world() {
  resetOracleSequence(seqBase);
  seqBase += 100_000n;
  let h = 1000;
  const keys = [createOracleTestKey("a"), createOracleTestKey("b"), createOracleTestKey("c")];
  const registry = new OracleRegistry();
  for (const k of keys) registerOracleTestKey(registry, k);
  for (const [b, q] of [[ENERGY, EUR], [EUR, ENERGY]] as const) registry.setPairPolicy({ baseAssetId: b, quoteAssetId: q, maxStalenessHeights: 12, maxDeviationPpm: 50_000n, minSources: 2 });
  const aggregator = new OracleAggregator({ defaultMinSources: 2 }, registry);
  const publish = (base: string, quote: string, p: bigint, who = keys.slice(0, 2), price3?: bigint) => {
    for (const k of who) aggregator.publish(signQuote(makeQuote({ source: k.sourceId, baseAssetId: base, quoteAssetId: quote, priceE6: k.sourceId === "c" && price3 ? price3 : p, observedAtHeight: h }), k.privateKey, k.publicKeyHex), h);
  };
  publish(ENERGY, EUR, 2_000_000n);
  publish(EUR, ENERGY, 500_000n);
  const gate = new OraclePolicyGate(aggregator);
  const admin = T.createTestAuthority("admin");
  const arb = T.createTestAuthority("arb");
  const m = new DigitalServicesMarketplace({ adminIdentity: admin.identityId, adminPublicKey: admin.publicKeyHex, settlementArbiterId: "arb", settlementArbiterPublicKey: arb.publicKeyHex, height: () => h, oracleGate: gate });
  return { m, gate, aggregator, registry, keys, publish, adv: (n: number) => { h += n; }, setH: (x: number) => { h = x; }, h: () => h };
}
type W = ReturnType<typeof world>;

const bound = (title: string, category = "COMPUTE", onOracleUnavailable?: "BLOCK_NEW") => ({ providerId: "p1", title, description: `d ${title}`, category, asset: EUR, unitPrice: 20n, capacity: 1000n, oracleReference: { baseAssetId: ENERGY, baseUnitsPerQuantity: 10n, maxDeviationPpm: 50_000n, ...(onOracleUnavailable ? { onOracleUnavailable } : {}) } });
const unbound = (title: string) => ({ providerId: "p1", title, description: `d ${title}`, category: "COMPUTE", asset: EUR, unitPrice: 20n, capacity: 1000n });

const MODES: Array<[string, (w: W) => void, string | undefined]> = [
  ["healthy", () => {}, undefined],
  ["stale", (w) => w.adv(20), "ORACLE_STALE"],
  ["down", (w) => w.aggregator.clear(), "ORACLE_PAIR_UNKNOWN"],
  ["paused", (w) => w.registry.setGlobalPaused(true), "ORACLE_PAIR_PAUSED"],
  // One source 10 % off: it is dropped on its own and the two agreeing sources still answer.
  ["one outlier", (w) => { w.adv(1); w.publish(ENERGY, EUR, 2_000_000n, w.keys, 2_200_000n); w.publish(EUR, ENERGY, 500_000n, w.keys, 550_000n); }, undefined],
];

for (const [name, degrade, unavailable] of MODES) {
  test(`Marketplace with the oracle ${name}: in-flight paths stay reachable; new bound orders follow the signed terms`, () => {
    const w = world();
    const m = w.m;
    const L = T.publishAs(m, bound(`bound-${name}`) as never);
    const LB = T.publishAs(m, bound(`bound-block-${name}`, "COMPUTE", "BLOCK_NEW") as never);
    const U = T.publishAs(m, unbound(`unbound-${name}`) as never);
    const r = (buyer: string, lid = L.listingId) => T.reserveAs(m, { listingId: lid, buyerId: buyer, quantity: 1n });
    const full = (o: { orderId: string; fundingDue: bigint }) => T.fund(m, o.orderId, o.fundingDue);
    const oFund = r("b-fund"), oCancelB = r("b-cancel"), oCancelP = r("b-cancelp"), oExpire = r("b-expire");
    const oDeliver = r("b-deliver"); full(oDeliver);
    const oSettle = r("b-settle"); full(oSettle); T.deliver(m, oSettle.orderId, "p1", bytes);
    const oSettleP = r("b-settlep"); full(oSettleP); T.deliver(m, oSettleP.orderId, "p1", bytes);
    const oDispT = r("b-disp-timeout"); full(oDispT); T.deliver(m, oDispT.orderId, "p1", bytes);
    const oDispR = r("b-disp-resolve"); full(oDispR); T.deliver(m, oDispR.orderId, "p1", bytes);
    const oRefund = r("b-refund"); full(oRefund); T.deliver(m, oRefund.orderId, "p1", bytes);
    const uOrder = r("u-old", U.listingId);
    assert.equal(oFund.oracleCheck?.outcome, "IN_BAND");
    degrade(w);

    // New oracle-bound operations: default FOLLOW_SIGNED_PRICE, recorded on the order; BLOCK_NEW refuses.
    const fresh = r("b-new");
    if (unavailable) {
      assert.equal(fresh.oracleCheck?.outcome, "ORACLE_UNAVAILABLE_SIGNED_PRICE");
      assert.equal(fresh.oracleCheck?.reason, unavailable);
      assert.throws(() => r("b-new-block", LB.listingId), new RegExp(unavailable));
      assert.equal(T.publishAs(m, bound(`bound2-${name}`) as never).publishOracleCheck?.reason, unavailable);
    } else {
      assert.equal(fresh.oracleCheck?.outcome, "IN_BAND");
      assert.match(fresh.oracleCheck?.quoteHash ?? "", /^[0-9a-f]{64}$/);
      assert.equal(r("b-new-block", LB.listingId).oracleCheck?.outcome, "IN_BAND");
    }
    // Funds in flight never consult the oracle.
    full(uOrder); T.deliver(m, uOrder.orderId, "p1", bytes);
    assert.equal(full(oFund).status, "HELD");
    assert.equal(T.deliver(m, oDeliver.orderId, "p1", bytes).status, "DELIVERED");
    assert.equal(T.settle(m, oSettle.orderId, "b-settle").outcome, "RELEASE");
    assert.equal(T.cancel(m, oCancelB.orderId, "b-cancel").status, "CANCELLED");
    assert.equal(T.cancel(m, oCancelP.orderId, "p1").status, "CANCELLED");
    assert.equal(T.refundAs(m, "p1", oRefund.orderId).outcome, "REFUND_BUYER");
    assert.equal(T.disputeAs(m, "b-disp-timeout", oDispT.orderId, "late").status, "DISPUTED");
    assert.equal(T.disputeAs(m, "b-disp-resolve", oDispR.orderId, "bad").status, "DISPUTED");
    assert.equal(T.resolveAs(m, "arb", oDispR.orderId, { outcome: "SPLIT", providerAmount: 10n }).outcome, "SPLIT");
    w.setH(Math.max(w.h(), oExpire.reservationExpiresAt ?? 0) + 1);
    assert.equal(T.expire(m, oExpire.orderId, "b-expire").status, "EXPIRED");
    const dd = T.getOrder(m, oDispT.orderId, "b-disp-timeout").disputeDeadline ?? 0;
    const dw = (T.getOrder(m, oSettleP.orderId, "p1").deliveredAt ?? 0) + oSettleP.windows.deliveryDisputeWindow;
    w.setH(Math.max(w.h(), dd, dw) + 1);
    assert.equal(T.settle(m, oDispT.orderId, "p1").outcome, "REFUND_BUYER");
    assert.equal(T.settle(m, oSettleP.orderId, "p1").outcome, "RELEASE");
    assert.equal(T.settle(m, uOrder.orderId, "u-old").outcome, "RELEASE");
    assert.equal(m.valueAccounting(EUR).conserved, true);
  });
}

test("IoT and swaps with the oracle stale or down: in-flight holds settle and expire; new opt-in operations follow the signed price", () => {
  for (const [name, degrade, unavailable] of MODES.slice(1, 3)) {
    const w = world();
    const m = w.m;
    const iot = new IoTM2MService(m, {});
    IT.registerProviderAs(iot, { providerId: "p1", displayName: "P" });
    IT.registerMachineAs(iot, { machineId: "m1", providerId: "p1", serviceType: "energy", model: "M", endpointRef: "sim://m1" });
    const L = T.publishAs(m, bound(`iot-${name}`, IOT_M2M_CATEGORY) as never);
    const LB = T.publishAs(m, bound(`iot-block-${name}`, IOT_M2M_CATEGORY, "BLOCK_NEW") as never);
    const req = IT.requestAs(iot, { buyerId: "ib", listingId: L.listingId, machineId: "m1", quantity: 2n });
    const req2 = IT.requestAs(iot, { buyerId: "ib2", listingId: L.listingId, machineId: "m1", quantity: 2n });
    IT.holdAs(iot, req2.requestId, "ib2");
    T.enrollIdentity(m, "buyer", { asset: EUR, amount: 100_000n });
    T.enrollIdentity(m, "maker", { asset: ENERGY, amount: 100_000n });
    const swap = new SwapCategory(m.issueCategoryEscrowPort("swap"), new SettlementIndex(), "uep-testnet", { priceGate: w.gate });
    const open = (n: number, dl: number, band?: SwapIntentBody["oracleBand"]) => {
      const intent: SwapIntentBody = { version: 1, category: "uep.service.swap.v1", networkId: "uep-testnet", buyerId: "buyer", marketMakerId: "maker", fromAsset: EUR, fromAmount: 1000n, toAsset: ENERGY, toAmount: 500n, hashlock: swapHashlock(`preimage-sixteen-${n}`, n, "uep-testnet"), deadline: w.h() + dl, orderNonce: n, ...(band ? { oracleBand: band } : {}) };
      const id = swapIntentId(intent);
      const { version, category, networkId, buyerId, marketMakerId, hashlock, deadline, orderNonce } = intent;
      return swap.open(T.act(m, "buyer", "swap-intent", id, { version, category, networkId, buyerId, marketMakerId, fromAsset: EUR, fromAmount: 1000n, toAsset: ENERGY, toAmount: 500n, hashlock, deadline, orderNonce, ...(band ? { oracleBand: band } : {}) }), intent, T.act(m, "maker", "swap-accept", id, { intentId: id }), { intentId: id });
    };
    const s1 = open(1, 200, { maxSkewPpm: 30_000n });
    const s2 = open(2, 25, { maxSkewPpm: 30_000n });
    degrade(w);
    assert.ok(IT.requestAs(iot, { buyerId: "ib3", listingId: L.listingId, machineId: "m1", quantity: 1n }).requestId);
    assert.throws(() => IT.requestAs(iot, { buyerId: "ib5", listingId: LB.listingId, machineId: "m1", quantity: 1n }), new RegExp(unavailable!));
    assert.ok(IT.holdAs(iot, req.requestId, "ib"));
    const t = IT.simulateAs(iot, req2.requestId, "m1", { kwh: "2" }, undefined, 2n);
    IT.deliverTelemetryAs(iot, req2.requestId, "p1", t);
    iot.verifyTelemetry(req2.requestId, t);
    assert.ok(IT.settleIoTAs(iot, req2.requestId, "ib2"));
    assert.equal(open(3, 100, { maxSkewPpm: 30_000n }).oracleCheck?.reason, unavailable);
    assert.throws(() => open(4, 100, { maxSkewPpm: 30_000n, onOracleUnavailable: "BLOCK_NEW" }), new RegExp(unavailable!));
    assert.equal(swap.settle(s1.intentId, "preimage-sixteen-1").state, "ATOMICALLY_SETTLED");
    w.setH(w.h() + 40);
    assert.equal(swap.expire(s2.intentId).state, "EXPIRED_REFUNDED");
    assert.equal(m.valueAccounting(EUR).conserved, true);
  }
});

test("outlier handling: one bad source is dropped; two sources that disagree are unavailable, not a price", () => {
  const w = world();
  w.adv(1);
  w.publish(ENERGY, EUR, 2_000_000n, w.keys, 2_000_001n * 2n); // third source at about 2x
  const q = w.gate.quote(ENERGY, EUR, w.h());
  assert.equal(q.priceE6, 2_000_000n);
  assert.equal(q.sourcesUsed, 2);
  // Only two sources, 10 % apart: no outlier can be told apart -> DEVIATION (unavailable, not a price).
  const w2 = world();
  w2.adv(1);
  w2.publish(ENERGY, EUR, 2_000_000n, [w2.keys[0]!]);
  w2.publish(ENERGY, EUR, 2_200_000n, [w2.keys[1]!]);
  assert.throws(() => w2.gate.quote(ENERGY, EUR, w2.h()), /ORACLE_DEVIATION/);
});
