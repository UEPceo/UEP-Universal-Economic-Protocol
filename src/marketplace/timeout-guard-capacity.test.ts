/**
 * v0.4.6:
 *  - UEP-D04: a dispute timeout configured as RELEASE runs the category
 *    settlement guard (IoT: verified telemetry of the delivered report for the
 *    full quantity) and refunds the buyer when it fails. The arbiter's explicit
 *    RELEASE / SPLIT stays final (documented arbiter trust) and is labelled.
 *  - UEP-D05: capacity returns to the listing exactly once when an order closes
 *    without consuming it (refund / unpaid part of a split); units executed per
 *    verified IoT telemetry stay consumed; available never exceeds capacity.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace, type ServiceOrder } from "./marketplace.ts";
import { IoTM2MService, IOT_M2M_CATEGORY } from "../service/iot-m2m.ts";
import { cancel, createTestAuthority, deliver, disputeAs, expire, fund, getOrder, publishAs, refundAs, reserveAs, resolveAs, settle } from "./testkit.ts";
import { deliverTelemetryAs, holdAs, registerMachineAs, registerProviderAs, requestAs, simulateAs } from "../service/iot-testkit.ts";

const DAY = 24 * 60 * 60 * 1000;
const ADMIN = createTestAuthority("ops-admin");
const ARBITER = createTestAuthority("arbiter-1");
type Config = ConstructorParameters<typeof DigitalServicesMarketplace>[0];

function base(config: Config = {}) {
  let now = 1_700_000_000_000;
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: () => now, adminIdentity: "ops-admin", adminPublicKey: ADMIN.publicKeyHex, settlementArbiterId: "arbiter-1", settlementArbiterPublicKey: ARBITER.publicKeyHex, ...config });
  return { m, advance(ms: number) { now += ms; }, now: () => now };
}

function iotSetup(config: Config = {}) {
  const s = base({ disputeTimeoutOutcome: "RELEASE", ...config });
  const iot = new IoTM2MService(s.m, { testOnlyNowMs: s.now, telemetryMaxAgeMs: 60_000 });
  registerProviderAs(iot, { providerId: "iot-prov", displayName: "Lab" });
  registerMachineAs(iot, { machineId: "machine-01", providerId: "iot-prov", serviceType: "sampling", model: "S1", endpointRef: "sim://machine-01" });
  const listing = publishAs(s.m, { providerId: "iot-prov", title: "Sampling", description: "IoT", category: IOT_M2M_CATEGORY, asset: "EUR", unitPrice: 100n, capacity: 10n });
  return { ...s, iot, listing };
}

/** request -> hold -> machine-signed execution of `units` -> provider-signed delivery (optionally verified). */
function iotDelivered(s: ReturnType<typeof iotSetup>, buyerId: string, opts: { quantity?: bigint; units?: bigint; verify?: boolean } = {}) {
  const r = requestAs(s.iot, { buyerId, listingId: s.listing.listingId, machineId: "machine-01", quantity: opts.quantity ?? 1n });
  holdAs(s.iot, r.requestId, buyerId);
  const t = simulateAs(s.iot, r.requestId, "machine-01", { status: "OK" }, undefined, opts.units);
  deliverTelemetryAs(s.iot, r.requestId, "iot-prov", t);
  if (opts.verify) s.iot.verifyTelemetry(r.requestId, t);
  return { requestId: r.requestId, orderId: s.iot.orderIdOf(r.requestId) };
}

function conserved(m: DigitalServicesMarketplace, listingId: string) {
  const v = m.valueAccounting("EUR");
  assert.equal(v.conserved, true, "value conserved");
  const c = m.capacityAccounting(listingId);
  assert.equal(c.conserved, true, `capacity conserved ${JSON.stringify(c, (_k, x) => (typeof x === "bigint" ? x.toString() : x))}`);
  assert.ok(c.available <= c.capacity, "available <= capacity");
  return c;
}

// ------------------------------------------------------------------ D04

