/**
 * v0.4.4: marketplace disputes with defined, value-conserving outcomes
 * (UEP-B07/A07), order access limited to parties / admin (UEP-B08/A09),
 * signed provider / admin / arbiter identities (UEP-B12), and the 1-unit
 * Marketplace fee floor (UEP-A16).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "./marketplace.ts";
import { MarketplacePaymaster } from "./paymaster.ts";
import { calculateMarketplaceFee, MARKETPLACE_FEE_BPS, MIN_MARKETPLACE_FEE } from "./economy.ts";
import { createMarketplaceIdentity, listingTerms, signAction } from "./identity.ts";
import { act, cancel, createTestAuthority, deliver, disputeAs, enrollIdentity, fund, getOrder, listAuth, listOrders, publishAs, readAuth, refundAs, reserveAs, resolveAs, review, settle } from "./testkit.ts";

const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const ADMIN = createTestAuthority("ops-admin");
const ARBITER = createTestAuthority("arbiter-1");

function setup(config: ConstructorParameters<typeof DigitalServicesMarketplace>[0] = {}) {
  let now = T0;
  const paymaster = new MarketplacePaymaster({ now: () => now });
  paymaster.fundReserve("EUR", 1_000n);
  const m = new DigitalServicesMarketplace({ now: () => now, paymaster, adminIdentity: "ops-admin", adminPublicKey: ADMIN.publicKeyHex, settlementArbiterId: "arbiter-1", settlementArbiterPublicKey: ARBITER.publicKeyHex, ...config });
  const listing = publishAs(m, { providerId: "prov", title: "GPU", description: "compute", category: "COMPUTE", asset: "EUR", unitPrice: 100n, capacity: 50n });
  return { m, paymaster, listing, advance(ms: number) { now += ms; } };
}

/** Reserve 1 unit (gross 100) with 5 gas, fund, deliver. */
function delivered(s: ReturnType<typeof setup>, buyerId = "buyer") {
  const q = s.m.checkoutQuote(s.listing.listingId, 1n, 5n);
  const o = reserveAs(s.m, { listingId: s.listing.listingId, buyerId, quantity: 1n, gasQuote: q.gasQuote }, { credit: 1_000n });
  fund(s.m, o.orderId, o.fundingDue);
  deliver(s.m, o.orderId, "prov", Buffer.from("result"));
  return o;
}

