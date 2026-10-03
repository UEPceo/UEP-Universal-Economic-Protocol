/**
 * v0.5.0 (ADR 0002 rule 6, docs/EVIDENCE.md): evidence certifies only that a
 * source published some data at a height, signed by k of n attesters, so the
 * value it can move is capped per contract and per attester set.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace, type ServiceOrder } from "./marketplace.ts";
import { EvidenceCaps } from "./evidence.ts";
import { act, cancelAsBuyer, deliver, enrollIdentity, fund, getOrder, publishAs, refundAs, reserveAs, settle } from "./testkit.ts";

const getStatus = (m: DigitalServicesMarketplace, orderId: string, actor: string) => getOrder(m, orderId, actor).status;
import { listingTerms } from "./identity.ts";

const KEYS = ["a1", "b2", "c3", "d4"].map((x) => x.repeat(32));
const SET = { attesterSetId: "space-weather-2of3", sourceId: "https://example.org/space-weather/v1", attesterKeys: KEYS.slice(0, 3), threshold: 2, size: 3, valueCaps: { EUR: 1_000n } };
const base = { providerId: "prov", description: "comms with force-majeure evidence", category: "API" as const, asset: "EUR", unitPrice: 100n, capacity: 100n };

function setup() {
  const m = new DigitalServicesMarketplace({ testOnlyLocalHeight: true, evidence: { attesterSets: [SET] } });
  const listing = publishAs(m, { ...base, title: "Relay link", evidencePolicy: { attesterSetId: SET.attesterSetId, maxValuePerContract: 300n } });
  return { m, listing };
}

test("evidence caps: parameters are validated (k of n, positive per-asset caps, known sets)", () => {
  assert.throws(() => new EvidenceCaps({ attesterSets: [{ ...SET, threshold: 4 }] }), /EVIDENCE_ATTESTER_SET_INVALID/);
  assert.throws(() => new EvidenceCaps({ attesterSets: [{ ...SET, threshold: 0 }] }), /EVIDENCE_ATTESTER_SET_INVALID/);
  assert.throws(() => new EvidenceCaps({ attesterSets: [SET, SET] }), /EVIDENCE_ATTESTER_SET_INVALID/);
  assert.throws(() => new EvidenceCaps({ attesterSets: [{ ...SET, valueCaps: { EUR: 0n } }] }), /EVIDENCE_ATTESTER_SET_INVALID/);
  assert.throws(() => new EvidenceCaps({ attesterSets: [{ ...SET, valueCaps: { EUR: 5 as unknown as bigint } }] }), /EVIDENCE_ATTESTER_SET_INVALID/);
  assert.throws(() => new EvidenceCaps({ attesterSets: [{ ...SET, sourceId: "" }] }), /EVIDENCE_ATTESTER_SET_INVALID: sourceId/);
  assert.throws(() => new EvidenceCaps({ attesterSets: [{ ...SET, attesterKeys: KEYS.slice(0, 2) }] }), /EVIDENCE_ATTESTER_SET_INVALID: attesterKeys/);
  assert.throws(() => new EvidenceCaps({ attesterSets: [{ ...SET, attesterKeys: [KEYS[0]!, KEYS[0]!, KEYS[1]!] }] }), /EVIDENCE_ATTESTER_SET_INVALID: attesterKeys/);
  assert.throws(() => new EvidenceCaps({ attesterSets: [{ ...SET, attesterKeys: [KEYS[0]!, KEYS[1]!, "zz"] }] }), /EVIDENCE_ATTESTER_SET_INVALID: attesterKeys/);
  const caps = new EvidenceCaps({ attesterSets: [SET] });
  assert.deepEqual(caps.attesterSet(SET.attesterSetId), SET);
  const copy = caps.attesterSet(SET.attesterSetId);
  copy.attesterKeys.push(KEYS[3]!);
  assert.equal(caps.attesterSet(SET.attesterSetId).attesterKeys.length, 3);
  assert.throws(() => caps.attesterSet("other"), /EVIDENCE_ATTESTER_SET_UNKNOWN/);
  assert.throws(() => caps.checkSettlement({ attesterSetId: SET.attesterSetId, maxValuePerContract: 10n }, 11n), /EVIDENCE_CONTRACT_CAP_EXCEEDED/);
  caps.checkSettlement({ attesterSetId: SET.attesterSetId, maxValuePerContract: 10n }, 10n);
});

test("evidence caps: a listing binds to a known set with a per-contract cap within the set cap", () => {
  const plain = new DigitalServicesMarketplace({ testOnlyLocalHeight: true }); // default: no attester sets
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
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 0n); // not funded yet
  const held = fund(m, o.orderId, o.fundingDue);
  assert.equal(held.evidenceLocked, 300n);
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 300n);
});

test("evidence caps: the funded value of one attester set is capped across listings and released on close", () => {
  const { m, listing } = setup();
  const other = publishAs(m, { ...base, providerId: "prov2", title: "Second relay", evidencePolicy: { attesterSetId: SET.attesterSetId, maxValuePerContract: 300n } });
  const funded = (listingId: string, buyerId: string, quantity: bigint) => {
    const o = reserveAs(m, { listingId, buyerId, quantity });
    return fund(m, o.orderId, o.fundingDue);
  };
  const a = funded(listing.listingId, "b1", 3n);
  const b = funded(other.listingId, "b2", 3n);
  const c = funded(listing.listingId, "b3", 3n);
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 900n);
  assert.throws(() => reserveAs(m, { listingId: other.listingId, buyerId: "b4", quantity: 2n }), /EVIDENCE_ATTESTER_SET_CAP_EXCEEDED/);
  assert.ok(funded(other.listingId, "b4", 1n));
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 1_000n);
  // Closing orders releases their value exactly once: refund by the provider, settle.
  deliver(m, a.orderId, "prov", Buffer.from("partial report"));
  refundAs(m, "prov", a.orderId);
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 700n);
  refundAs(m, "prov", a.orderId); // idempotent: released once
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 700n);
  deliver(m, b.orderId, "prov2", Buffer.from("link report"));
  settle(m, b.orderId, "b2");
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 400n);
  // A delivered order keeps its value counted until it closes.
  deliver(m, c.orderId, "prov", Buffer.from("late report"));
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 400n);
  assert.equal(m.valueAccounting("EUR").conserved, true);
});

test("evidence caps: the same source with a common attester under another set id is rejected (no cap multiplication)", () => {
  const twin = { ...SET, attesterSetId: "space-weather-copy" };
  assert.throws(() => new EvidenceCaps({ attesterSets: [SET, twin] }), /EVIDENCE_ATTESTER_SET_DUPLICATE/);
  assert.throws(() => new EvidenceCaps({ attesterSets: [SET, { ...twin, attesterKeys: [KEYS[2]!, KEYS[3]!, "e5".repeat(32)] }] }), /EVIDENCE_ATTESTER_SET_DUPLICATE/);
  assert.throws(() => new EvidenceCaps({ attesterSets: [SET, { ...twin, attesterKeys: SET.attesterKeys.map((k) => k.toUpperCase()) }] }), /EVIDENCE_ATTESTER_SET_DUPLICATE/);
  // Another source, or the same source with disjoint attesters, is a different set.
  const ok = new EvidenceCaps({ attesterSets: [SET, { ...twin, sourceId: "https://example.org/other" }, { ...twin, attesterSetId: "disjoint", attesterKeys: [KEYS[3]!, "e5".repeat(32), "f6".repeat(32)] }] });
  assert.equal(ok.attesterSet("disjoint").sourceId, SET.sourceId);
});

test("evidence caps: only funded value counts against the set cap; unfunded reservations cannot fill it", () => {
  const { m, listing } = setup();
  // Ten unfunded reservations of 300 each (3,000 > cap 1,000) are all accepted and take nothing.
  const reservations: ServiceOrder[] = [];
  for (let i = 0; i < 10; i++) reservations.push(reserveAs(m, { listingId: listing.listingId, buyerId: `r${i}`, quantity: 3n }, { credit: 1_000n }));
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 0n);
  for (const r of reservations) assert.equal(r.evidenceLocked, undefined);
  // An honest buyer still funds; the funded value is counted.
  fund(m, reservations[0]!.orderId, reservations[0]!.fundingDue);
  fund(m, reservations[1]!.orderId, reservations[1]!.fundingDue);
  fund(m, reservations[2]!.orderId, reservations[2]!.fundingDue);
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 900n);
  // The fourth funding would exceed the cap: refused before any value moves.
  const before = { balance: m.availableBalance("EUR", "r3"), locked: m.lockedDeposit("EUR", "r3") };
  assert.throws(() => fund(m, reservations[3]!.orderId, reservations[3]!.fundingDue), /EVIDENCE_ATTESTER_SET_CAP_EXCEEDED/);
  assert.deepEqual({ balance: m.availableBalance("EUR", "r3"), locked: m.lockedDeposit("EUR", "r3") }, before);
  assert.equal(getStatus(m, reservations[3]!.orderId, "r3"), "ACCEPTED");
  // A new reservation fails early while the funded value fills the cap.
  assert.throws(() => reserveAs(m, { listingId: listing.listingId, buyerId: "late", quantity: 2n }, { credit: 1_000n }), /EVIDENCE_ATTESTER_SET_CAP_EXCEEDED/);
  // Cancelling an unfunded reservation releases nothing (nothing was taken).
  cancelAsBuyer(m, reservations[9]!.orderId, "r9");
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 900n);
  // Closing a funded order frees its value once; then r3 can fund.
  deliver(m, reservations[0]!.orderId, "prov", Buffer.from("report"));
  settle(m, reservations[0]!.orderId, "r0");
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 600n);
  fund(m, reservations[3]!.orderId, reservations[3]!.fundingDue);
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 900n);
  assert.equal(m.valueAccounting("EUR").conserved, true);
});

test("evidence caps: the Marketplace exposes a read-only view (no lock / release)", () => {
  const { m } = setup();
  const view = m.evidenceCaps as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(view).sort(), ["attesterSet", "openValue"]);
  assert.equal(view.release, undefined);
  assert.equal(view.lock, undefined);
  assert.ok(Object.isFrozen(view));
});

test("listing terms, domain profile and windows are frozen inside the Marketplace", () => {
  const { m, listing } = setup();
  const internal = (m as unknown as { listings: Map<string, Record<string, unknown>> }).listings.get(listing.listingId)!;
  for (const key of ["domainProfile", "unitPrice", "asset", "providerId", "windows", "evidencePolicy", "delayHeights"]) {
    assert.throws(() => { "use strict"; internal[key] = "changed"; }, TypeError, key);
  }
  assert.throws(() => { (internal.windows as Record<string, number>).reservationTtl = 1; }, TypeError);
  assert.equal(m.getListing(listing.listingId).domainProfile, "EARTH");
  // Capacity accounting still works.
  reserveAs(m, { listingId: listing.listingId, buyerId: "b", quantity: 1n });
  assert.equal(m.getListing(listing.listingId).available, 99n);
});
