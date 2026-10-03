import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "./marketplace.ts";
import { contentHash } from "../service/content-hash.ts";
import { MarketplacePaymaster } from "./paymaster.ts";
import { cancel, cancelAsBuyer, createTestAuthority, deliver, deliverWithExpectedHash, expire, fund, getOrder, publishAs, reserveAs, review, settle } from "./testkit.ts";

const fixedNow = () => 1_700_000_000_000;
const ADMIN = createTestAuthority("admin-1");

function setup() {
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: fixedNow, adminIdentity: "admin-1", adminPublicKey: ADMIN.publicKeyHex, adminAuthorizer: (id) => id === "admin-1" });
  const listing = publishAs(m, {
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
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer-1", quantity: 5n });
  assert.equal(order.grossAmount, 100n);
  assert.equal(order.status, "ACCEPTED");
  fund(m, order.orderId, 99n); // gross 100 minus the 1% deposit already locked at reserve()
  assert.equal(m.heldBalance("EUR", "buyer-1"), 100n);
  assert.equal(m.treasury.totalOf("EUR"), 0n);
  deliverWithExpectedHash(m, order.orderId, "provider-gpu-1", Buffer.from("result"), contentHash(Buffer.from("result")));
  assert.equal(getOrder(m, order.orderId, "buyer-1").status, "DELIVERED");
  assert.equal(m.treasury.totalOf("EUR"), 0n);
  const settlement = settle(m, order.orderId, "buyer-1");
  assert.equal(settlement.marketplaceFee, 3n);
  assert.equal(getOrder(m, order.orderId, "buyer-1").status, "SETTLED");
  assert.equal(m.treasury.totalOf("EUR"), 3n);
});

test("tampered delivery is rejected before settlement", () => {
  const { m, listing } = setup();
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer-1", quantity: 5n });
  fund(m, order.orderId, 99n); // gross 100 minus the 1% deposit already locked at reserve()
  assert.throws(() => deliverWithExpectedHash(m, order.orderId, "provider-gpu-1", Buffer.from("tampered"), "00"), /CONTENT_INTEGRITY_ERROR/);
  assert.equal(getOrder(m, order.orderId, "buyer-1").status, "HELD");
});

test("unauthorized provider cannot deliver", () => {
  const { m, listing } = setup();
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer-1", quantity: 1n });
  fund(m, order.orderId, 19n); // gross 20 minus the minimum deposit 1 locked at reserve()
  assert.throws(() => deliver(m, order.orderId, "attacker", Buffer.from("x")), /PROVIDER_NOT_AUTHORIZED/);
});

test("successful settlement pays provider net and allocates 3% fee", () => {
  const { m, listing } = setup();
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer-1", quantity: 5n });
  fund(m, order.orderId, 99n); // gross 100 minus the 1% deposit already locked at reserve()
  deliver(m, order.orderId, "provider-gpu-1", Buffer.from("result"));
  const s = settle(m, order.orderId, "buyer-1");
  assert.equal(s.grossAmount, 100n);
  assert.equal(s.marketplaceFee, 3n);
  assert.equal(s.providerPayout, 97n);
  assert.equal(m.heldBalance("EUR", "buyer-1"), 0n);
  assert.equal(m.treasury.totalOf("EUR"), 3n);
  assert.equal(getOrder(m, order.orderId, "buyer-1").status, "SETTLED");
});

test("settlement is not double-chargeable", () => {
  const { m, listing } = setup();
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer-1", quantity: 5n });
  fund(m, order.orderId, 99n); // gross 100 minus the 1% deposit already locked at reserve()
  deliver(m, order.orderId, "provider-gpu-1", Buffer.from("result"));
  const first = settle(m, order.orderId, "buyer-1");
  const second = settle(m, order.orderId, "buyer-1");
  assert.deepEqual(second, first);
  assert.equal(m.treasury.totalOf("EUR"), 3n);
});

test("cancellation releases the hold and capacity without fees", () => {
  const { m, listing } = setup();
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer-1", quantity: 4n });
  fund(m, order.orderId, 79n);
  cancelAsBuyer(m, order.orderId, "buyer-1");
  assert.equal(getOrder(m, order.orderId, "buyer-1").status, "CANCELLED");
  assert.equal(m.heldBalance("EUR", "buyer-1"), 0n);
  assert.equal(m.treasury.totalOf("EUR"), 0n);
  assert.equal(m.getListing(listing.listingId).available, 100n);
});

test("listing search isolates active service offers", () => {
  const { m } = setup();
  publishAs(m, { providerId: "provider-storage", title: "Storage", description: "100GB", category: "STORAGE", asset: "EUR", unitPrice: 5n, capacity: 50n });
  assert.equal(m.searchListings({ category: "COMPUTE" }).length, 1);
  assert.equal(m.searchListings({ category: "STORAGE" }).length, 1);
});

