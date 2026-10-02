import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "./marketplace.ts";

test("20k-user synthetic load: settlement, replay safety and hot-stock exhaustion", () => {
  const m = new DigitalServicesMarketplace();
  const listings = [] as ReturnType<DigitalServicesMarketplace["publishListing"]>[];
  for (let p = 0; p < 200; p++) for (let j = 0; j < 5; j++) {
    listings.push(m.publishListing({ providerId: `prov-${p}`, title: `Compute ${p}-${j}`, description: "global digital service", category: "COMPUTE", asset: "EUR", unitPrice: 100n, capacity: 100n }));
  }
  let settled = 0;
  for (let i = 0; i < 20_000; i++) {
    const l = listings[i % listings.length];
    const o = m.acceptOrder({ listingId: l.listingId, buyerId: `buyer-${i}`, quantity: 1n, idempotencyKey: `checkout-${i}` });
    assert.equal(m.acceptOrder({ listingId: l.listingId, buyerId: `buyer-${i}`, quantity: 1n, idempotencyKey: `checkout-${i}` }).orderId, o.orderId);
    m.fundOrder(o.orderId, o.grossAmount, `fund-${i}`);
    m.deliver(o.orderId, l.providerId, Buffer.from(`LICENSE:${i}`), `delivery-${i}`);
    m.settle(o.orderId, `buyer-${i}`);
    settled++;
  }
  assert.equal(settled, 20_000);
  assert.equal(m.treasury.totalOf("EUR"), 60_000n);

  const hot = m.publishListing({ providerId: "hot", title: "Hot GPU", description: "contention", category: "COMPUTE", asset: "EUR", unitPrice: 50n, capacity: 100n });
  let accepted = 0;
  for (let i = 0; i < 1_000; i++) {
    try { m.acceptOrder({ listingId: hot.listingId, buyerId: `hot-${i}`, quantity: 1n, idempotencyKey: `hot-${i}` }); accepted++; } catch {}
  }
  assert.equal(accepted, 100);
  assert.equal(m.getListing(hot.listingId).available, 0n);
});

test("idempotency keys are scoped to the operation order and cannot be confused", () => {
  const m = new DigitalServicesMarketplace();
  const l = m.publishListing({ providerId: "p", title: "API", description: "api", category: "API", asset: "EUR", unitPrice: 10n, capacity: 2n });
  const a = m.acceptOrder({ listingId: l.listingId, buyerId: "a", quantity: 1n });
  const b = m.acceptOrder({ listingId: l.listingId, buyerId: "b", quantity: 1n });
  m.fundOrder(a.orderId, 10n, "same-key");
  m.fundOrder(b.orderId, 10n, "same-key");
  assert.equal(m.getOrder(a.orderId, "a").status, "HELD");
  assert.equal(m.getOrder(b.orderId, "b").status, "HELD");
});

test("expired abandoned reservations are reaped and capacity returns", () => {
  let now = 0;
  const m = new DigitalServicesMarketplace({ now: () => now, reservationTtlMs: 600_000 });
  const l = m.publishListing({ providerId: "p", title: "Storage", description: "storage", category: "STORAGE", asset: "EUR", unitPrice: 5n, capacity: 1n });
  const o = m.acceptOrder({ listingId: l.listingId, buyerId: "b", quantity: 1n });
  assert.equal(m.getListing(l.listingId).available, 0n);
  now = 600_001;
  assert.equal(m.reapExpiredReservations(), 1);
  assert.equal(m.getOrder(o.orderId, "b").status, "EXPIRED");
  assert.equal(m.getListing(l.listingId).available, 1n);
});
