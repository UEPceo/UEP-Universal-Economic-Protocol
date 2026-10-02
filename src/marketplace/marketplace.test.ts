import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "./marketplace.ts";
import { contentHash } from "../service/content-hash.ts";
import { MarketplacePaymaster } from "./paymaster.ts";

const fixedNow = () => 1_700_000_000_000;

function setup() {
  const m = new DigitalServicesMarketplace({ now: fixedNow, adminIdentity: "admin-1", adminAuthorizer: (id) => id === "admin-1" });
  const listing = m.publishListing({
    providerId: "provider-gpu-1",
    title: "H100 compute",
    description: "GPU compute service",
    category: "COMPUTE",
    asset: "EUR",
    unitPrice: 20n,
    capacity: 100n,
  });
  return { m, listing };
}

test("end-to-end marketplace settlement creates the fee only at SETTLED", () => {
  const { m, listing } = setup();
  const order = m.acceptOrder({ listingId: listing.listingId, buyerId: "buyer-1", quantity: 5n });
  assert.equal(order.grossAmount, 100n);
  assert.equal(order.status, "ACCEPTED");
  m.fundOrder(order.orderId, 100n);
  assert.equal(m.heldBalance("EUR", "buyer-1"), 100n);
  assert.equal(m.treasury.totalOf("EUR"), 0n);
  m.deliverWithExpectedHash(order.orderId, "provider-gpu-1", Buffer.from("result"), contentHash(Buffer.from("result")));
  assert.equal(m.getOrder(order.orderId, "buyer-1").status, "DELIVERED");
  assert.equal(m.treasury.totalOf("EUR"), 0n);
  const settlement = m.settle(order.orderId, "buyer-1");
  assert.equal(settlement.marketplaceFee, 3n);
  assert.equal(m.getOrder(order.orderId, "buyer-1").status, "SETTLED");
  assert.equal(m.treasury.totalOf("EUR"), 3n);
});

test("tampered delivery is rejected before settlement", () => {
  const { m, listing } = setup();
  const order = m.acceptOrder({ listingId: listing.listingId, buyerId: "buyer-1", quantity: 5n });
  m.fundOrder(order.orderId, 100n);
  assert.throws(() => m.deliverWithExpectedHash(order.orderId, "provider-gpu-1", Buffer.from("tampered"), "00"), /CONTENT_INTEGRITY_ERROR/);
  assert.equal(m.getOrder(order.orderId, "buyer-1").status, "HELD");
});

test("unauthorized provider cannot deliver", () => {
  const { m, listing } = setup();
  const order = m.acceptOrder({ listingId: listing.listingId, buyerId: "buyer-1", quantity: 1n });
  m.fundOrder(order.orderId, 20n);
  assert.throws(() => m.deliver(order.orderId, "attacker", Buffer.from("x")), /PROVIDER_NOT_AUTHORIZED/);
});

test("successful settlement pays provider net and allocates 3% fee", () => {
  const { m, listing } = setup();
  const order = m.acceptOrder({ listingId: listing.listingId, buyerId: "buyer-1", quantity: 5n });
  m.fundOrder(order.orderId, 100n);
  m.deliver(order.orderId, "provider-gpu-1", Buffer.from("result"));
  const s = m.settle(order.orderId, "buyer-1");
  assert.equal(s.grossAmount, 100n);
  assert.equal(s.marketplaceFee, 3n);
  assert.equal(s.providerPayout, 97n);
  assert.equal(m.heldBalance("EUR", "buyer-1"), 0n);
  assert.equal(m.treasury.totalOf("EUR"), 3n);
  assert.equal(m.getOrder(order.orderId, "buyer-1").status, "SETTLED");
});

test("settlement is not double-chargeable", () => {
  const { m, listing } = setup();
  const order = m.acceptOrder({ listingId: listing.listingId, buyerId: "buyer-1", quantity: 5n });
  m.fundOrder(order.orderId, 100n);
  m.deliver(order.orderId, "provider-gpu-1", Buffer.from("result"));
  const first = m.settle(order.orderId, "buyer-1");
  const second = m.settle(order.orderId, "buyer-1");
  assert.deepEqual(second, first);
  assert.equal(m.treasury.totalOf("EUR"), 3n);
});