test("D04: RELEASE timeout with verified full telemetry pays the provider", () => {
  const s = iotSetup();
  const o = iotDelivered(s, "buyer", { verify: true });
  disputeAs(s.m, "buyer", o.orderId, "late");
  s.advance(7 * DAY);
  const r = settle(s.m, o.orderId, "iot-prov");
  assert.equal(r.outcome, "RELEASE");
  assert.equal(r.providerPayout, 97n);
  assert.equal(r.marketplaceFee, 3n);
  assert.equal(r.categoryGuard, "PASSED");
  assert.equal(r.capacityRestored, 0n);
  assert.equal(getOrder(s.m, o.orderId, "buyer").disputeOutcome, "TIMEOUT_RELEASE");
  assert.equal(s.m.availableBalance("EUR", "iot-prov"), 97n);
  assert.equal(s.m.availableBalance("EUR", "buyer"), 10_000n - 100n);
  const c = conserved(s.m, s.listing.listingId);
  assert.equal(c.available, 9n);
  assert.equal(c.consumed, 1n);
});

test("D04: RELEASE timeout without verified telemetry refunds the buyer in full, no value lost", () => {
  const s = iotSetup();
  const o = iotDelivered(s, "buyer"); // delivered, never verified
  assert.throws(() => settle(s.m, o.orderId, "buyer"), /IOT_VERIFICATION_REQUIRED/);
  disputeAs(s.m, "buyer", o.orderId, "unverified");
  const before = s.m.valueAccounting("EUR").credited;
  s.advance(7 * DAY);
  const r = settle(s.m, o.orderId, "iot-prov");
  assert.equal(r.outcome, "REFUND_BUYER");
  assert.equal(r.providerPayout, 0n);
  assert.equal(r.marketplaceFee, 0n);
  assert.equal(r.buyerRefund, 100n);
  assert.equal(r.categoryGuard, "TIMEOUT_REFUNDED");
  assert.equal(r.capacityRestored, 1n);
  const order = getOrder(s.m, o.orderId, "buyer");
  assert.equal(order.status, "REFUNDED");
  assert.equal(order.disputeOutcome, "TIMEOUT_REFUND_UNVERIFIED");
  assert.equal(s.m.availableBalance("EUR", "buyer"), 10_000n);
  assert.equal(s.m.availableBalance("EUR", "iot-prov"), 0n);
  assert.equal(s.m.treasury.totalOf("EUR"), 0n);
  assert.equal(s.m.valueAccounting("EUR").credited, before);
  // Repeated settle calls (any party) return the same record; nothing moves twice.
  assert.deepEqual(settle(s.m, o.orderId, "buyer"), r);
  assert.deepEqual(settle(s.m, o.orderId, "arbiter-1"), r);
  const c = conserved(s.m, s.listing.listingId);
  assert.equal(c.available, 10n);
});

test("D04: RELEASE timeout with a verified shortfall (3 of 4 units) refunds; executed units stay consumed", () => {
  const s = iotSetup();
  const o = iotDelivered(s, "buyer", { quantity: 4n, units: 3n, verify: true });
  disputeAs(s.m, "buyer", o.orderId, "short");
  s.advance(7 * DAY);
  const r = settle(s.m, o.orderId, "buyer");
  assert.equal(r.outcome, "REFUND_BUYER");
  assert.equal(r.buyerRefund, 400n);
  assert.equal(r.categoryGuard, "TIMEOUT_REFUNDED");
  assert.equal(r.capacityRestored, 1n);
  assert.equal(s.m.availableBalance("EUR", "buyer"), 10_000n);
  const c = conserved(s.m, s.listing.listingId);
  assert.equal(c.available, 7n);
  assert.equal(c.consumed, 3n);
});

test("D04: an IoT listing with no attached IoT service never releases on timeout", () => {
  const s = base({ disputeTimeoutOutcome: "RELEASE" });
  const listing = publishAs(s.m, { providerId: "p", title: "iot", description: "iot", category: IOT_M2M_CATEGORY, asset: "EUR", unitPrice: 100n, capacity: 3n });
  const o = reserveAs(s.m, { listingId: listing.listingId, buyerId: "b", quantity: 1n }, { credit: 1_000n });
  fund(s.m, o.orderId, o.fundingDue);
  deliver(s.m, o.orderId, "p", Buffer.from("raw"));
  assert.throws(() => settle(s.m, o.orderId, "b"), /IOT_SETTLEMENT_GUARD_REQUIRED/);
  disputeAs(s.m, "b", o.orderId, "r");
  s.advance(7 * DAY);
  const r = settle(s.m, o.orderId, "p");
  assert.equal(r.outcome, "REFUND_BUYER");
  assert.equal(r.categoryGuard, "TIMEOUT_REFUNDED");
  assert.equal(s.m.availableBalance("EUR", "b"), 1_000n);
  assert.equal(conserved(s.m, listing.listingId).available, 3n);
});

