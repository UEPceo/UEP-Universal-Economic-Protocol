/**
 * v0.5.0 (ADR 0002 rules 1 and 2): Marketplace windows are block heights, and
 * each listing fixes a domain profile (EARTH / MOON / MARS) at publication
 * whose fixed delay is added to every counterparty window.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace, DEFAULT_RESERVATION_TTL_HEIGHTS } from "./marketplace.ts";
import { MarketplacePaymaster } from "./paymaster.ts";
import { act, createTestAuthority, deliver, disputeAs, enrollIdentity, fund, getOrder, publishAs, reserveAs, settle } from "./testkit.ts";
import { listingTerms } from "./identity.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { TESTNET } from "../network/profiles.ts";
import { DOMAIN_PROFILES } from "../core/domain-profiles.ts";

const ARBITER = createTestAuthority("dw-arbiter");
const base = { providerId: "prov", description: "gpu", category: "COMPUTE" as const, asset: "EUR", unitPrice: 100n, capacity: 100n };

function setup(config: ConstructorParameters<typeof DigitalServicesMarketplace>[0] = {}) {
  const clock = config.height || config.now || config.testOnlyNowMs ? {} : { testOnlyLocalHeight: true };
  const m = new DigitalServicesMarketplace({ settlementArbiterId: "dw-arbiter", settlementArbiterPublicKey: ARBITER.publicKeyHex, ...clock, ...config });
  return m;
}

test("windows: the default Marketplace counts heights; base windows are the previous defaults at 5 s blocks", () => {
  const m = setup();
  assert.equal(m.timeUnit, "height");
  assert.equal(m.clock(), 0);
  assert.deepEqual({ ...m.baseWindows }, { reservationTtl: 120, cancellationGrace: 24, deliveryDisputeWindow: 17_280, disputeResolutionWindow: 120_960, readAuthorizationTtl: 60, listingWindow: 720 });
  assert.equal(DEFAULT_RESERVATION_TTL_HEIGHTS, 120);
  // Nominal ms fields keep their previous values.
  assert.equal(m.reservationTtlMs, 600_000);
  assert.equal(m.cancellationGraceMs, 120_000);
  assert.equal(m.deliveryDisputeWindowMs, 86_400_000);
  // Legacy ms options are converted to heights (ceil); heights options are taken as is.
  assert.equal(setup({ reservationTtlMs: 60_001 }).baseWindows.reservationTtl, 13);
  assert.equal(setup({ reservationTtlHeights: 7 }).baseWindows.reservationTtl, 7);
  assert.throws(() => setup({ reservationTtlHeights: 7, reservationTtlMs: 1 }), /CLOCK_CONFIG_CONFLICT/);
  assert.throws(() => setup({ reservationTtlHeights: 0 }), /INVALID_RESERVATION_LIMIT/);
  assert.throws(() => setup({ height: () => 0, now: () => 0 }), /CLOCK_CONFIG_CONFLICT/);
  assert.throws(() => setup({ paymaster: new MarketplacePaymaster({ testOnlyNowMs: () => 0 }) }), /CLOCK_CONFIG_CONFLICT/);
  assert.equal(m.advanceHeight(3), 3);
  assert.equal(m.clock(), 3);
});

test("windows: EARTH / MOON / MARS listings fix base + 0 / 1 / 602 heights at publication", () => {
  const m = setup();
  const earth = publishAs(m, { ...base, title: "Earth compute" });
  const moon = publishAs(m, { ...base, title: "Moon relay", domainProfile: "MOON" });
  const mars = publishAs(m, { ...base, title: "Mars lab", domainProfile: "MARS" });
  assert.equal(earth.domainProfile, "EARTH");
  assert.deepEqual(earth.windows, { referenceBlockTimeMs: 5_000, domainDelay: 0, reservationTtl: 120, cancellationGrace: 24, deliveryDisputeWindow: 17_280, disputeResolutionWindow: 120_960 });
  assert.equal(moon.delayHeights, 1);
  assert.equal(moon.windows.reservationTtl, 121);
  assert.equal(mars.delayHeights, DOMAIN_PROFILES.MARS.delayHeights);
  assert.deepEqual(mars.windows, { referenceBlockTimeMs: 5_000, domainDelay: 602, reservationTtl: 722, cancellationGrace: 626, deliveryDisputeWindow: 17_882, disputeResolutionWindow: 121_562 });
  // Immutable: callers get copies.
  const copy = m.getListing(mars.listingId);
  copy.windows.reservationTtl = 1;
  (copy as { domainProfile: string }).domainProfile = "EARTH";
  assert.equal(m.getListing(mars.listingId).windows.reservationTtl, 722);
  assert.equal(m.getListing(mars.listingId).domainProfile, "MARS");
  assert.equal(m.searchListings({ category: "COMPUTE", asset: "EUR" }).find((l) => l.listingId === mars.listingId)!.windows.reservationTtl, 722);
  // The profile is a signed term: a signature over EARTH terms does not publish a MARS listing.
  enrollIdentity(m, "prov");
  const input = { ...base, title: "Mars lab two" };
  assert.throws(() => m.publishListing({ ...input, domainProfile: "MARS" }, act(m, "prov", "publish", "", listingTerms(input))), /ACTOR_SIGNATURE_INVALID/);
  assert.throws(() => publishAs(m, { ...base, title: "Venus", domainProfile: "VENUS" as never }), /DOMAIN_PROFILE_INVALID/);
  // EARTH terms (and signatures) are unchanged.
  assert.deepEqual(Object.keys(listingTerms({ ...input, domainProfile: "EARTH" })).sort(), ["asset", "capacity", "category", "description", "sellerBond", "title", "unitPrice"]);
  const q = m.checkoutQuote(mars.listingId, 1n);
  assert.equal(q.domainProfile, "MARS");
  assert.equal(q.delayHeights, 602);
  assert.equal(q.reservationTtlHeights, 722);
  assert.equal(q.reservationTtlMs, 722 * 5_000);
});

test("windows: reservations expire by height; MARS orders keep the listing's windows", () => {
  const m = setup();
  const earth = publishAs(m, { ...base, title: "Earth compute" });
  const mars = publishAs(m, { ...base, title: "Mars lab", domainProfile: "MARS" });
  const e = reserveAs(m, { listingId: earth.listingId, buyerId: "buyer", quantity: 1n });
  const r = reserveAs(m, { listingId: mars.listingId, buyerId: "buyer", quantity: 1n });
  assert.equal(e.reservationExpiresAt, 120);
  assert.equal(r.reservationExpiresAt, 722);
  assert.equal(r.domainProfile, "MARS");
  assert.deepEqual(r.windows, mars.windows);
  m.advanceHeight(120);
  assert.ok(fund(m, e.orderId, e.fundingDue)); // at the TTL height the reservation is still live
  m.advanceHeight(600);
  const funded = fund(m, r.orderId, r.fundingDue);
  assert.equal(funded.status, "HELD");
  m.advanceHeight(3); // height 723 > 722
  assert.throws(() => deliver(m, r.orderId, "prov", Buffer.from("late")), /RESERVATION_EXPIRED/);
  assert.equal(getOrder(m, r.orderId, "buyer").status, "EXPIRED");
  assert.equal(m.valueAccounting("EUR").conserved, true);
});

test("windows: dispute and provider-claim windows are heights plus the domain delay", () => {
  const m = setup();
  const mars = publishAs(m, { ...base, title: "Mars lab", domainProfile: "MARS" });
  const o = reserveAs(m, { listingId: mars.listingId, buyerId: "buyer", quantity: 1n });
  fund(m, o.orderId, o.fundingDue);
  deliver(m, o.orderId, "prov", Buffer.from("report"));
  m.advanceHeight(17_881);
  assert.throws(() => settle(m, o.orderId, "prov"), /SETTLEMENT_DISPUTE_WINDOW_ACTIVE/);
  const d = disputeAs(m, "buyer", o.orderId, "late report"); // still inside 17_280 + 602
  assert.equal(d.disputeDeadline, 17_881 + 121_562);
  m.advanceHeight(121_562);
  const timedOut = settle(m, o.orderId, "buyer");
  assert.equal(timedOut.outcome, "REFUND_BUYER");
  // EARTH: the provider can claim right after 17_280 heights.
  const m2 = setup();
  const earth = publishAs(m2, { ...base, title: "Earth compute" });
  const o2 = reserveAs(m2, { listingId: earth.listingId, buyerId: "buyer", quantity: 1n });
  fund(m2, o2.orderId, o2.fundingDue);
  deliver(m2, o2.orderId, "prov", Buffer.from("report"));
  m2.advanceHeight(17_279);
  assert.throws(() => settle(m2, o2.orderId, "prov"), /SETTLEMENT_DISPUTE_WINDOW_ACTIVE/);
  m2.advanceHeight(1);
  assert.equal(settle(m2, o2.orderId, "prov").outcome, "RELEASE");
});

test("windows: the Marketplace can take its height from the testnet ledger", () => {
  const ledger = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true });
  const m = setup({ height: () => ledger.height });
  assert.throws(() => m.advanceHeight(), /HEIGHT_SOURCE_EXTERNAL/);
  const earth = publishAs(m, { ...base, title: "Earth compute" });
  const o = reserveAs(m, { listingId: earth.listingId, buyerId: "buyer", quantity: 1n });
  ledger.advanceHeight(121);
  assert.throws(() => fund(m, o.orderId, o.fundingDue), /RESERVATION_EXPIRED/);
  assert.equal(m.clock(), 121);
  // A height source that goes backwards is refused.
  let h = 5;
  const m2 = setup({ height: () => h });
  assert.equal(m2.clock(), 5);
  h = 4;
  assert.throws(() => m2.clock(), /HEIGHT_REGRESSED/);
});

test("windows: the test-only legacy ms clock gives MARS (base + 602 heights) x 5000 ms", () => {
  let now = 1_000_000;
  const m = setup({ testOnlyNowMs: () => now });
  assert.equal(m.timeUnit, "legacy-ms");
  assert.throws(() => m.advanceHeight(), /HEIGHT_SOURCE_EXTERNAL/);
  const mars = publishAs(m, { ...base, title: "Mars lab", domainProfile: "MARS" });
  assert.equal(mars.windows.reservationTtl, (120 + 602) * 5_000);
  const o = reserveAs(m, { listingId: mars.listingId, buyerId: "buyer", quantity: 1n });
  now += 1_203_600 * 2;
  assert.equal(fund(m, o.orderId, o.fundingDue).status, "HELD");
});

test("the reference block time is part of the network profile and of the published windows", async () => {
  const { TESTNET } = await import("../network/profiles.ts");
  const { REFERENCE_BLOCK_TIME_MS } = await import("../core/height.ts");
  assert.equal(TESTNET.referenceBlockTimeMs, REFERENCE_BLOCK_TIME_MS);
  const m = new DigitalServicesMarketplace({ testOnlyLocalHeight: true });
  assert.equal(m.contractWindowsFor("MARS").referenceBlockTimeMs, 5_000);
});
