/**
 * v0.5.3 cross-batch consistency: receipts settled over several rounds and
 * anchored in several ledger anchors form one append-only log. Each anchor's
 * root equals its slice, every receipt is anchored exactly once and in engine
 * order, per-asset totals add up, the anchor chain links, and an RFC 9162
 * consistency proof shows each later log only appends to the earlier one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { createTestAuthority, deliver, fund, publishAs, reserveAs, settle } from "../marketplace/testkit.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { TESTNET } from "../network/profiles.ts";
import { receiptLogConsistencyProof, receiptLogRoot, settlementBatch, verifyReceiptLogConsistency } from "./batch.ts";
import { anchorChainProblem } from "./anchor.ts";

const ADMIN = createTestAuthority("admin-1");
const SNAP = generateEd25519KeyPair();

test("receipts anchored over several rounds form one consistent append-only log", () => {
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: () => 1_700_000_000_000, adminIdentity: "admin-1", adminPublicKey: ADMIN.publicKeyHex, adminAuthorizer: (id) => id === "admin-1" });
  const l = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: false, snapshotSigningKeys: [SNAP.privateKey], faucetSigningKey: null, testOnlyUnboundedHeightAdvance: true });
  const eur = publishAs(m, { providerId: "p1", title: "t", description: "d", category: "COMPUTE", asset: "EUR", unitPrice: 20n, capacity: 10_000n });
  const usd = publishAs(m, { providerId: "p2", title: "u", description: "d", category: "COMPUTE", asset: "USD", unitPrice: 7n, capacity: 10_000n });
  let n = 0;
  const round = (k: number) => {
    for (let i = 0; i < k; i++, n++) {
      const listing = n % 3 === 0 ? usd : eur;
      const buyer = `b${n}`;
      const o = reserveAs(m, { listingId: listing.listingId, buyerId: buyer, quantity: BigInt(1 + (n % 4)) });
      fund(m, o.orderId, o.fundingDue, undefined, buyer);
      deliver(m, o.orderId, listing.providerId, Buffer.from(`r${n}`));
      settle(m, o.orderId, buyer);
    }
  };
  const anchors = [];
  for (const k of [3, 1, 5, 2]) {
    round(k);
    l.advanceHeight(l.height + 1);
    anchors.push(m.anchorSettlements(l)!);
  }
  const all = m.exportSnapshot().settlement.receipts;
  assert.equal(all.length, 11);
  assert.equal(anchorChainProblem(l.settlementAnchors), undefined);

  // Each anchor commits exactly its slice, in order; no receipt twice.
  let offset = 0;
  const seen = new Set<string>();
  const sizes: number[] = [];
  for (const a of anchors) {
    const slice = all.slice(offset, offset + a.count);
    assert.deepEqual(a.settlementIds, slice.map((r) => r.settlementId));
    assert.equal(a.batchRoot, settlementBatch(slice).root);
    for (const id of a.settlementIds) { assert.ok(!seen.has(id)); seen.add(id); }
    offset += a.count;
    sizes.push(offset);
  }
  assert.equal(offset, all.length);

  // Per-asset totals across anchors equal the totals over all receipts.
  const whole = settlementBatch(all).totals;
  for (const asset of Object.keys(whole)) {
    const sum = (f: "gross" | "fees" | "providerNet") => anchors.reduce((s, a) => s + BigInt(a.totals[asset]?.[f] ?? "0"), 0n);
    assert.equal(sum("gross"), whole[asset]!.gross, asset);
    assert.equal(sum("fees"), whole[asset]!.fees, asset);
    assert.equal(sum("providerNet"), whole[asset]!.providerNet, asset);
  }

  // Cumulative log: every earlier log size is a prefix of every later one.
  for (let i = 0; i < sizes.length; i++) {
    for (let j = i; j < sizes.length; j++) {
      const first = receiptLogRoot(all.slice(0, sizes[i]));
      const second = receiptLogRoot(all.slice(0, sizes[j]));
      const proof = receiptLogConsistencyProof(all.slice(0, sizes[j]), sizes[i]!);
      assert.ok(verifyReceiptLogConsistency(sizes[i]!, sizes[j]!, first, second, proof), `${sizes[i]} -> ${sizes[j]}`);
    }
  }
  // A rewritten history (two early receipts swapped) is not consistent with the earlier log.
  const rewritten = [all[1]!, all[0]!, ...all.slice(2)];
  const firstRoot = receiptLogRoot(all.slice(0, sizes[0]));
  const forged = receiptLogRoot(rewritten);
  assert.equal(verifyReceiptLogConsistency(sizes[0]!, all.length, firstRoot, forged, receiptLogConsistencyProof(rewritten, sizes[0]!)), false);
  // A dropped receipt is caught too.
  const dropped = all.filter((_r, i) => i !== 1);
  assert.equal(verifyReceiptLogConsistency(sizes[0]!, dropped.length, firstRoot, receiptLogRoot(dropped), receiptLogConsistencyProof(dropped, sizes[0]!)), false);
  // Nothing left to anchor.
  assert.equal(m.anchorSettlements(l), undefined);
});
