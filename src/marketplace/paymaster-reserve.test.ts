/** v0.5.0 paymaster reserve protection: expiry sweep, per-actor and per-order caps. */
import assert from "node:assert/strict";
import test from "node:test";
import { DigitalServicesMarketplace } from "./marketplace.ts";
import { MarketplacePaymaster } from "./paymaster.ts";
import { cancelAsBuyer, deliver, fund, publishAs, reserveAs, settle } from "./testkit.ts";

test("1,000 fake orders: lapsed sponsorships are released and the reserve is whole again", () => {
  let now = 1_000_000;
  const paymaster = new MarketplacePaymaster({ testOnlyNowMs: () => now, maxActorShareBps: 10_000, maxOrderShareBps: 10_000, maxOutstandingPerActor: 1_000 });
  paymaster.fundReserve("EUR", 10_000n);
  for (let i = 0; i < 1_000; i++) {
    const q = paymaster.quote("EUR", 10n, now);
    paymaster.sponsor(`fake-${i}`, q, now, { actorId: `sybil-${i % 50}`, holdUntil: now + 60_000 + i });
  }
  assert.equal(paymaster.reserveOf("EUR"), 0n);
  assert.equal(paymaster.outstandingOf("EUR"), 10_000n);
  assert.throws(() => paymaster.sponsor("one-more", paymaster.quote("EUR", 10n, now), now), /PAYMASTER_RESERVE_INSUFFICIENT/);
  // Half have lapsed: the lazy sweep inside sponsor() frees them first.
  now += 60_000 + 500;
  const q = paymaster.quote("EUR", 10n, now);
  paymaster.sponsor("honest-1", q, now, { actorId: "honest", holdUntil: now + 1 });
  // 500 lapsed (holdUntil < now) were released; 500 fake + 1 honest remain.
  assert.equal(paymaster.openSponsorships(), 501);
  // The rest lapse; an explicit sweep releases them.
  now += 10_000;
  const swept = paymaster.sweepExpired(now);
  assert.equal(swept.length, 501);
  assert.equal(paymaster.openSponsorships(), 0);
  assert.equal(paymaster.outstandingOf("EUR"), 0n);
  assert.equal(paymaster.reserveOf("EUR"), 10_000n);
  for (let i = 0; i < 50; i++) assert.deepEqual(paymaster.actorOutstandingOf(`sybil-${i}`, "EUR"), { count: 0, amount: 0n });
});

test("per-actor count, per-actor share and per-order caps", () => {
  const now = 5_000;
  const p = new MarketplacePaymaster({ testOnlyNowMs: () => now, maxOutstandingPerActor: 3 });
  p.fundReserve("EUR", 1_000n);
  for (let i = 0; i < 3; i++) p.sponsor(`o${i}`, p.quote("EUR", 10n, now), now, { actorId: "a" });
  assert.throws(() => p.sponsor("o3", p.quote("EUR", 10n, now), now, { actorId: "a" }), /PAYMASTER_ACTOR_LIMIT_REACHED/);
  // Order share: default 10% of capacity (1000) = 100.
  assert.throws(() => p.sponsor("big", p.quote("EUR", 101n, now), now, { actorId: "b" }), /PAYMASTER_ORDER_CAP_EXCEEDED/);
  // Actor share: default 25% of capacity = 250.
  p.sponsor("b1", p.quote("EUR", 100n, now), now, { actorId: "b" });
  p.sponsor("b2", p.quote("EUR", 100n, now), now, { actorId: "b" });
  assert.throws(() => p.sponsor("b3", p.quote("EUR", 51n, now), now, { actorId: "b" }), /PAYMASTER_ACTOR_CAP_EXCEEDED/);
  p.sponsor("b3", p.quote("EUR", 50n, now), now, { actorId: "b" });
  const abs = new MarketplacePaymaster({ testOnlyNowMs: () => now, maxGasPerOrder: 5n });
  abs.fundReserve("EUR", 1_000n);
  assert.throws(() => abs.sponsor("x", abs.quote("EUR", 6n, now), now), /PAYMASTER_ORDER_CAP_EXCEEDED/);
});

test("release is idempotent, a swept sponsorship cannot be captured, a pinned one survives the sweep", () => {
  let now = 0;
  const p = new MarketplacePaymaster({ testOnlyNowMs: () => now });
  p.fundReserve("EUR", 1_000n);
  const q1 = p.quote("EUR", 10n, now);
  p.sponsor("a", q1, now, { actorId: "x", holdUntil: 100 });
  const q2 = p.quote("EUR", 20n, now);
  p.sponsor("b", q2, now, { actorId: "y", holdUntil: 100 });
  p.pin("b", q2.quoteId);
  now = 101;
  assert.deepEqual(p.sweepExpired(now), ["a"]);
  p.release("a", q1);
  p.release("a", q1);
  assert.throws(() => p.capture("a", q1, now), /PAYMASTER_SPONSOR_REQUIRED/);
  assert.equal(p.capture("b", q2, now).gasFee, 20n);
  assert.equal(p.reserveOf("EUR"), 1_000n);
  assert.equal(p.outstandingOf("EUR"), 0n);
});

test("marketplace: a lapsed reservation releases its gas automatically; delivered orders keep it until settlement", () => {
  let now = 10_000;
  const paymaster = new MarketplacePaymaster({ testOnlyNowMs: () => now });
  paymaster.fundReserve("EUR", 1_000n);
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: () => now, paymaster, reservationTtlMs: 1_000 });
  const listing = publishAs(m, { providerId: "p", title: "Gas API sweep", description: "api", category: "API", asset: "EUR", unitPrice: 100n, capacity: 10n });
  const lapsed = reserveAs(m, { listingId: listing.listingId, buyerId: "idle", quantity: 1n, gasQuote: m.checkoutQuote(listing.listingId, 1n, 5n).gasQuote });
  const kept = reserveAs(m, { listingId: listing.listingId, buyerId: "b", quantity: 1n, gasQuote: m.checkoutQuote(listing.listingId, 1n, 5n).gasQuote });
  fund(m, kept.orderId, kept.fundingDue);
  deliver(m, kept.orderId, "p", Buffer.from("ok"));
  assert.equal(paymaster.reserveOf("EUR"), 990n);
  now += 1_001;
  // Nobody touches the lapsed order: the paymaster sweep alone frees its gas.
  assert.deepEqual(paymaster.sweepExpired(now), [lapsed.orderId]);
  assert.equal(paymaster.reserveOf("EUR"), 995n);
  // Closing the order later is consistent (release is a no-op).
  const third = reserveAs(m, { listingId: listing.listingId, buyerId: "c", quantity: 1n, gasQuote: m.checkoutQuote(listing.listingId, 1n, 5n).gasQuote });
  assert.equal(m.valueAccounting("EUR").conserved, true);
  cancelAsBuyer(m, third.orderId, "c");
  assert.equal(settle(m, kept.orderId, "b").gasFee, 5n);
  assert.equal(paymaster.reserveOf("EUR"), 1_000n);
  assert.equal(paymaster.outstandingOf("EUR"), 0n);
});