test("idempotency key prevents duplicate reservation and double capacity consumption", () => {
  const { m, listing } = setup();
  const a = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer-1", quantity: 60n, idempotencyKey: "pay-1" });
  const b = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer-1", quantity: 60n, idempotencyKey: "pay-1" });
  assert.equal(a.orderId, b.orderId);
  assert.equal(m.getListing(listing.listingId).available, 40n);
});

test("concurrent checkout attempts cannot oversell in the in-process atomic state transition", async () => {
  const { m, listing } = setup();
  const results = await Promise.allSettled([
    Promise.resolve().then(() => reserveAs(m, { listingId: listing.listingId, buyerId: "b1", quantity: 60n, idempotencyKey: "c1" })),
    Promise.resolve().then(() => reserveAs(m, { listingId: listing.listingId, buyerId: "b2", quantity: 60n, idempotencyKey: "c2" })),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(m.getListing(listing.listingId).available, 40n);
});

test("reservation expires and releases capacity before funding/delivery/settlement", () => {
  let now = 1_700_000_000_000;
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: () => now, reservationTtlMs: 1_000 });
  const listing = publishAs(m, { providerId: "p", title: "API", description: "api", category: "API", asset: "EUR", unitPrice: 10n, capacity: 2n });
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: "b", quantity: 1n });
  now += 1_001;
  assert.throws(() => fund(m, order.orderId, 9n), /RESERVATION_EXPIRED/);
  assert.equal(m.getListing(listing.listingId).available, 2n);
  assert.equal(getOrder(m, order.orderId, "b").status, "EXPIRED");
});

test("order access control blocks IDOR when an actor is supplied", () => {
  const { m, listing } = setup();
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer-1", quantity: 1n });
  assert.throws(() => getOrder(m, order.orderId, "attacker"), /ORDER_ACCESS_FORBIDDEN/);
  assert.equal(getOrder(m, order.orderId, "buyer-1").orderId, order.orderId);
  assert.equal(getOrder(m, order.orderId, "provider-gpu-1").orderId, order.orderId);
});

test("listing creation is rate limited and exact catalog duplicates are blocked", () => {
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: fixedNow, maxListingsPerWindow: 2 });
  const base = { providerId: "p", title: "Service A", description: "Compute", category: "COMPUTE" as const, asset: "EUR", unitPrice: 1n, capacity: 1n };
  publishAs(m, base);
  assert.throws(() => publishAs(m, base), /DUPLICATE_LISTING_FINGERPRINT/);
  publishAs(m, { ...base, title: "Service B" });
  assert.throws(() => publishAs(m, { ...base, title: "Service C" }), /LISTING_RATE_LIMITED/);
});

test("bayesian reputation does not let a tiny sample instantly become 5/5", () => {
  const { m, listing } = setup();
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer-1", quantity: 1n });
  fund(m, order.orderId, 19n); // gross 20 minus the minimum deposit 1 locked at reserve()
  deliver(m, order.orderId, listing.providerId, Buffer.from("ok"));
  settle(m, order.orderId, "buyer-1");
  const rep = review(m, { orderId: order.orderId, buyerId: "buyer-1", rating: 5 });
  assert.ok(rep.score < 5);
});

test("checkout quote exposes the marketplace fee before payment", () => {
  const { m, listing } = setup();
  const q = m.checkoutQuote(listing.listingId, 5n);
  assert.equal(q.grossAmount, 100n);
  assert.equal(q.marketplaceFee, 3n);
  assert.equal(q.providerNet, 97n);
  assert.equal(q.feeBps, 300);
  assert.equal(q.reservationDeposit, 1n);
  assert.equal(q.buyerTotal, 100n); // the deposit counts toward the payment
  assert.equal(q.dueAtFunding, 99n);
  assert.equal(q.cancellationGraceMs, 120_000);
  assert.equal(q.reservationTtlMs, 600_000);
});

test("paymaster quotes gas in the purchase asset and buyer sees the total before funding", () => {
  const paymaster = new MarketplacePaymaster({ testOnlyNowMs: fixedNow });
  paymaster.fundReserve("EUR", 1_000n);
  const { m, listing } = (() => {
    const mm = new DigitalServicesMarketplace({ testOnlyNowMs: fixedNow, paymaster });
    const ll = publishAs(mm, { providerId: "p", title: "Gas-aware API", description: "api", category: "API", asset: "EUR", unitPrice: 100n, capacity: 10n });
    return { m: mm, listing: ll };
  })();
  const q = m.checkoutQuote(listing.listingId, 1n, 5n);
  assert.equal(q.grossAmount, 100n);
  assert.equal(q.gasFee, 5n);
  assert.equal(q.reservationDeposit, 1n);
  assert.equal(q.buyerTotal, 105n);
  assert.equal(q.dueAtFunding, 104n);
  assert.equal(q.gasQuote?.asset, "EUR");
});

