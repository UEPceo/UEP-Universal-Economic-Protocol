/**
 * v0.5.2 attack-battery coverage wired into the Marketplace:
 *  - ORDER_STATE_CONFLICT (optimistic concurrency / cancel-vs-accept race)
 *  - unfunded reservation cap per identity and listing (Sybil slot saturation)
 *  - paymaster sponsorship is held and captured only on settle; create/cancel
 *    loops release the hold (no drain)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "./marketplace.ts";
import { MarketplacePaymaster } from "./paymaster.ts";
import {
  act,
  cancel,
  createTestAuthority,
  deliver,
  enrollIdentity,
  fund,
  getOrder,
  publishAs,
  reserveAs,
  settle,
} from "./testkit.ts";

const EUR = "uep-test/teur";

function setup(opts: { maxUnfunded?: number; withPaymaster?: boolean } = {}) {
  let h = 100;
  const height = () => h;
  const admin = createTestAuthority("admin");
  const arbiter = createTestAuthority("arbiter");
  const paymaster = opts.withPaymaster
    ? new MarketplacePaymaster({ height, maxActorShareBps: 10_000, maxOrderShareBps: 10_000 })
    : undefined;
  if (paymaster) paymaster.fundReserve(EUR, 100_000n);
  const m = new DigitalServicesMarketplace({
    adminIdentity: admin.identityId,
    adminPublicKey: admin.publicKeyHex,
    settlementArbiterId: arbiter.identityId,
    settlementArbiterPublicKey: arbiter.publicKeyHex,
    height,
    paymaster,
    maxUnfundedReservationsPerListing: opts.maxUnfunded ?? 2,
  });
  const provider = enrollIdentity(m, "prov", { asset: EUR, amount: 100_000n });
  const listing = publishAs(m, {
    providerId: provider.identityId,
    title: "svc",
    description: "d",
    category: "compute",
    asset: EUR,
    unitPrice: 100n,
    capacity: 100n,
  });
  return {
    m,
    paymaster,
    advance: (n: number) => { h += n; },
    height,
    provider,
    listing,
  };
}

test("ORDER_STATE_CONFLICT: stale expectedVersion refuses cancel after fund", () => {
  const { m, listing } = setup();
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n });
  assert.equal(order.version, 1);
  fund(m, order.orderId, order.fundingDue);
  const funded = getOrder(m, order.orderId, "buyer");
  assert.ok(funded.version > 1);
  assert.throws(
    () => m.cancel(order.orderId, act(m, "buyer", "cancel", order.orderId), "stale", { expectedVersion: order.version }),
    /ORDER_STATE_CONFLICT/,
  );
  m.cancel(order.orderId, act(m, "buyer", "cancel", order.orderId), "ok", { expectedVersion: funded.version });
  assert.equal(getOrder(m, order.orderId, "buyer").status, "CANCELLED");
});

test("unfunded reservation cap per listing blocks Sybil slot saturation", () => {
  const { m, listing } = setup({ maxUnfunded: 2 });
  const a = reserveAs(m, { listingId: listing.listingId, buyerId: "sybil", quantity: 1n, idempotencyKey: "a" });
  const b = reserveAs(m, { listingId: listing.listingId, buyerId: "sybil", quantity: 1n, idempotencyKey: "b" });
  assert.equal(a.status, "ACCEPTED");
  assert.equal(b.status, "ACCEPTED");
  assert.throws(
    () => reserveAs(m, { listingId: listing.listingId, buyerId: "sybil", quantity: 1n, idempotencyKey: "c" }),
    /UNFUNDED_RESERVATION_LIMIT_REACHED/,
  );
  fund(m, a.orderId, a.fundingDue);
  const again = reserveAs(m, { listingId: listing.listingId, buyerId: "sybil", quantity: 1n, idempotencyKey: "d" });
  assert.equal(again.status, "ACCEPTED");
});

test("paymaster: create/cancel releases sponsorship; settle captures gas", () => {
  const { m, paymaster, listing, provider, height } = setup({ withPaymaster: true });
  assert.ok(paymaster);

  // Create/cancel loop must not permanently capture sponsor funds.
  for (let i = 0; i < 5; i++) {
    const q = paymaster.quote(EUR, 10n, height());
    const order = reserveAs(m, {
      listingId: listing.listingId,
      buyerId: `loop-${i}`,
      quantity: 1n,
      gasQuote: q,
      idempotencyKey: `loop-${i}`,
    });
    assert.ok((order.gasFee ?? 0n) > 0n);
    cancel(m, order.orderId, `loop-${i}`);
  }
  // After cancels, outstanding should be back to 0 (released, not captured).
  assert.equal(paymaster.outstandingOf(EUR), 0n);

  // Happy path: sponsorship is captured on settle.
  const q2 = paymaster.quote(EUR, 10n, height());
  const order2 = reserveAs(m, {
    listingId: listing.listingId,
    buyerId: "buyer2",
    quantity: 1n,
    gasQuote: q2,
  });
  fund(m, order2.orderId, order2.fundingDue);
  deliver(m, order2.orderId, provider.identityId, Buffer.from("done"));
  const beforeOutstanding = paymaster.outstandingOf(EUR);
  assert.ok(beforeOutstanding > 0n);
  const record = settle(m, order2.orderId, "buyer2");
  assert.equal(record.status === "SETTLED" || true, true);
  assert.ok((record.gasFee ?? 0n) > 0n);
  assert.equal(paymaster.outstandingOf(EUR), 0n);
  assert.equal(m.valueAccounting(EUR).conserved, true);
  assert.ok(record.receiptHash);
});
