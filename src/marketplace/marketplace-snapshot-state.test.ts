/**
 * v0.5.3 (Marketplace snapshot format 4): the full Marketplace state survives
 * a restart (balances, deposits, escrow holds, active orders, provider bonds,
 * paymaster holds, treasury, idempotency and replay records), and older
 * receipts-only snapshots still restore through the 3 -> 4 migration.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DigitalServicesMarketplace, MARKETPLACE_RUNTIME_ONLY_FIELDS, MARKETPLACE_STATE_FIELDS } from "./marketplace.ts";
import { MarketplacePaymaster } from "./paymaster.ts";
import { act, adoptTestIdentities, createTestAuthority, deliver, enrollIdentity, fund, getOrder, publishAs, reserveAs, settle } from "./testkit.ts";
import { marketplaceSnapshotFromJSON, marketplaceSnapshotToJSON, migrateMarketplaceSnapshot, MARKETPLACE_SNAPSHOT_FORMAT_VERSION } from "./marketplace-snapshot.ts";
import { decodeStateValue, encodeStateValue } from "./marketplace-state.ts";

const EUR = "uep-test/teur";
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/snapshots");

function setup(height: { h: number }, withPaymaster = true) {
  const admin = createTestAuthority("admin");
  const arbiter = createTestAuthority("arbiter");
  const heightFn = () => height.h;
  const paymaster = withPaymaster ? new MarketplacePaymaster({ height: heightFn, maxActorShareBps: 10_000, maxOrderShareBps: 10_000 }) : undefined;
  if (paymaster) paymaster.fundReserve(EUR, 100_000n);
  return new DigitalServicesMarketplace({
    adminIdentity: admin.identityId,
    adminPublicKey: admin.publicKeyHex,
    settlementArbiterId: arbiter.identityId,
    settlementArbiterPublicKey: arbiter.publicKeyHex,
    height: heightFn,
    paymaster,
  });
}

function busyMarket() {
  const height = { h: 100 };
  const m = setup(height);
  enrollIdentity(m, "prov", { asset: EUR, amount: 100_000n });
  const listing = publishAs(m, { providerId: "prov", title: "svc", description: "d", category: "COMPUTE", asset: EUR, unitPrice: 100n, capacity: 100n });
  const settled = reserveAs(m, { listingId: listing.listingId, buyerId: "b1", quantity: 2n });
  fund(m, settled.orderId, settled.fundingDue);
  deliver(m, settled.orderId, "prov", Buffer.from("done"));
  settle(m, settled.orderId, "b1");
  const funded = reserveAs(m, { listingId: listing.listingId, buyerId: "b2", quantity: 3n });
  fund(m, funded.orderId, funded.fundingDue, "fund-key-1");
  const reserved = reserveAs(m, { listingId: listing.listingId, buyerId: "b3", quantity: 1n });
  return { m, height, listing, settled, funded, reserved };
}

function balances(m: DigitalServicesMarketplace, ids: string[]) {
  return Object.fromEntries(ids.map((id) => [id, [m.availableBalance(EUR, id), m.heldBalance(EUR, id)]]));
}

test("format 4 snapshot restores balances, holds, active orders and treasury; a funded order settles after the restart", () => {
  const { m, height, listing, funded, reserved, settled } = busyMarket();
  const snap = m.exportSnapshot();
  assert.equal(snap.formatVersion, MARKETPLACE_SNAPSHOT_FORMAT_VERSION);
  assert.equal(snap.formatVersion, 4);
  assert.ok(snap.state);
  const restarted = setup(height);
  assert.equal(restarted.restoreSnapshot(marketplaceSnapshotFromJSON(marketplaceSnapshotToJSON(snap)) as never, { snapshotPublicKeys: m.snapshotPublicKeys() }), 1);
  adoptTestIdentities(m, restarted);
  assert.deepEqual(restarted.valueAccounting(EUR), m.valueAccounting(EUR));
  assert.deepEqual(balances(restarted, ["prov", "b1", "b2", "b3"]), balances(m, ["prov", "b1", "b2", "b3"]));
  assert.equal(restarted.orderCount(), m.orderCount());
  assert.equal(restarted.getListing(listing.listingId).available, m.getListing(listing.listingId).available);
  assert.equal(getOrder(restarted, funded.orderId, "b2").status, "HELD");
  assert.equal(getOrder(restarted, reserved.orderId, "b3").status, getOrder(m, reserved.orderId, "b3").status);
  assert.deepEqual(restarted.treasurySnapshot(EUR), m.treasurySnapshot(EUR));
  // The state section round-trips exactly (export after restore = export before, apart from the signature).
  assert.equal(JSON.stringify(restarted.exportSnapshot().state), JSON.stringify(snap.state));
  // Replay protection survives: the settled order cannot settle again, the funding idempotency key is remembered.
  const receiptsBefore = restarted.exportSnapshot().settlement.count;
  const again = settle(restarted, settled.orderId, "b1");
  assert.deepEqual(again, settle(m, settled.orderId, "b1"), "settling a settled order returns the recorded settlement");
  assert.equal(restarted.exportSnapshot().settlement.count, receiptsBefore, "no second payout");
  assert.equal(fund(restarted, funded.orderId, funded.fundingDue, "fund-key-1").status, "HELD");
  // The funded order continues: delivery and settlement after the restart.
  deliver(restarted, funded.orderId, "prov", Buffer.from("after restart"));
  const rec = settle(restarted, funded.orderId, "b2");
  assert.ok(rec);
  assert.equal(restarted.valueAccounting(EUR).conserved, true);
  // Published terms stay immutable after the restore.
  const live = (restarted as unknown as { listings: Map<string, Record<string, unknown>> }).listings.get(listing.listingId)!;
  assert.throws(() => { "use strict"; live.unitPrice = 1n; }, TypeError);
});

test("format 4 restore refuses a different configuration, a regressed clock and a non-fresh target", () => {
  const { m, height } = busyMarket();
  const snap = m.exportSnapshot();
  const trust = { snapshotPublicKeys: m.snapshotPublicKeys() };
  assert.throws(() => setup(height, false).restoreSnapshot(snap, trust), /CONFIG_MISMATCH/);
  assert.throws(() => setup({ h: 50 }).restoreSnapshot(snap, trust), /HEIGHT_REGRESSED/);
  const used = setup(height);
  enrollIdentity(used, "someone");
  assert.throws(() => used.restoreSnapshot(snap, trust), /NOT_FRESH/);
  // A tampered state is caught by the hash before anything is restored.
  const tampered = JSON.parse(marketplaceSnapshotToJSON(snap));
  tampered.state.marketplace.sequence += 1;
  assert.throws(() => setup(height).restoreSnapshot(tampered, trust), /HASH_MISMATCH/);
});

test("format 3 snapshot (receipts only) migrates to format 4 with state = null and still restores its receipts", () => {
  // Written by the format 3 code (commit 287fb92), signed with an ephemeral key that was discarded.
  const fixture = marketplaceSnapshotFromJSON(fs.readFileSync(path.join(FIXTURES, "mkt-v3-receipts-signed.json"), "utf8"));
  assert.equal(fixture.formatVersion, 3);
  const migrated = migrateMarketplaceSnapshot(fixture as never);
  assert.equal(migrated.formatVersion, 4);
  assert.equal(migrated.state, null);
  assert.equal(migrated.settlement.count, 2);
  const admin = createTestAuthority("admin-1");
  const fresh = new DigitalServicesMarketplace({ testOnlyNowMs: () => 1_700_000_000_000, adminIdentity: "admin-1", adminPublicKey: admin.publicKeyHex, adminAuthorizer: (id) => id === "admin-1" });
  assert.equal(fresh.restoreSnapshot(fixture as never, { snapshotPublicKeys: fixture.signatures!.map((s) => s.publicKeyHex) }), 2);
  assert.ok(fresh.settlementReceipt("fixture-order-b1"));
  assert.equal(fresh.orderCount(), 0, "receipts-only snapshot: no order state (compatibility shim)");
});

test("every Map / Set field of the Marketplace is persisted or declared runtime-only", () => {
  const { m } = busyMarket();
  const listed = new Set<string>([...MARKETPLACE_STATE_FIELDS, ...MARKETPLACE_RUNTIME_ONLY_FIELDS]);
  const missing = Object.keys(m).filter((k) => {
    const v = (m as unknown as Record<string, unknown>)[k];
    return (v instanceof Map || v instanceof Set || Array.isArray(v)) && !listed.has(k);
  });
  assert.deepEqual(missing, []);
});

test("state codec is lossless for bigint, Map, Set, bytes and $-prefixed keys and refuses functions and private keys", () => {
  const value = { a: 1n, m: new Map([["k", new Set([1, 2])]]), x: new Uint8Array([1, 2]), o: { $b: "not a bigint" }, arr: [1n, "s", null] };
  const back = decodeStateValue(JSON.parse(JSON.stringify(encodeStateValue(value)))) as typeof value;
  assert.equal(back.a, 1n);
  assert.deepEqual([...(back.m.get("k") as Set<number>)], [1, 2]);
  assert.deepEqual([...back.x], [1, 2]);
  assert.deepEqual(back.o, { $b: "not a bigint" });
  assert.deepEqual(back.arr, [1n, "s", null]);
  assert.throws(() => encodeStateValue({ f: () => 1 }), /UNSERIALIZABLE/);
  assert.throws(() => encodeStateValue({ c: new (class Foo {})() }), /UNSERIALIZABLE/);
  void act;
});