test("D04: any category guard gates a RELEASE timeout; unguarded categories release as before", () => {
  const s = base({ disputeTimeoutOutcome: "RELEASE" });
  let allow = false;
  s.m.attachCategoryService("DATA", { settlementGuard: () => { if (!allow) throw new Error("DATA_NOT_VALIDATED"); } });
  const data = publishAs(s.m, { providerId: "p", title: "data", description: "d", category: "DATA", asset: "EUR", unitPrice: 100n, capacity: 2n });
  const compute = publishAs(s.m, { providerId: "p", title: "gpu", description: "c", category: "COMPUTE", asset: "EUR", unitPrice: 100n, capacity: 2n });
  const run = (listingId: string, buyerId: string) => {
    const o = reserveAs(s.m, { listingId, buyerId, quantity: 1n }, { credit: 1_000n });
    fund(s.m, o.orderId, o.fundingDue);
    deliver(s.m, o.orderId, "p", Buffer.from(buyerId));
    disputeAs(s.m, buyerId, o.orderId, "r");
    return o.orderId;
  };
  const blocked = run(data.listingId, "b1");
  const passing = run(data.listingId, "b2");
  const plain = run(compute.listingId, "b3");
  s.advance(7 * DAY);
  assert.equal(settle(s.m, blocked, "p").categoryGuard, "TIMEOUT_REFUNDED");
  allow = true;
  const ok = settle(s.m, passing, "p");
  assert.equal(ok.outcome, "RELEASE");
  assert.equal(ok.categoryGuard, "PASSED");
  const released = settle(s.m, plain, "p");
  assert.equal(released.outcome, "RELEASE");
  assert.equal(released.categoryGuard, undefined);
  assert.equal(getOrder(s.m, plain, "b3").disputeOutcome, "TIMEOUT_RELEASE");
  conserved(s.m, data.listingId);
  conserved(s.m, compute.listingId);
});

test("D04: the default REFUND_BUYER timeout is unchanged; buyer withdrawal still needs verified telemetry", () => {
  const s = iotSetup({ disputeTimeoutOutcome: "REFUND_BUYER" });
  const a = iotDelivered(s, "b1", { verify: true });
  disputeAs(s.m, "b1", a.orderId, "r");
  const b = iotDelivered(s, "b2");
  disputeAs(s.m, "b2", b.orderId, "r");
  assert.throws(() => settle(s.m, b.orderId, "b2"), /IOT_VERIFICATION_REQUIRED/); // withdrawal is guarded
  s.advance(7 * DAY);
  const r = settle(s.m, a.orderId, "iot-prov");
  assert.equal(r.outcome, "REFUND_BUYER");
  assert.equal(getOrder(s.m, a.orderId, "b1").disputeOutcome, "TIMEOUT_REFUND");
  assert.equal(r.capacityRestored, 0n); // executed per verified telemetry: consumed
  assert.equal(settle(s.m, b.orderId, "iot-prov").capacityRestored, 1n);
  assert.equal(conserved(s.m, s.listing.listingId).available, 9n);
});

test("D04: the arbiter's explicit RELEASE stays final and is labelled PASSED or ARBITER_OVERRIDE", () => {
  const s = iotSetup();
  const verified = iotDelivered(s, "b1", { verify: true });
  const unverified = iotDelivered(s, "b2");
  disputeAs(s.m, "b1", verified.orderId, "r");
  disputeAs(s.m, "b2", unverified.orderId, "r");
  const a = resolveAs(s.m, "arbiter-1", verified.orderId, { outcome: "RELEASE" });
  assert.equal(a.categoryGuard, "PASSED");
  const b = resolveAs(s.m, "arbiter-1", unverified.orderId, { outcome: "RELEASE" });
  assert.equal(b.outcome, "RELEASE");
  assert.equal(b.providerPayout, 97n);
  assert.equal(b.categoryGuard, "ARBITER_OVERRIDE");
  assert.equal(conserved(s.m, s.listing.listingId).available, 8n);
});

// ------------------------------------------------------------------ D05

function computeSetup(config: Config = {}) {
  const s = base(config);
  const listing = publishAs(s.m, { providerId: "prov", title: "GPU", description: "c", category: "COMPUTE", asset: "EUR", unitPrice: 100n, capacity: 5n });
  const delivered = (buyerId: string, quantity: bigint) => {
    const o = reserveAs(s.m, { listingId: listing.listingId, buyerId, quantity }, { credit: 10_000n });
    fund(s.m, o.orderId, o.fundingDue);
    deliver(s.m, o.orderId, "prov", Buffer.from(`${buyerId}:${o.orderId}`));
    return o.orderId;
  };
  return { ...s, listing, delivered };
}