test("cancellation releases the hold and capacity without fees", () => {
  const { m, listing } = setup();
  const order = m.acceptOrder({ listingId: listing.listingId, buyerId: "buyer-1", quantity: 4n });
  m.fundOrder(order.orderId, 80n);
  m.cancel(order.orderId, "buyer-1");
  assert.equal(m.getOrder(order.orderId, "buyer-1").status, "CANCELLED");
  assert.equal(m.heldBalance("EUR", "buyer-1"), 0n);
  assert.equal(m.treasury.totalOf("EUR"), 0n);
  assert.equal(m.getListing(listing.listingId).available, 100n);
});

test("listing search isolates active service offers", () => {
  const { m } = setup();
  m.publishListing({ providerId: "provider-storage", title: "Storage", description: "100GB", category: "STORAGE", asset: "EUR", unitPrice: 5n, capacity: 50n });
  assert.equal(m.searchListings({ category: "COMPUTE" }).length, 1);
  assert.equal(m.searchListings({ category: "STORAGE" }).length, 1);
});

test("idempotency key prevents duplicate reservation and double capacity consumption", () => {
  const { m, listing } = setup();
  const a = m.acceptOrder({ listingId: listing.listingId, buyerId: "buyer-1", quantity: 60n, idempotencyKey: "pay-1" });
  const b = m.acceptOrder({ listingId: listing.listingId, buyerId: "buyer-1", quantity: 60n, idempotencyKey: "pay-1" });
  assert.equal(a.orderId, b.orderId);
  assert.equal(m.getListing(listing.listingId).available, 40n);
});

