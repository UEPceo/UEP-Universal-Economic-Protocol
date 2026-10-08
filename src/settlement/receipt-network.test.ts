/**
 * v0.5.3: settlement receipts v2 bind the networkId inside the hash. Legacy
 * v1 receipts (v0.5.2) still verify through the versioned alias, and a
 * format 1 Marketplace snapshot migrates to format 2 with them unchanged.
 * v0.5.3 (format 3): v1 receipts are accepted only as the listed legacy
 * receipts of a migrated format 1 / 2 snapshot and are never anchored.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { settlementReceiptHash, verifySettlementReceipt } from "./engine.ts";
import { LEGACY_SETTLEMENT_RECEIPT_VERSION, SETTLEMENT_RECEIPT_VERSION } from "./types.ts";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { createTestAuthority, deliver, fund, publishAs, reserveAs, settle } from "../marketplace/testkit.ts";
import { marketplaceSnapshotFromJSON, migrateMarketplaceSnapshot, marketplaceMigrationRegistryProblems } from "../marketplace/marketplace-snapshot.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../marketplace/fixtures/snapshots/mkt-v1-receipts-v1.json");
const FIXTURE_V2 = path.join(path.dirname(fileURLToPath(import.meta.url)), "../marketplace/fixtures/snapshots/mkt-v2-receipts-v1-v2.json");
const ADMIN = createTestAuthority("admin-1");
const SNAPKEY = generateEd25519KeyPair();
const mkK = () => new DigitalServicesMarketplace({ height: () => 10, adminIdentity: "admin-1", adminPublicKey: ADMIN.publicKeyHex, adminAuthorizer: (id) => id === "admin-1", snapshotSigningKeys: [SNAPKEY.privateKey] });
const listingK = (m: DigitalServicesMarketplace) => publishAs(m, { providerId: "p1", title: "restart", description: "d", category: "COMPUTE", asset: "uep-test/teur", unitPrice: 100n, capacity: 10n });
const mk = (ledgerNetworkId?: string) => new DigitalServicesMarketplace({ height: () => 42, adminIdentity: "admin-1", adminPublicKey: ADMIN.publicKeyHex, adminAuthorizer: (id) => id === "admin-1", ...(ledgerNetworkId ? { ledgerNetworkId } : {}) });

function settled(m = mk()) {
  const l = publishAs(m, { providerId: "p1", title: "t", description: "d", category: "COMPUTE", asset: "uep-test/teur", unitPrice: 20n, capacity: 100n });
  const o = reserveAs(m, { listingId: l.listingId, buyerId: "b0", quantity: 5n });
  fund(m, o.orderId, 99n, undefined, "b0");
  deliver(m, o.orderId, "p1", Buffer.from("r"));
  settle(m, o.orderId, "b0");
  return { m, receipt: m.settlementReceipt(o.orderId)! };
}

test("v2 receipts bind the networkId: changing it breaks the hash", () => {
  const { receipt } = settled();
  assert.equal(receipt.version, SETTLEMENT_RECEIPT_VERSION);
  assert.equal(receipt.networkId, "uep-testnet-1");
  assert.equal(verifySettlementReceipt(receipt), true);
  assert.equal(verifySettlementReceipt({ ...receipt, networkId: "uep-global-1" }), false);
  const { networkId: _n, receiptHash: _h, ...noNet } = receipt;
  assert.throws(() => settlementReceiptHash(noNet as never), /NETWORK_REQUIRED/);
});

test("legacy v1 receipts verify through the alias; a v1 receipt cannot smuggle a networkId", () => {
  const fx = marketplaceSnapshotFromJSON(fs.readFileSync(FIXTURE, "utf8"));
  const r = fx.settlement.receipts[0]!;
  assert.equal(r.version, LEGACY_SETTLEMENT_RECEIPT_VERSION);
  assert.equal(verifySettlementReceipt(r), true);
  assert.equal(verifySettlementReceipt({ ...r, networkId: "uep-testnet-1" }), false);
  assert.equal(verifySettlementReceipt({ ...r, version: SETTLEMENT_RECEIPT_VERSION }), false);
});

test("format 1 Marketplace snapshot (v1 receipts) migrates to the current format and restores (unsigned legacy shim)", () => {
  const fx = marketplaceSnapshotFromJSON(fs.readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(marketplaceMigrationRegistryProblems(), []);
  const migrated = migrateMarketplaceSnapshot(fx as never);
  assert.equal(migrated.formatVersion, 4);
  assert.deepEqual(migrated.settlement.legacyV1SettlementIds, ["ord-fixture-0", "ord-fixture-1"]);
  assert.equal(migrated.networkId, null);
  assert.deepEqual(migrated.settlement.receiptVersions, [LEGACY_SETTLEMENT_RECEIPT_VERSION]);
  assert.equal(migrated.settlement.batchRoot, (fx as never as { settlement: { batchRoot: string } }).settlement.batchRoot);
  const m = mk();
  assert.throws(() => mk().restoreSnapshot(fx as never), /MARKETPLACE_SNAPSHOT_UNSIGNED/);
  assert.equal(m.restoreSnapshot(fx as never, { snapshotPublicKeys: [], acceptUnsignedLegacySnapshot: true }), 2);
  // Mixed: new v2 receipts are added next to the legacy ones and the next snapshot lists both versions.
  settled(m);
  assert.deepEqual(m.exportSnapshot().settlement.receiptVersions, [LEGACY_SETTLEMENT_RECEIPT_VERSION, SETTLEMENT_RECEIPT_VERSION]);
});

test("restore and anchoring refuse v2 receipts of another network", () => {
  const { m } = settled(mk("uep-global-1"));
  const snap = m.exportSnapshot();
  assert.throws(() => mk().restoreSnapshot(snap, { snapshotPublicKeys: m.snapshotPublicKeys() }), /NETWORK_MISMATCH/);
  const key = generateEd25519KeyPair();
  const ledger = new UepLedger({ networkId: "uep-testnet-1", domainId: "EARTH", connected: true, allowFaucet: false, snapshotSigningKeys: [key.privateKey], faucetSigningKey: null });
  assert.throws(() => m.anchorSettlements(ledger), /network mismatch/);
});

test("migration: an unsigned format 2 snapshot restores only via the shim; counter and legacy ids are derived", () => {
  const fx = marketplaceSnapshotFromJSON(fs.readFileSync(FIXTURE_V2, "utf8"));
  assert.equal(fx.formatVersion, 2);
  const migrated = migrateMarketplaceSnapshot(fx as never);
  assert.equal(migrated.formatVersion, 4);
  assert.equal(migrated.orderSequence, 3);
  assert.deepEqual(migrated.settlement.legacyV1SettlementIds, ["ord-fixture-0", "ord-fixture-1"]);
  assert.throws(() => mkK().restoreSnapshot(fx as never), /MARKETPLACE_SNAPSHOT_UNSIGNED/);
  const m = mkK();
  assert.equal(m.restoreSnapshot(fx as never, { snapshotPublicKeys: [], acceptUnsignedLegacySnapshot: true }), 3);
  // The next snapshot is format 3, signed, and keeps the legacy list; it restores with the operator key.
  const next = m.exportSnapshot();
  assert.equal(next.formatVersion, 4);
  assert.deepEqual(next.settlement.legacyV1SettlementIds, ["ord-fixture-0", "ord-fixture-1"]);
  assert.equal(mkK().restoreSnapshot(next), 3);
  // A new purchase after the migration never reuses a restored id.
  const ids = new Set(fx.settlement.receipts.map((r) => r.settlementId));
  const l = listingK(m);
  for (const b of ["b0", "b1", "b2"]) assert.ok(!ids.has(reserveAs(m, { listingId: l.listingId, buyerId: b, quantity: 1n }).orderId));
});

test("restored legacy v1 receipts stay readable but are not anchored", () => {
  const fx = marketplaceSnapshotFromJSON(fs.readFileSync(FIXTURE, "utf8"));
  const m = mkK();
  m.restoreSnapshot(fx as never, { snapshotPublicKeys: [], acceptUnsignedLegacySnapshot: true });
  assert.ok(m.settlementReceipt("ord-fixture-0"));
  const ledger = new UepLedger({ networkId: "uep-testnet-1", domainId: "EARTH", connected: true, allowFaucet: false, snapshotSigningKeys: [generateEd25519KeyPair().privateKey], faucetSigningKey: null, settlementAnchorAuthorities: { [m.marketplaceId]: [m.anchorPublicKeyHex()] } });
  assert.equal(m.anchorSettlements(ledger), undefined);
});
