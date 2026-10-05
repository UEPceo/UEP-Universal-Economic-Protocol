/**
 * v0.5.1 (ADR 0002 rule 6, docs/EVIDENCE.md): evidence certifies only that a
 * source published some data at a height, signed by k of n attesters, so the
 * value it can move is capped per contract and per attester set.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace, type ServiceOrder } from "./marketplace.ts";
import { DEFAULT_PROVIDER_CAP_BPS, EvidenceCaps } from "./evidence.ts";
import { Fr } from "../core/field.ts";
import { deriveSpendKey } from "../core/spend-key.ts";
import { isPrimeOrderEd25519Point, normalizeEd25519PublicKeyHex } from "../core/ed25519-point.ts";
import { act, cancelAsBuyer, deliver, enrollIdentity, fund, getOrder, publishAs, refundAs, reserveAs, settle } from "./testkit.ts";

const getStatus = (m: DigitalServicesMarketplace, orderId: string, actor: string) => getOrder(m, orderId, actor).status;
import { listingTerms } from "./identity.ts";

/** Deterministic, valid Ed25519 public keys (raw 64 hex); public data only. */
const keyOf = (i: number) => deriveSpendKey(new Fr(BigInt(i)), new Fr(9n)).publicKeyHex.slice(-64);
const KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(keyOf);
// providerCapBps 10000: these tests look at the set cap alone; the per-provider subcap has its own test.
const SET = { attesterSetId: "space-weather-2of3", sourceId: "https://example.org/space-weather/v1", attesterKeys: KEYS.slice(0, 3), threshold: 2, size: 3, valueCaps: { EUR: 1_000n }, providerCapBps: 10_000 };
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

test("evidence caps: an attester key belongs to one set only, whatever the sourceId says (no cap multiplication)", () => {
  const twin = { ...SET, attesterSetId: "space-weather-copy" };
  assert.throws(() => new EvidenceCaps({ attesterSets: [SET, twin] }), /EVIDENCE_ATTESTER_SET_DUPLICATE/);
  assert.throws(() => new EvidenceCaps({ attesterSets: [SET, { ...twin, attesterKeys: [KEYS[2]!, KEYS[3]!, KEYS[4]!] }] }), /EVIDENCE_ATTESTER_SET_DUPLICATE/);
  assert.throws(() => new EvidenceCaps({ attesterSets: [SET, { ...twin, attesterKeys: SET.attesterKeys.map((k) => k.toUpperCase()) }] }), /EVIDENCE_ATTESTER_SET_DUPLICATE/);
  assert.throws(() => new EvidenceCaps({ attesterSets: [SET, { ...twin, attesterKeys: SET.attesterKeys.map((k) => `302a300506032b6570032100${k}`) }] }), /EVIDENCE_ATTESTER_SET_DUPLICATE/);
  // Spelling the same source another way does not help: the keys decide.
  const variants = ["HTTPS://EXAMPLE.ORG/space-weather/v1", "https://example.org/space-weather/v1?", "https://example.org/space-weather/v1#a", "https://example.org:443/space-weather/v1", "https://example.org/space%2Dweather/v1", "https://example.org//space-weather/v1", "http://example.org/space-weather/v1", "noaa-kp", "https://example.org/other"];
  for (const sourceId of variants) assert.throws(() => new EvidenceCaps({ attesterSets: [SET, { ...twin, sourceId }] }), /EVIDENCE_ATTESTER_SET_DUPLICATE/, sourceId);
  // Disjoint attesters form a different set, also for the same source.
  const ok = new EvidenceCaps({ attesterSets: [SET, { ...twin, attesterSetId: "disjoint", attesterKeys: [KEYS[3]!, KEYS[4]!, KEYS[5]!] }] });
  assert.equal(ok.attesterSet("disjoint").sourceId, SET.sourceId);
});

