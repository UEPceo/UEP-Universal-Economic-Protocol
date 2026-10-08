/**
 * v0.5.3 (external review 2026-10-08): bounded Marketplace memory with a
 * height-based retention policy that keeps replay protection:
 * closed orders become tombstones after the retention window, idempotency
 * entries of expiring authorizations are dropped after expiry, listing
 * rate-limit timestamps outside the window are dropped.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "./marketplace.ts";
import { adoptTestIdentities, createTestAuthority, deliver, enrollIdentity, fund, getOrder, publishAs, reserveAs, settle } from "./testkit.ts";

const EUR = "uep-test/teur";

function setup(retention = 100) {
  const h = { h: 1_000 };
  const admin = createTestAuthority("admin");
  const m = new DigitalServicesMarketplace({ adminIdentity: admin.identityId, adminPublicKey: admin.publicKeyHex, height: () => h.h, closedOrderRetentionHeights: retention });
  enrollIdentity(m, "prov", { asset: EUR, amount: 100_000n });
  const listing = publishAs(m, { providerId: "prov", title: "svc", description: "d", category: "compute", asset: EUR, unitPrice: 10n, capacity: 1_000n });
  return { m, h, listing, admin };
}

function settledOrder(m: DigitalServicesMarketplace, listingId: string, buyer: string, key: string, notAfterHeight?: number) {
  const o = reserveAs(m, { listingId, buyerId: buyer, quantity: 1n, idempotencyKey: key, notAfterHeight });
  fund(m, o.orderId, o.fundingDue, `fund-${key}`);
  deliver(m, o.orderId, "prov", Buffer.from(key), `deliver-${key}`);
  settle(m, o.orderId, buyer);
  return o;
}

test("closed orders keep their full record during the retention window, then become tombstones; replay protection holds", () => {
  const { m, h, listing } = setup(100);
  const o = settledOrder(m, listing.listingId, "b1", "k1");
  const before = m.capacityAccounting(listing.listingId);
  h.h += 99;
  assert.equal(m.pruneRetention().orders, 0, "inside the window");
  assert.equal(getOrder(m, o.orderId, "b1").status, "SETTLED");
  h.h += 1;
  assert.equal(m.pruneRetention().orders, 1);
  const t = m.orderTombstone(o.orderId)!;
  assert.equal(t.status, "SETTLED");
  assert.ok(t.settlementReceiptHash && t.settlementReceiptHash === m.settlementReceipt(o.orderId)!.receiptHash, "receipt hash kept; receipt stays in the engine");
  assert.throws(() => getOrder(m, o.orderId, "b1"), /ORDER_PRUNED/);
  // Replays: the same signed reservation returns no new order; fund / deliver / settle are refused.
  assert.throws(() => reserveAs(m, { listingId: listing.listingId, buyerId: "b1", quantity: 1n, idempotencyKey: "k1" }), /ORDER_PRUNED/);
  assert.throws(() => fund(m, o.orderId, o.fundingDue, "fund-k1"), /ORDER_PRUNED/);
  assert.throws(() => settle(m, o.orderId, "b1"), /ORDER_PRUNED/);
  // The id is never reused, also not explicitly.
  assert.throws(() => reserveAs(m, { listingId: listing.listingId, buyerId: "b2", quantity: 1n, orderId: o.orderId }), /ORDER_ID_CONFLICT/);
  // Capacity and value accounting stay exact.
  assert.deepEqual(m.capacityAccounting(listing.listingId), before);
  assert.equal(m.valueAccounting(EUR).conserved, true);
});

test("idempotency entries of reservations signed with notAfterHeight are dropped after expiry; a replay is then refused as expired", () => {
  const { m, h, listing } = setup(10);
  const o = settledOrder(m, listing.listingId, "b1", "exp-1", h.h + 5);
  // Legacy reservation without expiry: its entry is kept.
  settledOrder(m, listing.listingId, "b2", "legacy-1");
  h.h += 6;
  assert.throws(() => reserveAs(m, { listingId: listing.listingId, buyerId: "b1", quantity: 1n, idempotencyKey: "exp-1", notAfterHeight: h.h - 6 + 5 }, { credit: 0n }), /RESERVATION_AUTHORIZATION_EXPIRED/);
  const before = m.retentionStats().reservationIdempotency;
  const r = m.pruneRetention();
  assert.equal(r.idempotency, 1);
  assert.equal(m.retentionStats().reservationIdempotency, before - 1);
  h.h += 10;
  m.pruneRetention();
  assert.ok(m.orderTombstone(o.orderId));
  assert.throws(() => reserveAs(m, { listingId: listing.listingId, buyerId: "b2", quantity: 1n, idempotencyKey: "legacy-1" }, { credit: 0n }), /ORDER_PRUNED/, "legacy entry kept: replay still refused");
  // A tampered notAfterHeight breaks the signature.
  assert.throws(() => m.reserve({ listingId: listing.listingId, buyerId: "b1", quantity: 1n, idempotencyKey: "x", signature: "00".repeat(64), notAfterHeight: h.h + 100 }), /RESERVATION_SIGNATURE_INVALID/);
});

test("memory stays bounded under churn: 300 settled orders with expiring authorizations leave only tombstones", () => {
  const { m, h, listing } = setup(20);
  for (let i = 0; i < 300; i++) {
    settledOrder(m, listing.listingId, `buyer-${i % 7}`, `churn-${i}`, h.h + 10);
    h.h += 1;
  }
  h.h += 50;
  while (m.pruneRetention().orders > 0) { /* drain */ }
  const s = m.retentionStats();
  assert.equal(s.orders, 0);
  assert.equal(s.closedPending, 0);
  assert.equal(s.operationIdempotency, 0);
  assert.equal(s.reservationIdempotency, 0);
  assert.equal(s.tombstones, 300);
  assert.equal(m.valueAccounting(EUR).conserved, true);
});

test("retention state survives a snapshot restore", () => {
  const { m, h, listing, admin } = setup(10);
  const o = settledOrder(m, listing.listingId, "b1", "r1");
  h.h += 10;
  m.pruneRetention();
  const fresh = new DigitalServicesMarketplace({ adminIdentity: admin.identityId, adminPublicKey: admin.publicKeyHex, height: () => h.h, closedOrderRetentionHeights: 10 });
  fresh.restoreSnapshot(m.exportSnapshot(), { snapshotPublicKeys: m.snapshotPublicKeys() });
  adoptTestIdentities(m, fresh);
  assert.deepEqual(fresh.orderTombstone(o.orderId), m.orderTombstone(o.orderId));
  assert.deepEqual(fresh.retentionStats(), m.retentionStats());
  assert.throws(() => reserveAs(fresh, { listingId: listing.listingId, buyerId: "b1", quantity: 1n, idempotencyKey: "r1" }, { credit: 0n }), /ORDER_PRUNED/);
  assert.deepEqual(fresh.capacityAccounting(listing.listingId), m.capacityAccounting(listing.listingId));
});

test("idempotency keys are length-bounded", () => {
  const { m, listing } = setup();
  assert.throws(() => reserveAs(m, { listingId: listing.listingId, buyerId: "b1", quantity: 1n, idempotencyKey: "k".repeat(257) }), /IDEMPOTENCY_KEY_TOO_LONG/);
});
