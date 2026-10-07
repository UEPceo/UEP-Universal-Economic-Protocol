import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "./marketplace.ts";
import { createTestAuthority, deliver, fund, publishAs, reserveAs, settle } from "./testkit.ts";
import { marketplaceSnapshotFromJSON, marketplaceSnapshotToJSON, marketplaceMigrationRegistryProblems } from "./marketplace-snapshot.ts";

const ADMIN = createTestAuthority("admin-1");
const mk = () => new DigitalServicesMarketplace({ testOnlyNowMs: () => 1_700_000_000_000, adminIdentity: "admin-1", adminPublicKey: ADMIN.publicKeyHex, adminAuthorizer: (id) => id === "admin-1" });

function settledMarket() {
  const m = mk();
  const listing = publishAs(m, { providerId: "p1", title: "t", description: "d", category: "COMPUTE", asset: "EUR", unitPrice: 20n, capacity: 100n });
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: "b1", quantity: 5n });
  fund(m, order.orderId, 99n);
  deliver(m, order.orderId, "p1", Buffer.from("r"));
  settle(m, order.orderId, "b1");
  return { m, orderId: order.orderId };
}

test("marketplace snapshot round-trips settlement receipts through JSON and restore", () => {
  const { m, orderId } = settledMarket();
  const snap = m.exportSnapshot();
  assert.equal(snap.settlement.count, 1);
  const text = marketplaceSnapshotToJSON(snap);
  const fresh = mk();
  assert.equal(fresh.restoreSnapshot(marketplaceSnapshotFromJSON(text) as never), 1);
  assert.deepEqual(fresh.settlementReceipt(orderId), m.settlementReceipt(orderId));
  assert.equal(fresh.exportSnapshot().settlement.batchRoot, snap.settlement.batchRoot);
});

test("marketplace snapshot restore refuses tampering, wrong binding and non-fresh targets", () => {
  const { m } = settledMarket();
  const snap = m.exportSnapshot();
  const tampered = JSON.parse(marketplaceSnapshotToJSON(snap));
  tampered.height += 1;
  assert.throws(() => mk().restoreSnapshot(tampered), /HASH_MISMATCH/);
  const other = new DigitalServicesMarketplace({ testOnlyNowMs: () => 1, marketplaceId: "other-mkt", adminIdentity: "admin-1", adminPublicKey: ADMIN.publicKeyHex, adminAuthorizer: (id) => id === "admin-1" });
  assert.throws(() => other.restoreSnapshot(snap), /MARKETPLACE_MISMATCH/);
  assert.throws(() => m.restoreSnapshot(snap), /NOT_FRESH/);
  assert.throws(() => mk().restoreSnapshot({ ...snap, formatVersion: 99 }), /FORMAT_UNSUPPORTED/);
  assert.deepEqual(marketplaceMigrationRegistryProblems(), []);
});