test("evidence caps: attester keys are normalized and must be prime-order Ed25519 points", () => {
  for (const k of KEYS) assert.ok(isPrimeOrderEd25519Point(Buffer.from(k, "hex")));
  const bad = [
    "00".repeat(32), // all zero
    "01" + "00".repeat(31), // identity
    "ec" + "ff".repeat(30) + "7f", // order 2
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a", // order 8
    "ed" + "ff".repeat(30) + "7f", // y = p (non-canonical)
    "a1".repeat(32), // not on the curve
    "zz".repeat(32),
    KEYS[0]!.slice(2),
  ];
  for (const k of bad) {
    assert.equal(normalizeEd25519PublicKeyHex(k), undefined, k);
    assert.throws(() => new EvidenceCaps({ attesterSets: [{ ...SET, attesterKeys: [KEYS[0]!, KEYS[1]!, k] }] }), /EVIDENCE_ATTESTER_SET_INVALID: attesterKeys/, k);
  }
  // Uppercase and SPKI DER forms normalize to the raw lowercase key.
  const caps = new EvidenceCaps({ attesterSets: [{ ...SET, attesterKeys: [KEYS[0]!.toUpperCase(), `302a300506032b6570032100${KEYS[1]!}`, KEYS[2]!] }] });
  assert.deepEqual(caps.attesterSet(SET.attesterSetId).attesterKeys, KEYS.slice(0, 3));
  assert.throws(() => new EvidenceCaps({ attesterSets: [{ ...SET, attesterKeys: [KEYS[0]!, KEYS[0]!.toUpperCase(), KEYS[1]!] }] }), /EVIDENCE_ATTESTER_SET_INVALID: attesterKeys are distinct/);
});

test("evidence caps: one provider may hold at most its subcap (default 25%) of a set; a full cap closes the reservation without fault", () => {
  const set = { ...SET, providerCapBps: undefined };
  const m = new DigitalServicesMarketplace({ testOnlyLocalHeight: true, evidence: { attesterSets: [set] } });
  assert.equal(DEFAULT_PROVIDER_CAP_BPS, 2_500);
  assert.equal(m.evidenceCaps.providerCap(SET.attesterSetId, "EUR"), 250n);
  // A listing whose per-contract cap exceeds the provider subcap could never be funded: refused at publication.
  assert.throws(() => publishAs(m, { ...base, title: "Too big", evidencePolicy: { attesterSetId: SET.attesterSetId, maxValuePerContract: 300n } }), /EVIDENCE_POLICY_INVALID: maxValuePerContract exceeds the per-provider subcap/);
  const own = publishAs(m, { ...base, providerId: "sybil", title: "Own relay", evidencePolicy: { attesterSetId: SET.attesterSetId, maxValuePerContract: 200n } });
  const honest = publishAs(m, { ...base, providerId: "prov", title: "Honest relay", evidencePolicy: { attesterSetId: SET.attesterSetId, maxValuePerContract: 200n } });
  // An attacker funding orders on its own listing fills its subcap (250), not the set cap (1000).
  const first = reserveAs(m, { listingId: own.listingId, buyerId: "attacker", quantity: 2n }, { credit: 10_000n });
  fund(m, first.orderId, first.fundingDue);
  assert.throws(() => reserveAs(m, { listingId: own.listingId, buyerId: "attacker", quantity: 1n }), /EVIDENCE_PROVIDER_CAP_EXCEEDED/);
  assert.equal(m.evidenceCaps.providerOpenValue(SET.attesterSetId, "EUR", "sybil"), 200n);
  // Other providers of the set are not blocked. Two reservations fit the honest provider's subcap
  // at reserve() time (nothing funded yet); the second no longer fits once the first is funded.
  const h = reserveAs(m, { listingId: honest.listingId, buyerId: "buyer", quantity: 2n }, { credit: 10_000n });
  const late = reserveAs(m, { listingId: honest.listingId, buyerId: "late", quantity: 1n }, { credit: 10_000n });
  fund(m, h.orderId, h.fundingDue);
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 400n);
  const before = { balance: m.availableBalance("EUR", "late"), locked: m.lockedDeposit("EUR", "late") };
  assert.ok(before.locked > 0n);
  assert.throws(() => fund(m, late.orderId, late.fundingDue), /EVIDENCE_PROVIDER_CAP_EXCEEDED: funding refused/);
  assert.deepEqual({ balance: m.availableBalance("EUR", "late"), locked: m.lockedDeposit("EUR", "late") }, { balance: before.balance + before.locked, locked: 0n });
  assert.equal(getOrder(m, late.orderId, "late").closeReason, "EVIDENCE_CAP_FULL");
  assert.equal(m.getListing(honest.listingId).available, 98n); // the closed reservation's unit is back
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 400n);
  assert.equal(m.valueAccounting("EUR").conserved, true);
  // providerCapBps is validated.
  for (const bps of [0, 10_001, 1.5]) assert.throws(() => new EvidenceCaps({ attesterSets: [{ ...SET, providerCapBps: bps }] }), /providerCapBps/);
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
  // The fourth funding would exceed the cap: refused, and the reservation closes without
  // fault: the buyer gets the deposit back (no loss for a system reason).
  const before = { balance: m.availableBalance("EUR", "r3"), locked: m.lockedDeposit("EUR", "r3") };
  assert.throws(() => fund(m, reservations[3]!.orderId, reservations[3]!.fundingDue), /EVIDENCE_ATTESTER_SET_CAP_EXCEEDED: funding refused because the evidence cap is full; the reservation was closed without fault and the deposit returned/);
  assert.deepEqual({ balance: m.availableBalance("EUR", "r3"), locked: m.lockedDeposit("EUR", "r3") }, { balance: before.balance + before.locked, locked: 0n });
  const closed = getOrder(m, reservations[3]!.orderId, "r3");
  assert.deepEqual([closed.status, closed.closeReason, closed.depositOutcome], ["CANCELLED", "EVIDENCE_CAP_FULL", "REFUNDED"]);
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 900n);
  // A new reservation fails early while the funded value fills the cap.
  assert.throws(() => reserveAs(m, { listingId: listing.listingId, buyerId: "late", quantity: 2n }, { credit: 1_000n }), /EVIDENCE_ATTESTER_SET_CAP_EXCEEDED/);
  // Cancelling an unfunded reservation releases nothing (nothing was taken).
  cancelAsBuyer(m, reservations[9]!.orderId, "r9");
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 900n);
  // Closing a funded order frees its value once; then r3 can fund.
  deliver(m, reservations[0]!.orderId, "prov", Buffer.from("report"));
  settle(m, reservations[0]!.orderId, "r0");
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 600n);
  fund(m, reservations[4]!.orderId, reservations[4]!.fundingDue);
  assert.equal(m.evidenceCaps.openValue(SET.attesterSetId, "EUR"), 900n);
  assert.equal(m.valueAccounting("EUR").conserved, true);
});