test("concurrent checkout attempts cannot oversell in the in-process atomic state transition", async () => {
  const { m, listing } = setup();
  const results = await Promise.allSettled([
    Promise.resolve().then(() => m.acceptOrder({ listingId: listing.listingId, buyerId: "b1", quantity: 60n, idempotencyKey: "c1" })),
    Promise.resolve().then(() => m.acceptOrder({ listingId: listing.listingId, buyerId: "b2", quantity: 60n, idempotencyKey: "c2" })),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(m.getListing(listing.listingId).available, 40n);
});

test("reservation expires and releases capacity before funding/delivery/settlement", () => {
  let now = 1_700_000_000_000;
  const m = new DigitalServicesMarketplace({ now: () => now, reservationTtlMs: 1_000 });
  const listing = m.publishListing({ providerId: "p", title: "API", description: "api", category: "API", asset: "EUR", unitPrice: 10n, capacity: 2n });
  const order = m.acceptOrder({ listingId: listing.listingId, buyerId: "b", quantity: 1n });
  now += 1_001;
  assert.throws(() => m.fundOrder(order.orderId, 10n), /RESERVATION_EXPIRED/);
  assert.equal(m.getListing(listing.listingId).available, 2n);
  assert.equal(m.getOrder(order.orderId, "b").status, "EXPIRED");
});

test("order access control blocks IDOR when an actor is supplied", () => {
  const { m, listing } = setup();
  const order = m.acceptOrder({ listingId: listing.listingId, buyerId: "buyer-1", quantity: 1n });
  assert.throws(() => m.getOrder(order.orderId, "attacker"), /ORDER_ACCESS_FORBIDDEN/);
  assert.equal(m.getOrder(order.orderId, "buyer-1").orderId, order.orderId);
  assert.equal(m.getOrder(order.orderId, "provider-gpu-1").orderId, order.orderId);
});

test("listing creation is rate limited and exact catalog duplicates are blocked", () => {
  const m = new DigitalServicesMarketplace({ now: fixedNow, maxListingsPerWindow: 2 });
  const base = { providerId: "p", title: "Service A", description: "Compute", category: "COMPUTE" as const, asset: "EUR", unitPrice: 1n, capacity: 1n };
  m.publishListing(base);
  assert.throws(() => m.publishListing(base), /DUPLICATE_LISTING_FINGERPRINT/);
  m.publishListing({ ...base, title: "Service B" });
  assert.throws(() => m.publishListing({ ...base, title: "Service C" }), /LISTING_RATE_LIMITED/);
});

test("bayesian reputation does not let a tiny sample instantly become 5/5", () => {
  const { m, listing } = setup();
  const order = m.acceptOrder({ listingId: listing.listingId, buyerId: "buyer-1", quantity: 1n });
  m.fundOrder(order.orderId, 20n);
  m.deliver(order.orderId, listing.providerId, Buffer.from("ok"));
  m.settle(order.orderId, "buyer-1");
  const rep = m.recordSellerReview({ orderId: order.orderId, buyerId: "buyer-1", rating: 5 });
  assert.ok(rep.score < 5);
});

test("checkout quote exposes the marketplace fee before payment", () => {
  const { m, listing } = setup();
  const q = m.checkoutQuote(listing.listingId, 5n);
  assert.equal(q.grossAmount, 100n);
  assert.equal(q.marketplaceFee, 3n);
  assert.equal(q.providerNet, 97n);
  assert.equal(q.feeBps, 300);
  assert.equal(q.reservationTtlMs, 600_000);
});

test("paymaster quotes gas in the purchase asset and buyer sees the total before funding", () => {
  const paymaster = new MarketplacePaymaster({ now: fixedNow });
  paymaster.fundReserve("EUR", 1_000n);
  const { m, listing } = (() => {
    const mm = new DigitalServicesMarketplace({ now: fixedNow, paymaster });
    const ll = mm.publishListing({ providerId: "p", title: "Gas-aware API", description: "api", category: "API", asset: "EUR", unitPrice: 100n, capacity: 10n });
    return { m: mm, listing: ll };
  })();
  const q = m.checkoutQuote(listing.listingId, 1n, 5n);
  assert.equal(q.grossAmount, 100n);
  assert.equal(q.gasFee, 5n);
  assert.equal(q.buyerTotal, 105n);
  assert.equal(q.gasQuote?.asset, "EUR");
});

test("paymaster gas is captured from buyer escrow at settlement and is replay-safe", () => {
  const paymaster = new MarketplacePaymaster({ now: fixedNow });
  paymaster.fundReserve("EUR", 1_000n);
  const m = new DigitalServicesMarketplace({ now: fixedNow, paymaster });
  const listing = m.publishListing({ providerId: "p", title: "Gas API", description: "api", category: "API", asset: "EUR", unitPrice: 100n, capacity: 10n });
  const q = m.checkoutQuote(listing.listingId, 1n, 5n);
  const order = m.acceptOrder({ listingId: listing.listingId, buyerId: "b", quantity: 1n, gasQuote: q.gasQuote });
  m.fundOrder(order.orderId, 105n);
  m.deliver(order.orderId, "p", Buffer.from("ok"));
  const first = m.settle(order.orderId, "b");
  const second = m.settle(order.orderId, "b");
  assert.equal(first.gasFee, 5n);
  assert.deepEqual(second, first);
  assert.equal(paymaster.receipts.length, 1);
  assert.equal(paymaster.reserveOf("EUR"), 1_000n);
  assert.equal(m.heldBalance("EUR", "b"), 0n);
});

test("cancelled paymaster reservation is released without charging the buyer", () => {
  const paymaster = new MarketplacePaymaster({ now: fixedNow });
  paymaster.fundReserve("EUR", 100n);
  const m = new DigitalServicesMarketplace({ now: fixedNow, paymaster });
  const listing = m.publishListing({ providerId: "p", title: "Gas API cancel", description: "api", category: "API", asset: "EUR", unitPrice: 100n, capacity: 1n });
  const q = m.checkoutQuote(listing.listingId, 1n, 5n);
  const order = m.acceptOrder({ listingId: listing.listingId, buyerId: "b", quantity: 1n, gasQuote: q.gasQuote });
  assert.equal(paymaster.reserveOf("EUR"), 95n);
  m.cancel(order.orderId, "b");
  assert.equal(paymaster.reserveOf("EUR"), 100n);
  assert.equal(m.treasury.totalOf("EUR"), 0n);
});
test("unauthorized actor cannot cancel or expire an order", () => {
  const { m, listing } = setup();
  const order = m.acceptOrder({ listingId: listing.listingId, buyerId: "buyer-1", quantity: 1n });
  assert.throws(() => m.cancel(order.orderId, "attacker"), /ORDER_ACCESS_FORBIDDEN/);
  assert.throws(() => m.expire(order.orderId, "attacker"), /ORDER_ACTION_FORBIDDEN/);
  assert.equal(m.getOrder(order.orderId, "buyer-1").status, "ACCEPTED");
});

test("buyer or provider can cancel an order, admin can cancel", () => {
  const { m, listing } = setup();
  const a = m.acceptOrder({ listingId: listing.listingId, buyerId: "buyer-1", quantity: 1n });
  m.cancel(a.orderId, "provider-gpu-1");
  const b = m.acceptOrder({ listingId: listing.listingId, buyerId: "buyer-2", quantity: 1n });
  m.cancel(b.orderId, "admin-1");
  assert.equal(m.getOrder(a.orderId, "buyer-1").status, "CANCELLED");
  assert.equal(m.getOrder(b.orderId, "buyer-2").status, "CANCELLED");
});

