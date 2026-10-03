/**
 * v0.5.0 (ADR 0002 rule 6, docs/EVIDENCE.md): evidence certifies only that a
 * source published some data at a height, signed by k of n attesters, so the
 * value it can move is capped per contract and per attester set.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "./marketplace.ts";
import { EvidenceCaps } from "./evidence.ts";
import { act, cancelAsBuyer, deliver, enrollIdentity, fund, publishAs, reserveAs, settle } from "./testkit.ts";
import { listingTerms } from "./identity.ts";

const SET = { attesterSetId: "space-weather-2of3", threshold: 2, size: 3, valueCaps: { EUR: 1_000n } };
const base = { providerId: "prov", description: "comms with force-majeure evidence", category: "API" as const, asset: "EUR", unitPrice: 100n, capacity: 100n };

function setup() {
  const m = new DigitalServicesMarketplace({ evidence: { attesterSets: [SET] } });
  const listing = publishAs(m, { ...base, title: "Relay link", evidencePolicy: { attesterSetId: SET.attesterSetId, maxValuePerContract: 300n } });
  return { m, listing };
}

test("evidence caps: parameters are validated (k of n, positive per-asset caps, known sets)", () => {
  assert.throws(() => new EvidenceCaps({ attesterSets: [{ ...SET, threshold: 4 }] }), /EVIDENCE_ATTESTER_SET_INVALID/);
  assert.throws(() => new EvidenceCaps({ attesterSets: [{ ...SET, threshold: 0 }] }), /EVIDENCE_ATTESTER_SET_INVALID/);
  assert.throws(() => new EvidenceCaps({ attesterSets: [SET, SET] }), /EVIDENCE_ATTESTER_SET_INVALID/);
  assert.throws(() => new EvidenceCaps({ attesterSets: [{ ...SET, valueCaps: { EUR: 0n } }] }), /EVIDENCE_ATTESTER_SET_INVALID/);
  assert.throws(() => new EvidenceCaps({ attesterSets: [{ ...SET, valueCaps: { EUR: 5 as unknown as bigint } }] }), /EVIDENCE_ATTESTER_SET_INVALID/);
  const caps = new EvidenceCaps({ attesterSets: [SET] });
  assert.deepEqual(caps.attesterSet(SET.attesterSetId), SET);
  assert.throws(() => caps.attesterSet("other"), /EVIDENCE_ATTESTER_SET_UNKNOWN/);
  assert.throws(() => caps.checkSettlement({ attesterSetId: SET.attesterSetId, maxValuePerContract: 10n }, 11n), /EVIDENCE_CONTRACT_CAP_EXCEEDED/);
  caps.checkSettlement({ attesterSetId: SET.attesterSetId, maxValuePerContract: 10n }, 10n);
});

test("evidence caps: a listing binds to a known set with a per-contract cap within the set cap", () => {
  const plain = new DigitalServicesMarketplace(); // default: no attester sets
  assert.throws(() => publishAs(plain, { ...base, title: "A", evidencePolicy: { attesterSetId: SET.attesterSetId, maxValuePerContract: 1n } }), /EVIDENCE_ATTESTER_SET_UNKNOWN/);
  const { m, listing } = setup();
  assert.deepEqual(listing.evidencePolicy, { attesterSetId: SET.attesterSetId, maxValuePerContract: 300n });
  assert.throws(() => publishAs(m, { ...base, title: "B", evidencePolicy: { attesterSetId: SET.attesterSetId, maxValuePerContract: 1_001n } }), /EVIDENCE_POLICY_INVALID/);
  assert.throws(() => publishAs(m, { ...base, title: "C", evidencePolicy: { attesterSetId: SET.attesterSetId, maxValuePerContract: 0n } }), /EVIDENCE_POLICY_INVALID/);
  assert.throws(() => publishAs(m, { ...base, asset: "USD", title: "D", evidencePolicy: { attesterSetId: SET.attesterSetId, maxValuePerContract: 10n } }), /EVIDENCE_ATTESTER_SET_CAP_UNDEFINED/);
  // The evidence terms are signed listing terms.
  enrollIdentity(m, "prov");
  const input = { ...base, title: "Relay link two", evidencePolicy: { attesterSetId: SET.attesterSetId, maxValuePerContract: 300n } };
  assert.throws(() => m.publishListing({ ...input, evidencePolicy: { ...input.evidencePolicy, maxValuePerContract: 200n } }, act(m, "prov", "publish", "", listingTerms(input))), /ACTOR_SIGNATURE_INVALID/);
  // Copies cannot change the stored terms.
  const copy = m.getListing(listing.listingId);
  copy.evidencePolicy!.maxValuePerContract = 10_000n;
  assert.equal(m.getListing(listing.listingId).evidencePolicy!.maxValuePerContract, 300n);
});

test("evidence caps: a lock above the per-contract cap is rejected before any value moves", () => {
  const { m, listing } = setup();
  enrollIdentity(m, "buyer", { asset: "EUR", amount: 10_000n });
  const before = { available: m.getListing(listing.listingId).available, balance: m.availableBalance("EUR", "buyer") };
  assert.throws(() => reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 4n }, { credit: 0n }), /EVIDENCE_CONTRACT_CAP_EXCEEDED/);
  assert.deepEqual({ available: m.getListing(listing.listingId).available, balance: m.availableBalance("EUR", "buyer") }, before);
  assert.equal(m.lockedDeposit("EUR", "buyer"), 0n);
  const o = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 3n }, { credit: 0n });
  assert.equal(o.evidenceLocked, 300n);
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 300n);
});

test("evidence caps: the open value of one attester set is capped across listings and released on close", () => {
  const { m, listing } = setup();
  const other = publishAs(m, { ...base, providerId: "prov2", title: "Second relay", evidencePolicy: { attesterSetId: SET.attesterSetId, maxValuePerContract: 300n } });
  const a = reserveAs(m, { listingId: listing.listingId, buyerId: "b1", quantity: 3n });
  const b = reserveAs(m, { listingId: other.listingId, buyerId: "b2", quantity: 3n });
  const c = reserveAs(m, { listingId: listing.listingId, buyerId: "b3", quantity: 3n });
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 900n);
  assert.throws(() => reserveAs(m, { listingId: other.listingId, buyerId: "b4", quantity: 2n }), /EVIDENCE_ATTESTER_SET_CAP_EXCEEDED/);
  assert.ok(reserveAs(m, { listingId: other.listingId, buyerId: "b4", quantity: 1n }));
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 1_000n);
  // Closing orders releases their value exactly once: cancel, settle.
  cancelAsBuyer(m, a.orderId, "b1");
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 700n);
  cancelAsBuyer(m, a.orderId, "b1"); // idempotent
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 700n);
  fund(m, b.orderId, b.fundingDue);
  deliver(m, b.orderId, "prov2", Buffer.from("link report"));
  settle(m, b.orderId, "b2");
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 400n);
  // Expiry by height releases too.
  m.advanceHeight(121);
  m.reapExpiredReservations();
  assert.equal(m.getListing(listing.listingId).available, 100n);
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 0n);
  assert.equal(c.status, "ACCEPTED");
  assert.equal(m.valueAccounting("EUR").conserved, true);
});