test("evidence caps: the Marketplace exposes a read-only view (no lock / release)", () => {
  const { m } = setup();
  const view = m.evidenceCaps as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(view).sort(), ["attesterSet", "openValue", "providerCap", "providerOpenValue"]);
  // The caps instance itself is an ECMAScript private field: not reachable through the object.
  assert.equal((m as unknown as Record<string, unknown>).evidence, undefined);
  assert.ok(!Object.getOwnPropertyNames(m).some((k) => k.toLowerCase().includes("evidence") && k !== "evidenceCaps"));
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
  // No term can be added later (a listing published without evidence terms stays without them).
  const plain = publishAs(m, { ...base, title: "Plain relay" });
  const plainInternal = (m as unknown as { listings: Map<string, Record<string, unknown>> }).listings.get(plain.listingId)!;
  assert.throws(() => { plainInternal.evidencePolicy = { attesterSetId: SET.attesterSetId, maxValuePerContract: 1n }; }, TypeError);
  assert.equal(Object.isExtensible(plainInternal), false);
  // The windows of an order are fixed at reserve(): not writable, frozen.
  const o = reserveAs(m, { listingId: listing.listingId, buyerId: "w", quantity: 1n });
  const internalOrder = (m as unknown as { orders: Map<string, Record<string, unknown>> }).orders.get(o.orderId)!;
  assert.throws(() => { (internalOrder.windows as Record<string, number>).cancellationGrace = 1_000_000; }, TypeError);
  assert.throws(() => { internalOrder.windows = { ...(internalOrder.windows as object), cancellationGrace: 1_000_000 }; }, TypeError);
  assert.ok(Object.isFrozen(getOrder(m, o.orderId, "w").windows));
  assert.equal(m.getListing(listing.listingId).domainProfile, "EARTH");
  // Capacity accounting still works.
  reserveAs(m, { listingId: listing.listingId, buyerId: "b", quantity: 1n });
  assert.equal(m.getListing(listing.listingId).available, 98n); // "w" and "b" hold one unit each
});

test("category hooks are copied and frozen at attach: mutating the caller's object later changes nothing", () => {
  const m = new DigitalServicesMarketplace({ testOnlyLocalHeight: true });
  const hooks: { settlementGuard?: (o: ServiceOrder) => void } = {};
  m.attachCategoryService("API", hooks);
  const listing = publishAs(m, { ...base, title: "Hooked API" });
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n });
  fund(m, order.orderId, order.fundingDue);
  deliver(m, order.orderId, "prov", Buffer.from("payload"));
  // A guard added to the caller's object after attach is not consulted.
  hooks.settlementGuard = () => { throw new Error("GUARD_ADDED_LATER"); };
  assert.equal(settle(m, order.orderId, "buyer").orderId, order.orderId);
  assert.throws(() => m.attachCategoryService("DATA", { settlementGuard: "nope" as never }), /CATEGORY_HOOKS_INVALID/);
  assert.throws(() => m.attachCategoryService("STORAGE", null as never), /CATEGORY_HOOKS_INVALID/);
});