test("paymaster gas is captured from buyer escrow at settlement and is replay-safe", () => {
  const paymaster = new MarketplacePaymaster({ testOnlyNowMs: fixedNow });
  paymaster.fundReserve("EUR", 1_000n);
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: fixedNow, paymaster });
  const listing = publishAs(m, { providerId: "p", title: "Gas API", description: "api", category: "API", asset: "EUR", unitPrice: 100n, capacity: 10n });
  const q = m.checkoutQuote(listing.listingId, 1n, 5n);
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: "b", quantity: 1n, gasQuote: q.gasQuote });
  fund(m, order.orderId, 104n); // gross 100 + gas 5 minus the deposit 1 locked at reserve()
  deliver(m, order.orderId, "p", Buffer.from("ok"));
  const first = settle(m, order.orderId, "b");
  const second = settle(m, order.orderId, "b");
  assert.equal(first.gasFee, 5n);
  assert.deepEqual(second, first);
  assert.equal(paymaster.receipts.length, 1);
  assert.equal(paymaster.reserveOf("EUR"), 1_000n);
  assert.equal(m.heldBalance("EUR", "b"), 0n);
});

test("cancelled paymaster reservation is released without charging the buyer", () => {
  const paymaster = new MarketplacePaymaster({ testOnlyNowMs: fixedNow });
  paymaster.fundReserve("EUR", 100n);
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: fixedNow, paymaster });
  const listing = publishAs(m, { providerId: "p", title: "Gas API cancel", description: "api", category: "API", asset: "EUR", unitPrice: 100n, capacity: 1n });
  const q = m.checkoutQuote(listing.listingId, 1n, 5n);
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: "b", quantity: 1n, gasQuote: q.gasQuote });
  assert.equal(paymaster.reserveOf("EUR"), 95n);
  cancelAsBuyer(m, order.orderId, "b");
  assert.equal(paymaster.reserveOf("EUR"), 100n);
  assert.equal(m.treasury.totalOf("EUR"), 0n);
});
test("unauthorized actor cannot cancel or expire an order", () => {
  const { m, listing } = setup();
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer-1", quantity: 1n });
  assert.throws(() => cancel(m, order.orderId, "attacker"), /ORDER_ACCESS_FORBIDDEN/);
  assert.throws(() => expire(m, order.orderId, "attacker"), /ORDER_ACTION_FORBIDDEN/);
  assert.equal(getOrder(m, order.orderId, "buyer-1").status, "ACCEPTED");
});

test("buyer or provider can cancel an order, admin can cancel", () => {
  const { m, listing } = setup();
  const a = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer-1", quantity: 1n });
  cancel(m, a.orderId, "provider-gpu-1");
  const b = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer-2", quantity: 1n });
  cancel(m, b.orderId, "admin-1");
  assert.equal(getOrder(m, a.orderId, "buyer-1").status, "CANCELLED");
  assert.equal(getOrder(m, b.orderId, "buyer-2").status, "CANCELLED");
});

test("reservations are not free by default (UEP-A10)", () => {
  const { m, listing } = setup();
  const small = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer-1", quantity: 1n });
  assert.equal(small.reservationDeposit, 1n); // minimum deposit even when 1% rounds to zero
  assert.throws(() => fund(m, small.orderId, small.grossAmount), /HOLD_AMOUNT_MISMATCH/); // must fund gross - deposit
  const large = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer-2", quantity: 50n });
  assert.equal(large.grossAmount, 1_000n);
  assert.equal(large.reservationDeposit, 10n); // 1% of gross
  assert.throws(() => fund(m, large.orderId, 1_010n), /HOLD_AMOUNT_MISMATCH/);
  assert.equal(fund(m, large.orderId, 990n).heldAmount, 1_000n);
  // The deposit is applied to the payment when the order settles.
  deliver(m, large.orderId, listing.providerId, Buffer.from("ok"));
  const s = settle(m, large.orderId, "buyer-2");
  assert.equal(s.marketplaceFee, 30n);
  assert.equal(m.heldBalance("EUR", "buyer-2"), 0n);
  // Deposits are configurable: fixed amount, or bps.
  const fixed = new DigitalServicesMarketplace({ testOnlyNowMs: fixedNow, reservationDeposit: 25n });
  const bps = new DigitalServicesMarketplace({ testOnlyNowMs: fixedNow, reservationDepositBps: 500 });
  assert.equal(fixed.reservationDepositFor(1_000n), 25n);
  assert.equal(bps.reservationDepositFor(1_000n), 50n);
  assert.throws(() => new DigitalServicesMarketplace({ testOnlyLocalHeight: true, reservationDepositBps: 10_001 }), /INVALID_RESERVATION_LIMIT/);
  assert.throws(() => new DigitalServicesMarketplace({ testOnlyLocalHeight: true, reservationDeposit: -1n }), /INVALID_RESERVATION_LIMIT/);
});