test("D05: a post-delivery refund returns capacity exactly once", () => {
  const s = computeSetup();
  const id = s.delivered("buyer", 2n);
  assert.equal(s.m.getListing(s.listing.listingId).available, 3n);
  disputeAs(s.m, "buyer", id, "bad");
  const r = resolveAs(s.m, "arbiter-1", id, { outcome: "REFUND_BUYER" });
  assert.equal(r.capacityRestored, 2n);
  assert.equal(s.m.getListing(s.listing.listingId).available, 5n);
  // Replays of every closing path are idempotent or rejected; capacity does not move again.
  assert.deepEqual(resolveAs(s.m, "arbiter-1", id, { outcome: "REFUND_BUYER" }), r);
  assert.deepEqual(settle(s.m, id, "buyer"), r);
  assert.deepEqual(refundAs(s.m, "prov", id), r);
  assert.throws(() => cancel(s.m, id, "buyer"), /ORDER_ALREADY_SETTLED/);
  assert.throws(() => expire(s.m, id, "buyer"), /ORDER_ALREADY_SETTLED/);
  const order = getOrder(s.m, id, "buyer");
  assert.equal(order.capacityRestored, 2n);
  assert.equal(order.capacityConsumed, 0n);
  const c = conserved(s.m, s.listing.listingId);
  assert.equal(c.available, 5n);
});

test("D05: provider refund and timeout refund return capacity; release consumes it", () => {
  const s = computeSetup();
  const a = s.delivered("b1", 1n);
  const b = s.delivered("b2", 1n);
  const c = s.delivered("b3", 2n);
  assert.equal(s.m.getListing(s.listing.listingId).available, 1n);
  assert.equal(refundAs(s.m, "prov", a).capacityRestored, 1n);
  disputeAs(s.m, "b2", b, "r");
  s.advance(7 * DAY);
  assert.equal(settle(s.m, b, "prov").capacityRestored, 1n);
  assert.equal(settle(s.m, c, "b3").capacityRestored, 0n);
  const acct = conserved(s.m, s.listing.listingId);
  assert.equal(acct.available, 3n);
  assert.equal(acct.consumed, 2n);
  assert.equal(acct.reserved, 0n);
});

test("D05: a SPLIT returns only the unpaid units (paid units rounded up)", () => {
  const s = computeSetup();
  const id = s.delivered("buyer", 4n); // gross 400
  disputeAs(s.m, "buyer", id, "partial");
  const r = resolveAs(s.m, "arbiter-1", id, { outcome: "SPLIT", providerAmount: 150n }); // 1.5 units paid -> 2 consumed
  assert.equal(r.outcome, "SPLIT");
  assert.equal(r.capacityRestored, 2n);
  assert.equal(r.categoryGuard, undefined);
  const acct = conserved(s.m, s.listing.listingId);
  assert.equal(acct.available, 3n);
  assert.equal(acct.consumed, 2n);
});

test("D05: IoT units executed per verified telemetry are not returned on refund or split", () => {
  const s = iotSetup({ disputeTimeoutOutcome: "REFUND_BUYER" });
  const full = iotDelivered(s, "b1", { quantity: 2n, verify: true });
  disputeAs(s.m, "b1", full.orderId, "r");
  const r1 = resolveAs(s.m, "arbiter-1", full.orderId, { outcome: "REFUND_BUYER" });
  assert.equal(r1.buyerRefund, 200n);
  assert.equal(r1.capacityRestored, 0n);
  const partial = iotDelivered(s, "b2", { quantity: 4n, units: 3n, verify: true });
  assert.equal(refundAs(s.m, "iot-prov", partial.orderId).capacityRestored, 1n);
  const split = iotDelivered(s, "b3", { quantity: 4n, units: 3n, verify: true });
  disputeAs(s.m, "b3", split.orderId, "short");
  const r3 = resolveAs(s.m, "arbiter-1", split.orderId, { outcome: "SPLIT", providerAmount: 300n });
  assert.equal(r3.capacityRestored, 1n);
  assert.equal(r3.categoryGuard, "ARBITER_OVERRIDE"); // guard requires the full quantity
  const unverified = iotDelivered(s, "b4", { quantity: 1n });
  assert.equal(refundAs(s.m, "iot-prov", unverified.orderId).capacityRestored, 1n);
  const acct = conserved(s.m, s.listing.listingId);
  assert.equal(acct.consumed, 2n + 3n + 3n);
  assert.equal(acct.available, 10n - 8n);
  assert.equal(s.m.valueAccounting("EUR").conserved, true);
});

