/**
 * v0.5.3 regression tests (Marketplace snapshot format 3, settlement anchors):
 * - after a restart (restoreSnapshot) a repeated purchase gets a new order id
 *   and can settle or be refunded (no escrow stuck behind an already executed
 *   settlement id); an explicit order id that already has a receipt is refused;
 * - Marketplace snapshots are signed: unsigned, forged or untrusted snapshots
 *   are refused (format 1 / 2 migration: src/settlement/receipt-network.test.ts);
 * - legacy v1 receipts are accepted only from migrated old snapshots and are
 *   never anchored; anchoring requires the Marketplace anchor key.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "./marketplace.ts";
import { createTestAuthority, deliver, fund, publishAs, refundAs, reserveAs, settle } from "./testkit.ts";
import { buildMarketplaceSnapshot, marketplaceSnapshotFromJSON, marketplaceSnapshotToJSON, type MarketplaceSnapshot } from "./marketplace-snapshot.ts";
import { settlementReceiptHash } from "../settlement/engine.ts";
import { GENESIS_ANCHOR_HASH, signSettlementAnchorRequest } from "../settlement/anchor.ts";
import { LEGACY_SETTLEMENT_RECEIPT_VERSION, type SettlementReceipt } from "../settlement/types.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { TESTNET } from "../network/profiles.ts";

const ADMIN = createTestAuthority("admin-1");
const SNAPKEY = generateEd25519KeyPair();
const ANCHOR = generateEd25519KeyPair();
const EUR = "uep-test/teur";
const mk = () => new DigitalServicesMarketplace({ height: () => 10, adminIdentity: "admin-1", adminPublicKey: ADMIN.publicKeyHex, adminAuthorizer: (id) => id === "admin-1", snapshotSigningKeys: [SNAPKEY.privateKey], anchorSigningKey: ANCHOR.privateKey });
const listing = (m: DigitalServicesMarketplace) => publishAs(m, { providerId: "p1", title: "restart", description: "d", category: "COMPUTE", asset: EUR, unitPrice: 100n, capacity: 10n });

function settledOnce(m = mk(), key = "buy-1") {
  const l = listing(m);
  const o = reserveAs(m, { listingId: l.listingId, buyerId: "b1", quantity: 1n, idempotencyKey: key });
  fund(m, o.orderId, o.fundingDue, undefined, "b1");
  deliver(m, o.orderId, "p1", Buffer.from("x"));
  settle(m, o.orderId, "b1");
  return { m, orderId: o.orderId };
}

test("after a restart a repeated purchase gets a new order id and settles; refund also stays reachable", () => {
  const { m: m1, orderId } = settledOnce();
  const snap = m1.exportSnapshot();
  assert.ok(snap.orderSequence >= 2);
  for (const key of ["buy-1", "a-different-key"]) {
    const m2 = mk();
    assert.equal(m2.restoreSnapshot(marketplaceSnapshotFromJSON(marketplaceSnapshotToJSON(snap))), 1);
    const l2 = listing(m2);
    const o2 = reserveAs(m2, { listingId: l2.listingId, buyerId: "b1", quantity: 1n, idempotencyKey: key });
    assert.notEqual(o2.orderId, orderId);
    fund(m2, o2.orderId, o2.fundingDue, undefined, "b1");
    deliver(m2, o2.orderId, "p1", Buffer.from("x"));
    if (key === "buy-1") settle(m2, o2.orderId, "b1");
    else refundAs(m2, "p1", o2.orderId);
    assert.equal(m2.heldBalance(EUR, "b1"), 0n);
  }
});

test("generated ids skip ids that already have a receipt; an explicit one is refused", () => {
  const { m: m1, orderId } = settledOnce();
  const snap = m1.exportSnapshot();
  // A counter behind the receipts (e.g. a migrated snapshot) still never reuses an executed id.
  const m2 = mk();
  m2.restoreSnapshot(snap);
  (m2 as unknown as { sequence: number }).sequence = 0;
  const l2 = listing(m2);
  const o2 = reserveAs(m2, { listingId: l2.listingId, buyerId: "b1", quantity: 1n });
  assert.notEqual(o2.orderId, orderId);
  assert.throws(() => reserveAs(m2, { listingId: l2.listingId, buyerId: "b2", quantity: 1n, orderId }), /ORDER_ID_CONFLICT/);
});

test("Marketplace snapshots are signed; unsigned, forged or untrusted ones are refused", () => {
  const { m: m1 } = settledOnce();
  const snap = m1.exportSnapshot();
  assert.equal(snap.formatVersion, 3);
  assert.equal(snap.signatures?.length, 1);
  const { signatures: _s, ...unsigned } = snap;
  assert.throws(() => mk().restoreSnapshot(unsigned as MarketplaceSnapshot), /UNSIGNED|SIGNATURE_INVALID/);
  // The legacy shim does not apply to format 3.
  assert.throws(() => mk().restoreSnapshot(unsigned as MarketplaceSnapshot, { snapshotPublicKeys: [SNAPKEY.publicKeyHex], acceptUnsignedLegacySnapshot: true }), /UNSIGNED|SIGNATURE_INVALID/);
  // A snapshot fabricated and signed by a key the operator does not trust (receipt for a future order id).
  const r = snap.settlement.receipts[0]!;
  const { receiptHash: _h, ...body } = { ...r, settlementId: "order-victim-1" };
  const invented = { ...body, receiptHash: settlementReceiptHash(body) } as SettlementReceipt;
  const attacker = generateEd25519KeyPair();
  const forged = buildMarketplaceSnapshot({ marketplaceId: m1.marketplaceId, treasuryId: m1.treasury.treasuryId, networkId: TESTNET.networkId, height: 10, orderSequence: 0, receipts: [invented], signingKeys: [attacker.privateKey] });
  const victim = mk();
  assert.throws(() => victim.restoreSnapshot(forged), /SIGNATURE_INVALID/);
  // A changed field breaks the hash before any signature is considered.
  const tampered = JSON.parse(marketplaceSnapshotToJSON(snap));
  tampered.orderSequence = 0;
  assert.throws(() => mk().restoreSnapshot(marketplaceSnapshotFromJSON(JSON.stringify(tampered))), /HASH_MISMATCH/);
  // The victim still settles its real order id normally.
  const l = listing(victim);
  const o = reserveAs(victim, { listingId: l.listingId, buyerId: "b1", quantity: 1n, orderId: "order-victim-1" });
  fund(victim, o.orderId, o.fundingDue, undefined, "b1");
  deliver(victim, o.orderId, "p1", Buffer.from("x"));
  settle(victim, o.orderId, "b1");
});

test("a receipt downgraded to v1 is refused in a format 3 snapshot, even when signed by the operator key", () => {
  const { m: m1 } = settledOnce();
  const r = m1.exportSnapshot().settlement.receipts[0]!;
  const { receiptHash: _h, networkId: _n, ...rest } = r;
  const v1Body = { ...rest, version: LEGACY_SETTLEMENT_RECEIPT_VERSION } as Omit<SettlementReceipt, "receiptHash">;
  const downgraded = { ...v1Body, receiptHash: settlementReceiptHash(v1Body) } as SettlementReceipt;
  const snap = buildMarketplaceSnapshot({ marketplaceId: m1.marketplaceId, treasuryId: m1.treasury.treasuryId, networkId: TESTNET.networkId, height: 10, orderSequence: 5, receipts: [downgraded], signingKeys: [SNAPKEY.privateKey] });
  assert.throws(() => mk().restoreSnapshot(snap), /SETTLEMENT_RECEIPT_LEGACY_NOT_ALLOWED/);
  // Listing it as legacy does not help: the hash covers the list and the operator never signs it for a new receipt...
  const listed = buildMarketplaceSnapshot({ marketplaceId: m1.marketplaceId, treasuryId: m1.treasury.treasuryId, networkId: TESTNET.networkId, height: 10, orderSequence: 5, receipts: [downgraded], legacyV1SettlementIds: [downgraded.settlementId], signingKeys: [generateEd25519KeyPair().privateKey] });
  assert.throws(() => mk().restoreSnapshot(listed), /SIGNATURE_INVALID/);
});

test("anchoring requires the Marketplace anchor key; v1 and invented receipts are never anchored", () => {
  const { m } = settledOnce();
  const ledger = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: false, snapshotSigningKeys: [generateEd25519KeyPair().privateKey], faucetSigningKey: null });
  const receipts = m.exportSnapshot().settlement.receipts;
  const base = { marketplaceId: m.marketplaceId, treasuryId: m.treasury.treasuryId, receipts };
  // No key configured for this marketplace: nobody can anchor under its id.
  assert.throws(() => m.anchorSettlements(ledger), /SETTLEMENT_ANCHOR_UNAUTHORIZED/);
  ledger.setSettlementAnchorAuthority(m.marketplaceId, [m.anchorPublicKeyHex()]);
  // Unsigned or signed by another key: refused.
  assert.throws(() => ledger.anchorSettlements(base), /SETTLEMENT_ANCHOR_UNAUTHORIZED/);
  const other = generateEd25519KeyPair();
  const sign = (k: { privateKey: never; publicKeyHex: string } | typeof other, rs: SettlementReceipt[], index = 0, prev = GENESIS_ANCHOR_HASH) =>
    signSettlementAnchorRequest(k.privateKey, k.publicKeyHex, { ...base, receipts: rs, networkId: ledger.networkId, index, prevAnchorHash: prev });
  assert.throws(() => ledger.anchorSettlements({ ...base, authorization: sign(other, receipts) }), /SETTLEMENT_ANCHOR_UNAUTHORIZED/);
  // A valid signature over other receipts, another index or another network does not transfer.
  const { receiptHash: _h, ...body } = { ...receipts[0]!, settlementId: "invented-1" };
  const invented = { ...body, receiptHash: settlementReceiptHash(body) } as SettlementReceipt;
  assert.throws(() => ledger.anchorSettlements({ ...base, receipts: [invented], authorization: sign(ANCHOR as never, receipts) }), /SETTLEMENT_ANCHOR_UNAUTHORIZED/);
  assert.throws(() => ledger.anchorSettlements({ ...base, authorization: sign(ANCHOR as never, receipts, 1) }), /SETTLEMENT_ANCHOR_UNAUTHORIZED/);
  // A v1-downgraded receipt is refused even with a valid Marketplace signature.
  const { receiptHash: _h2, networkId: _n, ...rest } = receipts[0]!;
  const v1Body = { ...rest, settlementId: "v1-copy", version: LEGACY_SETTLEMENT_RECEIPT_VERSION } as Omit<SettlementReceipt, "receiptHash">;
  const v1 = { ...v1Body, receiptHash: settlementReceiptHash(v1Body) } as SettlementReceipt;
  assert.throws(() => ledger.anchorSettlements({ ...base, receipts: [v1], authorization: sign(ANCHOR as never, [v1]) }), /legacy v1 receipts are not anchored/);
  assert.equal(ledger.settlementAnchors.length, 0);
  // The Marketplace path signs and anchors.
  const a = m.anchorSettlements(ledger)!;
  assert.equal(a.count, 1);
});
