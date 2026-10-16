/**
 * v0.5.3 settlement bridge: Marketplace settlement receipts are anchored in
 * the ledger (consensus) state; the ledger verifies them, chains anchors,
 * commits them in the signed snapshot and re-checks them on restore.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { createTestAuthority, deliver, fund, publishAs, reserveAs, settle } from "../marketplace/testkit.ts";
import { UepLedger, signSnapshot } from "../testnet/ledger.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { TESTNET } from "../network/profiles.ts";
import { receiptInclusionProof, verifyReceiptInclusion } from "./batch.ts";
import { settlementReceiptHash } from "./engine.ts";
import { GENESIS_ANCHOR_HASH, signSettlementAnchorRequest } from "./anchor.ts";
import type { SettlementReceipt } from "./types.ts";

const ADMIN = createTestAuthority("admin-1");
const SNAP = generateEd25519KeyPair();
const ANCHOR = generateEd25519KeyPair();
const MKT = "uep-marketplace-testnet";
const ledger = () => new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: false, snapshotSigningKeys: [SNAP.privateKey], faucetSigningKey: null, settlementAnchorAuthorities: { [MKT]: [ANCHOR.publicKeyHex] } });
/** Direct ledger call signed with the Marketplace anchor key (what Marketplace.anchorSettlements does). */
function authed(l: UepLedger, input: { marketplaceId: string; treasuryId: string; receipts: SettlementReceipt[] }) {
  const prev = l.settlementAnchors[l.settlementAnchors.length - 1];
  return { ...input, authorization: signSettlementAnchorRequest(ANCHOR.privateKey, ANCHOR.publicKeyHex, { ...input, networkId: l.networkId, index: l.settlementAnchors.length, prevAnchorHash: prev?.anchorHash ?? GENESIS_ANCHOR_HASH }) };
}

function market(n: number) {
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: () => 1_700_000_000_000, adminIdentity: "admin-1", adminPublicKey: ADMIN.publicKeyHex, adminAuthorizer: (id) => id === "admin-1", anchorSigningKey: ANCHOR.privateKey });
  const listing = publishAs(m, { providerId: "p1", title: "t", description: "d", category: "COMPUTE", asset: "EUR", unitPrice: 20n, capacity: 1000n });
  for (let i = 0; i < n; i++) {
    const o = reserveAs(m, { listingId: listing.listingId, buyerId: `b${i}`, quantity: 5n });
    fund(m, o.orderId, 99n, undefined, `b${i}`);
    deliver(m, o.orderId, "p1", Buffer.from("r" + i));
    settle(m, o.orderId, `b${i}`);
  }
  return m;
}

test("settled orders anchor into ledger state; inclusion proofs verify against the anchored root", () => {
  const m = market(3);
  const l = ledger();
  l.advanceHeight(4);
  const anchor = m.anchorSettlements(l)!;
  assert.equal(anchor.count, 3);
  assert.equal(anchor.height, 4);
  assert.equal(anchor.totals.EUR!.fees, "9");
  const receipts = m.exportSnapshot().settlement.receipts;
  const found = l.settlementAnchorOf(m.marketplaceId, receipts[1]!.settlementId)!;
  assert.equal(found.position, 1);
  assert.ok(verifyReceiptInclusion(receipts[1]!, 1, anchor.count, receiptInclusionProof(receipts, 1), found.anchor.batchRoot));
  // Nothing new to anchor; a second anchor of the same settlements is refused by the ledger.
  assert.equal(m.anchorSettlements(l), undefined);
  assert.throws(() => l.anchorSettlements(authed(l, { marketplaceId: m.marketplaceId, treasuryId: m.treasury.treasuryId, receipts: [receipts[0]!] })), /already anchored/);
});

test("the ledger refuses forged, unconserved or foreign-treasury receipts", () => {
  const m = market(1);
  const [r] = m.exportSnapshot().settlement.receipts;
  const l = ledger();
  const base = { marketplaceId: m.marketplaceId, treasuryId: m.treasury.treasuryId };
  assert.throws(() => l.anchorSettlements(authed(l, { ...base, receipts: [{ ...r!, providerNet: r!.providerNet + 1n }] })), /hash does not match/);
  const { receiptHash: _h, ...body } = { ...r!, providerNet: r!.providerNet + 1n };
  assert.throws(() => l.anchorSettlements(authed(l, { ...base, receipts: [{ ...body, receiptHash: settlementReceiptHash(body) }] })), /not conserved/);
  assert.throws(() => l.anchorSettlements(authed(l, { ...base, treasuryId: "other", receipts: [r!] })), /treasury mismatch/);
  assert.throws(() => l.anchorSettlements(authed(l, { ...base, receipts: [] })), /no receipts/);
  assert.equal(l.settlementAnchors.length, 0);
});

test("anchors are committed in the signed snapshot and re-checked on restore", () => {
  const m = market(2);
  const l = ledger();
  m.anchorSettlements(l);
  const snap = l.snapshot();
  const trust = { authorities: [SNAP.publicKeyHex] };
  const r = UepLedger.restore(snap, trust);
  assert.equal(r.settlementAnchors.length, 1);
  const receipts = m.exportSnapshot().settlement.receipts;
  // Anchor keys are operator configuration (not snapshot state): set again on the restored ledger.
  assert.throws(() => r.anchorSettlements(authed(r, { marketplaceId: m.marketplaceId, treasuryId: m.treasury.treasuryId, receipts: [receipts[0]!] })), /SETTLEMENT_ANCHOR_UNAUTHORIZED/);
  r.setSettlementAnchorAuthority(MKT, [ANCHOR.publicKeyHex]);
  assert.throws(() => r.anchorSettlements(authed(r, { marketplaceId: m.marketplaceId, treasuryId: m.treasury.treasuryId, receipts: [receipts[0]!] })), /already anchored/);
  const tampered = JSON.parse(JSON.stringify(snap, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  tampered.settlementAnchors[0].batchRoot = "00".repeat(32);
  const { snapshotHash: _x, signatures: _s, ...payload } = tampered;
  assert.throws(() => UepLedger.restore(signSnapshot(payload, [SNAP.privateKey]), trust), /INVALID_SNAPSHOT_SETTLEMENT_ANCHOR/);
});