function conserved(m: DigitalServicesMarketplace) {
  const a = m.valueAccounting("EUR");
  assert.equal(a.conserved, true, JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  assert.equal(a.held, 0n);
  return a;
}

// ---------------------------------------------------------------- dispute outcomes

test("dispute: arbiter RELEASE pays the provider like a normal settlement", () => {
  const s = setup();
  const o = delivered(s);
  const d = disputeAs(s.m, "buyer", o.orderId, "result looks incomplete");
  assert.equal(d.status, "DISPUTED");
  assert.match(d.disputeReasonHash!, /^[0-9a-f]{64}$/);
  const r = resolveAs(s.m, "arbiter-1", o.orderId, { outcome: "RELEASE" });
  assert.equal(r.outcome, "RELEASE");
  assert.equal(r.marketplaceFee, 3n);
  assert.equal(r.providerPayout, 97n);
  assert.equal(r.gasFee, 5n);
  assert.equal(r.buyerRefund, 0n);
  assert.equal(s.m.availableBalance("EUR", "buyer"), 1_000n - 105n);
  assert.equal(getOrder(s.m, o.orderId, "buyer").disputeOutcome, "RELEASE");
  conserved(s.m);
});

test("dispute: arbiter REFUND_BUYER returns gross + gas, releases the paymaster and charges no fee", () => {
  const s = setup();
  const o = delivered(s);
  assert.equal(s.paymaster.reserveOf("EUR"), 995n);
  disputeAs(s.m, "buyer", o.orderId, "nothing delivered");
  const r = resolveAs(s.m, "arbiter-1", o.orderId, { outcome: "REFUND_BUYER" });
  assert.equal(r.outcome, "REFUND_BUYER");
  assert.equal(r.marketplaceFee, 0n);
  assert.equal(r.providerPayout, 0n);
  assert.equal(r.buyerRefund, 105n);
  assert.equal(s.m.availableBalance("EUR", "buyer"), 1_000n);
  assert.equal(s.m.availableBalance("EUR", "prov"), 0n);
  assert.equal(s.m.treasury.totalOf("EUR"), 0n);
  assert.equal(s.paymaster.reserveOf("EUR"), 1_000n);
  assert.equal(getOrder(s.m, o.orderId, "buyer").status, "REFUNDED");
  // Closed orders cannot be reviewed, re-disputed or re-resolved differently.
  assert.deepEqual(resolveAs(s.m, "arbiter-1", o.orderId, { outcome: "RELEASE" }), r);
  assert.throws(() => review(s.m, { orderId: o.orderId, buyerId: "buyer", rating: 1 }), /REVIEW_REQUIRES_SETTLEMENT/);
  conserved(s.m);
});

test("dispute: arbiter SPLIT pays x minus the fee on x, refunds gross - x, captures gas", () => {
  const s = setup();
  const o = delivered(s);
  disputeAs(s.m, "buyer", o.orderId, "partial delivery");
  assert.throws(() => resolveAs(s.m, "arbiter-1", o.orderId, { outcome: "SPLIT", providerAmount: 101n }), /DISPUTE_SPLIT_INVALID/);
  assert.throws(() => resolveAs(s.m, "arbiter-1", o.orderId, { outcome: "SPLIT", providerAmount: -1n }), /DISPUTE_SPLIT_INVALID/);
  const r = resolveAs(s.m, "arbiter-1", o.orderId, { outcome: "SPLIT", providerAmount: 60n });
  assert.equal(r.outcome, "SPLIT");
  assert.equal(r.marketplaceFee, 1n); // 3% of 60 = 1.8 -> 1
  assert.equal(r.providerPayout, 59n);
  assert.equal(r.gasFee, 5n);
  assert.equal(r.buyerRefund, 40n);
  assert.equal(r.marketplaceFee + r.providerPayout + r.gasFee! + r.buyerRefund!, 105n);
  assert.equal(s.m.availableBalance("EUR", "buyer"), 1_000n - 105n + 40n);
  assert.equal(s.m.availableBalance("EUR", "prov"), 59n);
  conserved(s.m);
});

test("dispute: SPLIT with x = 0 is a refund and x = gross is a release", () => {
  const s = setup();
  const a = delivered(s, "b1");
  const b = delivered(s, "b2");
  disputeAs(s.m, "b1", a.orderId, "r");
  disputeAs(s.m, "b2", b.orderId, "r");
  assert.equal(resolveAs(s.m, "arbiter-1", a.orderId, { outcome: "SPLIT", providerAmount: 0n }).outcome, "REFUND_BUYER");
  assert.equal(resolveAs(s.m, "arbiter-1", b.orderId, { outcome: "SPLIT", providerAmount: 100n }).outcome, "RELEASE");
  conserved(s.m);
});

test("dispute: the buyer can withdraw by settling; the provider can concede with a refund", () => {
  const s = setup();
  const a = delivered(s, "b1");
  disputeAs(s.m, "b1", a.orderId, "r");
  assert.throws(() => settle(s.m, a.orderId, "prov"), /DISPUTE_PENDING/);
  const released = settle(s.m, a.orderId, "b1");
  assert.equal(released.outcome, "RELEASE");
  assert.equal(getOrder(s.m, a.orderId, "b1").disputeOutcome, "WITHDRAWN");
  const b = delivered(s, "b2");
  disputeAs(s.m, "b2", b.orderId, "r");
  assert.throws(() => refundAs(s.m, "b2", b.orderId), /REFUND_NOT_AUTHORIZED/);
  const refunded = refundAs(s.m, "prov", b.orderId);
  assert.equal(refunded.buyerRefund, 105n);
  assert.equal(getOrder(s.m, b.orderId, "b2").disputeOutcome, "PROVIDER_REFUND");
  conserved(s.m);
});

test("dispute: an unresolved dispute closes with the configured timeout outcome (default refund)", () => {
  const s = setup();
  const o = delivered(s);
  disputeAs(s.m, "buyer", o.orderId, "r");
  s.advance(7 * DAY - 1);
  assert.throws(() => settle(s.m, o.orderId, "prov"), /DISPUTE_PENDING/);
  s.advance(1);
  const r = settle(s.m, o.orderId, "prov");
  assert.equal(r.outcome, "REFUND_BUYER");
  assert.equal(getOrder(s.m, o.orderId, "buyer").disputeOutcome, "TIMEOUT_REFUND");
  conserved(s.m);

  const s2 = setup({ disputeTimeoutOutcome: "RELEASE", disputeResolutionWindowMs: DAY });
  const o2 = delivered(s2);
  disputeAs(s2.m, "buyer", o2.orderId, "r");
  s2.advance(DAY);
  assert.equal(settle(s2.m, o2.orderId, "buyer").outcome, "RELEASE");
  assert.equal(getOrder(s2.m, o2.orderId, "buyer").disputeOutcome, "TIMEOUT_RELEASE");
  conserved(s2.m);
  assert.throws(() => new DigitalServicesMarketplace({ disputeTimeoutOutcome: "SPLIT" as never }), /INVALID_DISPUTE_CONFIG/);
});

test("dispute: only the buyer opens, only the arbiter resolves, only within the window", () => {
  const s = setup();
  const o = delivered(s);
  const other = delivered(s, "other-buyer");
  assert.throws(() => disputeAs(s.m, "prov", o.orderId, "r"), /DISPUTE_NOT_AUTHORIZED/);
  assert.throws(() => disputeAs(s.m, "other-buyer", o.orderId, "r"), /DISPUTE_NOT_AUTHORIZED/);
  assert.throws(() => s.m.openDispute(o.orderId, act(s.m, "buyer", "dispute", o.orderId, { reasonHash: "00" }), "r"), /ACTOR_SIGNATURE_INVALID/);
  disputeAs(s.m, "buyer", o.orderId, "r");
  for (const actor of ["buyer", "prov", "ops-admin", "other-buyer"]) {
    assert.throws(() => resolveAs(s.m, actor, o.orderId, { outcome: "REFUND_BUYER" }), /DISPUTE_RESOLUTION_NOT_AUTHORIZED/);
  }
  // The arbiter's signature binds the outcome: a REFUND signature cannot be replayed as a SPLIT.
  const refundSig = act(s.m, "arbiter-1", "resolve", o.orderId, { outcome: "REFUND_BUYER", providerAmount: null });
  assert.throws(() => s.m.resolveDispute(o.orderId, refundSig, { outcome: "SPLIT", providerAmount: 99n }), /ACTOR_SIGNATURE_INVALID/);
  // An impostor key under the arbiter id is rejected.
  const impostor = createMarketplaceIdentity("arbiter-1");
  assert.throws(() => s.m.resolveDispute(o.orderId, act(s.m, "arbiter-1", "resolve", o.orderId, { outcome: "RELEASE", providerAmount: null }, impostor), { outcome: "RELEASE" }), /ACTOR_SIGNATURE_INVALID/);
  assert.equal(getOrder(s.m, o.orderId, "arbiter-1").status, "DISPUTED"); // the arbiter can read disputed orders
  // The arbiter cannot resolve an order that is not disputed.
  assert.throws(() => resolveAs(s.m, "arbiter-1", other.orderId, { outcome: "REFUND_BUYER" }), /DISPUTE_NOT_OPEN/);
  // The window closes 24 h after delivery.
  s.advance(DAY);
  assert.throws(() => disputeAs(s.m, "other-buyer", other.orderId, "late"), /DISPUTE_WINDOW_CLOSED/);
  // Disputes need an arbiter.
  const noArbiter = new DigitalServicesMarketplace({ now: () => T0 });
  const l = publishAs(noArbiter, { providerId: "p", title: "x", description: "x", category: "API", asset: "EUR", unitPrice: 10n, capacity: 1n });
  const o3 = reserveAs(noArbiter, { listingId: l.listingId, buyerId: "b", quantity: 1n });
  fund(noArbiter, o3.orderId, o3.fundingDue);
  deliver(noArbiter, o3.orderId, "p", Buffer.from("x"));
  assert.throws(() => disputeAs(noArbiter, "b", o3.orderId, "r"), /DISPUTE_ARBITER_NOT_CONFIGURED/);
  // Disputes only apply to delivered orders.
  const held = reserveAs(s.m, { listingId: s.listing.listingId, buyerId: "b4", quantity: 1n });
  assert.throws(() => disputeAs(s.m, "b4", held.orderId, "r"), /ORDER_NOT_DISPUTABLE/);
  conservedAllowHeld(s.m);
});

function conservedAllowHeld(m: DigitalServicesMarketplace) {
  assert.equal(m.valueAccounting("EUR").conserved, true);
}

test("settle: the provider claims only after the dispute window; the admin never settles", () => {
  const s = setup();
  const o = delivered(s);
  assert.throws(() => settle(s.m, o.orderId, "prov"), /SETTLEMENT_DISPUTE_WINDOW_ACTIVE/);
  assert.throws(() => settle(s.m, o.orderId, "ops-admin"), /SETTLEMENT_NOT_AUTHORIZED/);
  assert.throws(() => settle(s.m, o.orderId, "stranger"), /SETTLEMENT_NOT_AUTHORIZED/);
  assert.throws(() => s.m.settle(o.orderId, "buyer" as never), /ACTOR_SIGNATURE_REQUIRED/);
  s.advance(DAY);
  assert.equal(settle(s.m, o.orderId, "prov").providerPayout, 97n);
  conserved(s.m);
});

// ---------------------------------------------------------------- order access (IDOR)

test("access: reading an order requires a fresh party / admin signature", () => {
  const s = setup();
  const o = reserveAs(s.m, { listingId: s.listing.listingId, buyerId: "buyer", quantity: 1n });
  enrollIdentity(s.m, "stranger");
  assert.throws(() => getOrder(s.m, o.orderId, "stranger"), /ORDER_ACCESS_FORBIDDEN/);
  assert.throws(() => s.m.getOrder(o.orderId, "buyer" as never), /ACTOR_AUTH_ISSUED_AT_REQUIRED/);
  assert.throws(() => s.m.getOrder(o.orderId, undefined), /ACTOR_AUTH_ISSUED_AT_REQUIRED/);
  // Someone else's key under the buyer's id.
  const forged = signAction({ marketplaceId: s.m.marketplaceId, action: "read", actorId: "buyer", target: o.orderId, details: { issuedAt: s.m.clock() } }, createMarketplaceIdentity("x").privateKey);
  assert.throws(() => s.m.getOrder(o.orderId, forged), /ACTOR_SIGNATURE_INVALID/);
  // A read token for one order does not open another.
  const o2 = reserveAs(s.m, { listingId: s.listing.listingId, buyerId: "buyer", quantity: 1n });
  assert.throws(() => s.m.getOrder(o2.orderId, readAuth(s.m, "buyer", o.orderId)), /ACTOR_SIGNATURE_INVALID/);
  // Read tokens expire.
  const token = readAuth(s.m, "buyer", o.orderId);
  assert.equal(s.m.getOrder(o.orderId, token).orderId, o.orderId);
  s.advance(5 * 60_000 + 1);
  assert.throws(() => s.m.getOrder(o.orderId, token), /ACTOR_AUTH_EXPIRED/);
  // Parties and the admin can read; the arbiter only once a dispute exists.
  assert.equal(getOrder(s.m, o.orderId, "prov").orderId, o.orderId);
  assert.equal(getOrder(s.m, o.orderId, "ops-admin").orderId, o.orderId);
  assert.throws(() => getOrder(s.m, o.orderId, "arbiter-1"), /ORDER_ACCESS_FORBIDDEN/);
});

test("access: listing orders is scoped to the signer; only the admin sees all", () => {
  const s = setup();
  reserveAs(s.m, { listingId: s.listing.listingId, buyerId: "b1", quantity: 1n });
  reserveAs(s.m, { listingId: s.listing.listingId, buyerId: "b2", quantity: 1n });
  const l2 = publishAs(s.m, { providerId: "prov-2", title: "Storage", description: "s", category: "STORAGE", asset: "EUR", unitPrice: 5n, capacity: 5n });
  reserveAs(s.m, { listingId: l2.listingId, buyerId: "b1", quantity: 1n });
  assert.throws(() => s.m.listOrders(undefined), /ACTOR_AUTH_ISSUED_AT_REQUIRED/);
  assert.throws(() => s.m.listOrdersPage(0, 50), /ACTOR_AUTH_ISSUED_AT_REQUIRED/);
  assert.throws(() => s.m.listOrdersPage(0, 50, { actorId: "marketplace-admin", signature: "00", issuedAt: s.m.clock() }), /LEGACY_ADMIN_ID_RESERVED/);
  assert.equal(listOrders(s.m, "b1").length, 2);
  assert.equal(listOrders(s.m, "b2").length, 1);
  assert.equal(listOrders(s.m, "prov").length, 2);
  assert.equal(listOrders(s.m, "prov-2").length, 1);
  assert.equal(listOrders(s.m, "stranger").length, 0);
  assert.equal(listOrders(s.m, "ops-admin").length, 3);
  assert.equal(s.m.listOrdersPage(0, 1, listAuth(s.m, "b1")).length, 1);
  assert.equal(s.m.orderCount(), 3);
});

test("access: modifying an order requires the right party", () => {
  const s = setup();
  const o = reserveAs(s.m, { listingId: s.listing.listingId, buyerId: "buyer", quantity: 1n });
  for (const actor of ["prov", "stranger", "ops-admin"]) assert.throws(() => fund(s.m, o.orderId, o.fundingDue, undefined, actor), /ORDER_ACCESS_FORBIDDEN/);
  // A fund signature binds the amount.
  assert.throws(() => s.m.fundOrder(o.orderId, o.fundingDue, act(s.m, "buyer", "fund", o.orderId, { amount: 1n })), /ACTOR_SIGNATURE_INVALID/);
  // An idempotency key does not leak or modify someone else's order.
  fund(s.m, o.orderId, o.fundingDue, "k1");
  assert.throws(() => fund(s.m, o.orderId, o.fundingDue, "k1", "stranger"), /ORDER_ACCESS_FORBIDDEN/);
  assert.throws(() => cancel(s.m, o.orderId, "stranger"), /ORDER_ACCESS_FORBIDDEN/);
  assert.throws(() => deliver(s.m, o.orderId, "buyer", Buffer.from("x")), /PROVIDER_NOT_AUTHORIZED/);
  // A delivery signature binds the content hash.
  assert.throws(() => s.m.deliver(o.orderId, act(s.m, "prov", "deliver", o.orderId, { deliveryHash: "00".repeat(32) }), Buffer.from("x")), /ACTOR_SIGNATURE_INVALID/);
  deliver(s.m, o.orderId, "prov", Buffer.from("x"));
  settle(s.m, o.orderId, "buyer");
  assert.throws(() => review(s.m, { orderId: o.orderId, buyerId: "prov", rating: 5 }), /REVIEW_NOT_AUTHORIZED/);
  assert.ok(review(s.m, { orderId: o.orderId, buyerId: "buyer", rating: 4 }));
  conserved(s.m);
});

// ---------------------------------------------------------------- provider / admin / arbiter identities

test("identities: providers must be registered and sign their listing terms", () => {
  const m = new DigitalServicesMarketplace({ now: () => T0 });
  const input = { providerId: "p", title: "Svc", description: "d", category: "API" as const, asset: "EUR", unitPrice: 10n, capacity: 1n };
  assert.throws(() => m.publishListing(input), /IDENTITY_NOT_REGISTERED/);
  enrollIdentity(m, "p");
  assert.throws(() => m.publishListing(input), /ACTOR_SIGNATURE_REQUIRED/);
  assert.throws(() => m.publishListing(input, act(m, "mallory", "publish", "", listingTerms(input))), /PROVIDER_NOT_AUTHORIZED/);
  assert.throws(() => m.publishListing({ ...input, unitPrice: 1n }, act(m, "p", "publish", "", listingTerms(input))), /ACTOR_SIGNATURE_INVALID/);
  assert.equal(m.publishListing(input, act(m, "p", "publish", "", listingTerms(input))).providerId, "p");
  for (const reserved of ["marketplace-admin", "marketplace-system"]) {
    assert.throws(() => m.registerIdentity(reserved, createMarketplaceIdentity(reserved).publicKeyHex), /RESERVED_IDENTITY/);
    assert.throws(() => publishAs(m, { ...input, providerId: reserved }), /RESERVED_IDENTITY/);
  }
});

test("identities: the admin and the arbiter authenticate with configured keys (fail closed)", () => {
  // No admin key configured: no admin action is possible.
  const noKey = new DigitalServicesMarketplace({ now: () => T0, adminIdentity: "ops" });
  const l = publishAs(noKey, { providerId: "p", title: "x", description: "x", category: "API", asset: "EUR", unitPrice: 10n, capacity: 2n });
  const o = reserveAs(noKey, { listingId: l.listingId, buyerId: "b", quantity: 1n });
  assert.throws(() => noKey.cancel(o.orderId, signAction({ marketplaceId: noKey.marketplaceId, action: "cancel", actorId: "ops", target: o.orderId }, createMarketplaceIdentity("ops").privateKey)), /ADMIN_NOT_CONFIGURED/);
  assert.throws(() => noKey.registerIdentity("ops", createMarketplaceIdentity("ops").publicKeyHex), /RESERVED_IDENTITY/);
  // Wrong admin key, and an authorizer that says no.
  const s = setup({ adminAuthorizer: () => false });
  const o2 = reserveAs(s.m, { listingId: s.listing.listingId, buyerId: "b", quantity: 1n });
  assert.throws(() => s.m.cancel(o2.orderId, act(s.m, "ops-admin", "cancel", o2.orderId, {}, createMarketplaceIdentity("ops-admin"))), /ACTOR_SIGNATURE_INVALID/);
  assert.throws(() => cancel(s.m, o2.orderId, "ops-admin"), /ADMIN_NOT_AUTHORIZED/);
  const s2 = setup();
  const o3 = reserveAs(s2.m, { listingId: s2.listing.listingId, buyerId: "b", quantity: 1n });
  assert.equal(cancel(s2.m, o3.orderId, "ops-admin").status, "CANCELLED");
  // Configuration errors.
  assert.throws(() => new DigitalServicesMarketplace({ settlementArbiterId: "arb" }), /ARBITER_PUBLIC_KEY_REQUIRED/);
  assert.throws(() => new DigitalServicesMarketplace({ settlementArbiterId: "marketplace-system", settlementArbiterPublicKey: ARBITER.publicKeyHex }), /ARBITER_ID_INVALID/);
  assert.throws(() => new DigitalServicesMarketplace({ adminIdentity: "marketplace-system" }), /LEGACY_ADMIN_ID_RESERVED/);
  assert.throws(() => new DigitalServicesMarketplace({ adminPublicKey: "not-a-key" }), /ADMIN_PUBLIC_KEY_INVALID/);
  assert.deepEqual(s2.m.authorityPublicKeys(), { admin: ADMIN.publicKeyHex, arbiter: ARBITER.publicKeyHex });
});

// ---------------------------------------------------------------- fee floor (UEP-A16)

test("fee: the 3% Marketplace fee has a 1-unit floor on small amounts", () => {
  assert.equal(MARKETPLACE_FEE_BPS, 300);
  assert.equal(MIN_MARKETPLACE_FEE, 1n);
  assert.equal(calculateMarketplaceFee(0n), 0n);
  assert.equal(calculateMarketplaceFee(1n), 1n);
  assert.equal(calculateMarketplaceFee(10n), 1n);
  assert.equal(calculateMarketplaceFee(33n), 1n);
  assert.equal(calculateMarketplaceFee(66n), 1n);
  assert.equal(calculateMarketplaceFee(67n), 2n);
  assert.equal(calculateMarketplaceFee(100n), 3n);
  assert.equal(calculateMarketplaceFee(1_000n), 30n);
  assert.equal(calculateMarketplaceFee(10n, 0), 0n); // an explicit 0 bps configuration stays fee-free
  const m = new DigitalServicesMarketplace({ now: () => T0 });
  const l = publishAs(m, { providerId: "p", title: "Tiny API", description: "x", category: "API", asset: "EUR", unitPrice: 10n, capacity: 5n });
  assert.equal(m.checkoutQuote(l.listingId, 1n).marketplaceFee, 1n);
  const o = reserveAs(m, { listingId: l.listingId, buyerId: "b", quantity: 1n });
  fund(m, o.orderId, o.fundingDue);
  deliver(m, o.orderId, "p", Buffer.from("x"));
  const r = settle(m, o.orderId, "b");
  assert.equal(r.marketplaceFee, 1n);
  assert.equal(r.providerPayout, 9n);
  assert.equal(m.treasury.totalOf("EUR"), 1n);
  assert.equal(m.valueAccounting("EUR").conserved, true);
});
