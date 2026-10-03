import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "./marketplace.ts";
import { createTestAuthority, deliver, fund, getOrder, publishAs, reserveAs, settle } from "./testkit.ts";

test("20k-user synthetic load: settlement, replay safety and hot-stock exhaustion", () => {
  const m = new DigitalServicesMarketplace({ testOnlyLocalHeight: true });
  const listings = [] as ReturnType<DigitalServicesMarketplace["publishListing"]>[];
  for (let p = 0; p < 200; p++) for (let j = 0; j < 5; j++) {
    listings.push(publishAs(m, { providerId: `prov-${p}`, title: `Compute ${p}-${j}`, description: "global digital service", category: "COMPUTE", asset: "EUR", unitPrice: 100n, capacity: 100n }));
  }
  let settled = 0;
  for (let i = 0; i < 20_000; i++) {
    const l = listings[i % listings.length];
    const o = reserveAs(m, { listingId: l.listingId, buyerId: `buyer-${i}`, quantity: 1n, idempotencyKey: `checkout-${i}` });
    assert.equal(reserveAs(m, { listingId: l.listingId, buyerId: `buyer-${i}`, quantity: 1n, idempotencyKey: `checkout-${i}` }).orderId, o.orderId);
    fund(m, o.orderId, o.fundingDue, `fund-${i}`); // deposit locked at reserve() counts toward payment
    deliver(m, o.orderId, l.providerId, Buffer.from(`LICENSE:${i}`), `delivery-${i}`);
    settle(m, o.orderId, `buyer-${i}`);
    settled++;
  }
  assert.equal(settled, 20_000);
  assert.equal(m.treasury.totalOf("EUR"), 60_000n);
  assert.equal(m.valueAccounting("EUR").conserved, true);

  const hot = publishAs(m, { providerId: "hot", title: "Hot GPU", description: "contention", category: "COMPUTE", asset: "EUR", unitPrice: 50n, capacity: 100n });
  let accepted = 0;
  for (let i = 0; i < 1_000; i++) {
    try { reserveAs(m, { listingId: hot.listingId, buyerId: `hot-${i}`, quantity: 1n, idempotencyKey: `hot-${i}` }); accepted++; } catch {}
  }
  assert.equal(accepted, 100);
  assert.equal(m.getListing(hot.listingId).available, 0n);
  const acct = m.valueAccounting("EUR");
  assert.equal(acct.lockedDeposits, 100n); // 100 open reservations x minimum deposit 1
  assert.equal(acct.conserved, true);
});

test("idempotency keys are scoped to the operation order and cannot be confused", () => {
  const m = new DigitalServicesMarketplace({ testOnlyLocalHeight: true });
  const l = publishAs(m, { providerId: "p", title: "API", description: "api", category: "API", asset: "EUR", unitPrice: 10n, capacity: 2n });
  const a = reserveAs(m, { listingId: l.listingId, buyerId: "a", quantity: 1n });
  const b = reserveAs(m, { listingId: l.listingId, buyerId: "b", quantity: 1n });
  fund(m, a.orderId, 9n, "same-key");
  fund(m, b.orderId, 9n, "same-key");
  assert.equal(getOrder(m, a.orderId, "a").status, "HELD");
  assert.equal(getOrder(m, b.orderId, "b").status, "HELD");
});

test("expired abandoned reservations are reaped and capacity returns", () => {
  let now = 0;
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: () => now, reservationTtlMs: 600_000 });
  const l = publishAs(m, { providerId: "p", title: "Storage", description: "storage", category: "STORAGE", asset: "EUR", unitPrice: 5n, capacity: 1n });
  const o = reserveAs(m, { listingId: l.listingId, buyerId: "b", quantity: 1n });
  assert.equal(m.getListing(l.listingId).available, 0n);
  now = 600_001;
  assert.equal(m.reapExpiredReservations(), 1);
  assert.equal(getOrder(m, o.orderId, "b").status, "EXPIRED");
  assert.equal(m.getListing(l.listingId).available, 1n);
});