test("D05: out-of-range category evidence is clamped; capacity never exceeds its maximum", () => {
  const s = base();
  let reported = -5n;
  s.m.attachCategoryService("API", { consumedUnits: () => reported });
  const listing = publishAs(s.m, { providerId: "p", title: "api", description: "a", category: "API", asset: "EUR", unitPrice: 10n, capacity: 3n });
  const open = (buyerId: string, quantity: bigint) => {
    const o = reserveAs(s.m, { listingId: listing.listingId, buyerId, quantity }, { credit: 1_000n });
    fund(s.m, o.orderId, o.fundingDue);
    deliver(s.m, o.orderId, "p", Buffer.from(buyerId));
    return o.orderId;
  };
  const a = open("b1", 3n);
  assert.equal(refundAs(s.m, "p", a).capacityRestored, 3n); // negative evidence -> 0 consumed
  reported = 99n;
  const b = open("b2", 2n);
  assert.equal(refundAs(s.m, "p", b).capacityRestored, 0n); // above quantity -> quantity consumed
  const acct = conserved(s.m, listing.listingId);
  assert.equal(acct.available, 1n);
  assert.equal(acct.consumed, 2n);
});

test("D05: capacity stays within [0, capacity] and conserved across every closing path", () => {
  const s = computeSetup({ disputeTimeoutOutcome: "RELEASE" });
  const L = s.listing.listingId;
  const max = s.m.getListing(L).capacity;
  const check = () => {
    const acct = conserved(s.m, L);
    assert.ok(acct.available >= 0n && acct.available <= max);
  };
  for (let round = 0; round < 4; round++) {
    // Fill the listing completely, then close each order a different way.
    const ids: string[] = [];
    while (s.m.getListing(L).available > 0n) {
      ids.push(s.delivered(`r${round}-b${ids.length}`, 1n));
      check();
    }
    assert.equal(s.m.getListing(L).available, 0n);
    const [first, second, third, fourth, fifth] = ids as [string, string, string, string, string | undefined];
    const buyerOf = (id: string) => getOrder(s.m, id, "ops-admin").buyerId;
    refundAs(s.m, "prov", first); check();
    disputeAs(s.m, buyerOf(second), second, "r"); resolveAs(s.m, "arbiter-1", second, { outcome: "REFUND_BUYER" }); check();
    disputeAs(s.m, buyerOf(third), third, "r"); resolveAs(s.m, "arbiter-1", third, { outcome: "SPLIT", providerAmount: 0n }); check();
    if (fourth) { refundAs(s.m, "prov", fourth); check(); }
    if (fifth) { refundAs(s.m, "prov", fifth); check(); }
    assert.equal(s.m.getListing(L).available, max, `round ${round}: every refunded unit is back, none extra`);
    // An unfunded reservation cancelled within grace also returns exactly once.
    const o: ServiceOrder = reserveAs(s.m, { listingId: L, buyerId: `r${round}-c`, quantity: 2n }, { credit: 1_000n });
    cancel(s.m, o.orderId, "prov");
    cancel(s.m, o.orderId, "prov");
    check();
    assert.equal(s.m.getListing(L).available, max);
  }
  // Finally consume one unit through a release: it never comes back.
  const last = s.delivered("final", 1n);
  settle(s.m, last, "final");
  check();
  assert.equal(s.m.getListing(L).available, max - 1n);
});

test("category hooks can only be attached before the category has listings or orders", () => {
  const m = new DigitalServicesMarketplace({ testOnlyLocalHeight: true });
  m.attachCategoryService("DATA", {}); // empty category: allowed
  publishAs(m, { providerId: "p", title: "api", description: "a", category: "API", asset: "EUR", unitPrice: 10n, capacity: 3n });
  assert.throws(() => m.attachCategoryService("API", { settlementGuard: () => undefined }), /CATEGORY_SERVICE_IN_USE/);
  const late = new DigitalServicesMarketplace({ testOnlyLocalHeight: true });
  publishAs(late, { providerId: "p", title: "sensor", description: "s", category: IOT_M2M_CATEGORY, asset: "EUR", unitPrice: 10n, capacity: 3n });
  assert.throws(() => new IoTM2MService(late), /CATEGORY_SERVICE_IN_USE/);
});
