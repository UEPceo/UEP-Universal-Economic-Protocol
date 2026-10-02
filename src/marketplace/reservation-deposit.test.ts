/**
 * v0.4.3 reservations cost something (UEP-A10): funded deposits locked at
 * reserve(), registered + signed identities only, grace-window cancellation,
 * expiry forfeit, concurrency limit and value conservation on every path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "./marketplace.ts";
import { MarketplacePaymaster } from "./paymaster.ts";
import { createMarketplaceIdentity, signCancellation, signReservation } from "./identity.ts";
import { cancelAsBuyer, enrollIdentity, reserveAs } from "./testkit.ts";

const T0 = 1_700_000_000_000;

function setup(config: ConstructorParameters<typeof DigitalServicesMarketplace>[0] = {}) {
  let now = T0;
  const m = new DigitalServicesMarketplace({ now: () => now, reservationTtlMs: 10 * 60_000, cancellationGraceMs: 2 * 60_000, ...config });
  const listing = m.publishListing({ providerId: "prov", title: "Compute", description: "gpu", category: "COMPUTE", asset: "EUR", unitPrice: 500n, capacity: 100n });
  enrollIdentity(m, "buyer", { asset: "EUR", amount: 10_000n });
  return { m, listing, advance(ms: number) { now += ms; } };
}

function assertConserved(m: DigitalServicesMarketplace) {
  const a = m.valueAccounting("EUR");
  assert.equal(a.conserved, true, JSON.stringify(a, (_k, v) => typeof v === "bigint" ? v.toString() : v));
  return a;
}

test("A10: an unregistered identity cannot reserve (fail-closed)", () => {
  const { m, listing } = setup();
  const stranger = createMarketplaceIdentity("stranger");
  const signature = signReservation({ marketplaceId: m.marketplaceId, listingId: listing.listingId, buyerId: "stranger", quantity: 1n, idempotencyKey: "k1" }, stranger.privateKey);
  assert.throws(() => m.reserve({ listingId: listing.listingId, buyerId: "stranger", quantity: 1n, idempotencyKey: "k1", signature }), /IDENTITY_NOT_REGISTERED/);
  assert.throws(() => m.creditAccount("stranger", "EUR", 100n), /IDENTITY_NOT_REGISTERED/);
  // Registration itself is fail-closed: immutable, no reserved ids, Ed25519 keys only.
  assert.throws(() => m.registerIdentity("buyer", stranger.publicKeyHex), /IDENTITY_ALREADY_REGISTERED/);
  assert.throws(() => m.registerIdentity("marketplace-admin", stranger.publicKeyHex), /RESERVED_IDENTITY/);
  assert.throws(() => m.registerIdentity("x", "not-a-key"), /IDENTITY_PUBLIC_KEY_INVALID/);
  assert.equal(m.getListing(listing.listingId).available, 100n);
});

test("A10: a reservation signed with the wrong key (or for other terms) is rejected", () => {
  const { m, listing } = setup();
  const impostor = createMarketplaceIdentity("buyer");
  const base = { marketplaceId: m.marketplaceId, listingId: listing.listingId, buyerId: "buyer", quantity: 1n, idempotencyKey: "k1" };
  assert.throws(() => m.reserve({ ...base, signature: signReservation(base, impostor.privateKey) }), /RESERVATION_SIGNATURE_INVALID/);
  const realKey = enrollIdentity(m, "buyer").privateKey;
  assert.throws(() => m.reserve({ ...base, quantity: 2n, signature: signReservation(base, realKey) }), /RESERVATION_SIGNATURE_INVALID/);
  assert.throws(() => m.reserve({ ...base, signature: signReservation({ ...base, marketplaceId: "other-marketplace" }, realKey) }), /RESERVATION_SIGNATURE_INVALID/);
  assert.equal(m.lockedDeposit("EUR", "buyer"), 0n);
});

test("A10: no reservation without funds for the deposit", () => {
  const { m, listing } = setup();
  enrollIdentity(m, "broke");
  assert.throws(() => reserveAs(m, { listingId: listing.listingId, buyerId: "broke", quantity: 1n }, { credit: 0n }), /INSUFFICIENT_FUNDS_FOR_DEPOSIT/);
  m.creditAccount("broke", "EUR", 4n); // deposit for gross 500 is 5
  assert.throws(() => reserveAs(m, { listingId: listing.listingId, buyerId: "broke", quantity: 1n }, { credit: 0n }), /INSUFFICIENT_FUNDS_FOR_DEPOSIT/);
  assert.equal(m.getListing(listing.listingId).available, 100n);
  assert.equal(m.listOrders().length, 0);
  m.creditAccount("broke", "EUR", 1n);
  const o = reserveAs(m, { listingId: listing.listingId, buyerId: "broke", quantity: 1n }, { credit: 0n });
  assert.equal(o.reservationDeposit, 5n);
  assert.equal(m.availableBalance("EUR", "broke"), 0n);
  assert.equal(m.lockedDeposit("EUR", "broke"), 5n);
  assertConserved(m);
});

test("A10: funded path - the deposit counts toward the payment", () => {
  const { m, listing } = setup();
  const o = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 2n }, { credit: 0n });
  assert.equal(o.grossAmount, 1_000n);
  assert.equal(o.reservationDeposit, 10n); // 1% of gross
  assert.equal(o.fundingDue, 990n);
  assert.equal(m.availableBalance("EUR", "buyer"), 9_990n);
  assertConserved(m);
  assert.throws(() => m.fundOrder(o.orderId, 1_000n), /HOLD_AMOUNT_MISMATCH/);
  const held = m.fundOrder(o.orderId, 990n);
  assert.equal(held.heldAmount, 1_000n);
  assert.equal(held.depositOutcome, "APPLIED_TO_PAYMENT");
  assert.equal(m.lockedDeposit("EUR", "buyer"), 0n);
  assertConserved(m);
  m.deliver(o.orderId, "prov", Buffer.from("ok"));
  const s = m.settle(o.orderId, "buyer");
  assert.equal(s.marketplaceFee, 30n);
  assert.equal(m.availableBalance("EUR", "buyer"), 9_000n); // paid exactly the gross amount
  assert.equal(m.availableBalance("EUR", "prov"), 970n);
  const a = assertConserved(m);
  assert.equal(a.marketplaceFees, 30n);
  // Insufficient funds at funding time is rejected without moving value.
  const o2 = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 19n }, { credit: 0n });
  assert.throws(() => m.fundOrder(o2.orderId, o2.fundingDue), /INSUFFICIENT_FUNDS/);
  assertConserved(m);
});

test("A10: an unfunded reservation that expires forfeits the deposit to the provider", () => {
  const { m, listing, advance } = setup();
  const o = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n }, { credit: 0n });
  assert.throws(() => m.expire(o.orderId, "prov"), /RESERVATION_NOT_EXPIRED/); // no early forfeit
  advance(10 * 60_000 + 1);
  assert.equal(m.reapExpiredReservations(), 1);
  const expired = m.getOrder(o.orderId, "buyer");
  assert.equal(expired.status, "EXPIRED");
  assert.equal(expired.depositOutcome, "FORFEITED_TO_PROVIDER");
  assert.equal(m.availableBalance("EUR", "prov"), 5n);
  assert.equal(m.availableBalance("EUR", "buyer"), 9_995n);
  assert.equal(m.lockedDeposit("EUR", "buyer"), 0n);
  assert.equal(m.getListing(listing.listingId).available, 100n);
  assertConserved(m);
});

test("A10: a funded order that expires undelivered is refunded in full", () => {
  const { m, listing, advance } = setup();
  const o = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n }, { credit: 0n });
  m.fundOrder(o.orderId, o.fundingDue);
  advance(10 * 60_000);
  const expired = m.expire(o.orderId, "buyer");
  assert.equal(expired.status, "EXPIRED");
  assert.equal(expired.depositOutcome, "REFUNDED");
  assert.equal(m.availableBalance("EUR", "buyer"), 10_000n);
  assert.equal(m.availableBalance("EUR", "prov"), 0n);
  assertConserved(m);
});

test("A10: buyer cancellation within the grace window refunds the deposit", () => {
  const { m, listing, advance } = setup();
  const a = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n }, { credit: 0n });
  const b = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n }, { credit: 0n });
  m.fundOrder(b.orderId, b.fundingDue);
  advance(2 * 60_000); // still inside the window (inclusive)
  assert.equal(cancelAsBuyer(m, a.orderId, "buyer").depositOutcome, "REFUNDED");
  assert.equal(cancelAsBuyer(m, b.orderId, "buyer").depositOutcome, "REFUNDED");
  assert.equal(m.availableBalance("EUR", "buyer"), 10_000n);
  assert.equal(m.availableBalance("EUR", "prov"), 0n);
  assert.equal(m.getListing(listing.listingId).available, 100n);
  assertConserved(m);
});

test("A10: buyer cancellation after the grace window forfeits the deposit to the provider", () => {
  const { m, listing, advance } = setup();
  const a = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n }, { credit: 0n });
  const b = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n }, { credit: 0n });
  m.fundOrder(b.orderId, b.fundingDue);
  advance(2 * 60_000 + 1);
  assert.equal(cancelAsBuyer(m, a.orderId, "buyer").depositOutcome, "FORFEITED_TO_PROVIDER");
  assert.equal(cancelAsBuyer(m, b.orderId, "buyer").depositOutcome, "FORFEITED_TO_PROVIDER");
  assert.equal(m.availableBalance("EUR", "prov"), 10n); // two deposits of 5
  assert.equal(m.availableBalance("EUR", "buyer"), 9_990n); // funded remainder of b refunded
  assertConserved(m);
});

test("A10: buyer cancellation must be signed; provider/admin cancellation refunds the buyer in full", () => {
  const { m, listing, advance } = setup({ adminIdentity: "admin-1", adminAuthorizer: (id) => id === "admin-1" });
  const o = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n }, { credit: 0n });
  assert.throws(() => m.cancel(o.orderId, "buyer"), /BUYER_SIGNATURE_REQUIRED/);
  const wrong = signCancellation({ marketplaceId: m.marketplaceId, orderId: o.orderId, buyerId: "buyer" }, createMarketplaceIdentity("x").privateKey);
  assert.throws(() => m.cancel(o.orderId, "buyer", { signature: wrong }), /CANCELLATION_SIGNATURE_INVALID/);
  advance(5 * 60_000);
  assert.equal(m.cancel(o.orderId, "prov").depositOutcome, "REFUNDED");
  const o2 = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n }, { credit: 0n });
  advance(5 * 60_000);
  assert.equal(m.cancel(o2.orderId, "admin-1").depositOutcome, "REFUNDED");
  assert.equal(m.availableBalance("EUR", "buyer"), 10_000n);
  assertConserved(m);
});

test("A10: per-identity limit on concurrent open reservations", () => {
  const { m, listing } = setup({ maxActiveReservationsPerIdentity: 3 });
  const orders = [1, 2, 3].map(() => reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n }, { credit: 0n }));
  assert.throws(() => reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n }, { credit: 0n }), /RESERVATION_LIMIT_REACHED/);
  assert.equal(m.lockedDeposit("EUR", "buyer"), 15n);
  cancelAsBuyer(m, orders[0]!.orderId, "buyer");
  assert.ok(reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n }, { credit: 0n }));
  // Defaults: 8 concurrent, 10-minute TTL, 2-minute grace; invalid values are refused.
  const d = new DigitalServicesMarketplace();
  assert.equal(d.maxActiveReservationsPerIdentity, 8);
  assert.equal(d.reservationTtlMs, 600_000);
  assert.equal(d.cancellationGraceMs, 120_000);
  assert.throws(() => new DigitalServicesMarketplace({ reservationTtlMs: 0 }), /INVALID_RESERVATION_LIMIT/);
  assert.throws(() => new DigitalServicesMarketplace({ cancellationGraceMs: -1 }), /INVALID_RESERVATION_LIMIT/);
  assertConserved(m);
});

test("A10: a replayed signed reservation locks the deposit only once", () => {
  const { m, listing } = setup();
  const a = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n, idempotencyKey: "same" }, { credit: 0n });
  const b = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n, idempotencyKey: "same" }, { credit: 0n });
  assert.equal(a.orderId, b.orderId);
  assert.equal(m.lockedDeposit("EUR", "buyer"), 5n);
  assert.equal(m.getListing(listing.listingId).available, 99n);
  assertConserved(m);
});

test("A10: value is conserved across every deposit path, including paymaster gas", () => {
  const paymaster = new MarketplacePaymaster({ now: () => T0 });
  paymaster.fundReserve("EUR", 1_000n);
  const { m, listing, advance } = setup({ paymaster });
  for (const id of ["b1", "b2", "b3", "b4", "b5"]) enrollIdentity(m, id, { asset: "EUR", amount: 5_000n });
  const q = m.checkoutQuote(listing.listingId, 1n, 7n);
  assert.equal(q.buyerTotal, 507n);
  assert.equal(q.dueAtFunding, 502n);
  const settled = reserveAs(m, { listingId: listing.listingId, buyerId: "b1", quantity: 1n, gasQuote: q.gasQuote }, { credit: 0n });
  m.fundOrder(settled.orderId, settled.fundingDue);
  m.deliver(settled.orderId, "prov", Buffer.from("ok"));
  m.settle(settled.orderId, "b1");
  const graceCancel = reserveAs(m, { listingId: listing.listingId, buyerId: "b2", quantity: 1n }, { credit: 0n });
  cancelAsBuyer(m, graceCancel.orderId, "b2");
  const lateCancel = reserveAs(m, { listingId: listing.listingId, buyerId: "b3", quantity: 3n }, { credit: 0n });
  const expiring = reserveAs(m, { listingId: listing.listingId, buyerId: "b4", quantity: 1n }, { credit: 0n });
  const heldExpiry = reserveAs(m, { listingId: listing.listingId, buyerId: "b5", quantity: 1n }, { credit: 0n });
  m.fundOrder(heldExpiry.orderId, heldExpiry.fundingDue);
  assertConserved(m);
  advance(3 * 60_000);
  cancelAsBuyer(m, lateCancel.orderId, "b3");
  advance(10 * 60_000);
  m.reapExpiredReservations();
  const a = assertConserved(m);
  assert.equal(a.credited, 10_000n + 25_000n);
  assert.equal(a.lockedDeposits, 0n);
  assert.equal(a.held, 0n);
  assert.equal(a.gasCaptured, 7n);
  assert.equal(a.marketplaceFees, 15n);
  assert.equal(m.availableBalance("EUR", "prov"), 485n + 15n + 5n); // net payout + late-cancel deposit (1% of 1500) + expiry deposit
  assert.equal(m.availableBalance("EUR", "b5"), 5_000n);
  assert.equal(paymaster.reserveOf("EUR"), 1_000n);
});
