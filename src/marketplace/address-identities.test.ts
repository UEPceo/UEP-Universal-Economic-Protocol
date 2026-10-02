/**
 * v0.4.5: marketplace identities named by ledger v2 addresses (UEP-ADDR-002),
 * buyer-only funding (UEP-D02) and the reservation-deposit minimum (UEP-D03).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace, MIN_RESERVATION_DEPOSIT } from "./marketplace.ts";
import { createMarketplaceIdentity, signAction } from "./identity.ts";
import { act, deliver, enrollAccountIdentity, enrollIdentity, fund, publishAs, reserveAs, settle } from "./testkit.ts";
import { encodeAccountAddress } from "../core/address.ts";
import { hAccount } from "../core/hash.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";
import { TESTNET } from "../network/profiles.ts";

const identity = async () => identityFromMnemonic(await generateMnemonic(128));
const LISTING = { title: "GPU", description: "compute", category: "COMPUTE" as const, asset: "EUR", unitPrice: 100n, capacity: 20n };

function conserved(m: DigitalServicesMarketplace) {
  const a = m.valueAccounting("EUR");
  assert.equal(a.conserved, true, JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  return a;
}

test("D02: only the buyer's signature funds an order", () => {
  const m = new DigitalServicesMarketplace();
  const listing = publishAs(m, { providerId: "prov", ...LISTING });
  const o = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n }, { credit: 1_000n });
  enrollIdentity(m, "mallory", { asset: "EUR", amount: 1_000n });
  const before = m.availableBalance("EUR", "buyer");
  const details = { amount: o.fundingDue };
  assert.throws(() => m.fundOrder(o.orderId, o.fundingDue, undefined), /ACTOR_SIGNATURE_REQUIRED/);
  assert.throws(() => m.fundOrder(o.orderId, o.fundingDue, "buyer" as never), /ACTOR_SIGNATURE_REQUIRED/);
  // Another registered identity, and the provider, sign with their own keys.
  assert.throws(() => m.fundOrder(o.orderId, o.fundingDue, act(m, "mallory", "fund", o.orderId, details)), /ORDER_ACCESS_FORBIDDEN/);
  assert.throws(() => m.fundOrder(o.orderId, o.fundingDue, act(m, "prov", "fund", o.orderId, details)), /ORDER_ACCESS_FORBIDDEN/);
  // Claiming to be the buyer with another key.
  const outsider = createMarketplaceIdentity("buyer");
  assert.throws(() => m.fundOrder(o.orderId, o.fundingDue, signAction({ marketplaceId: m.marketplaceId, action: "fund", actorId: "buyer", target: o.orderId, details }, outsider.privateKey)), /ACTOR_SIGNATURE_INVALID/);
  assert.equal(m.availableBalance("EUR", "buyer"), before);
  assert.equal(m.availableBalance("EUR", "mallory"), 1_000n);
  assert.equal(m.getOrder(o.orderId, act(m, "buyer", "read", o.orderId, { issuedAt: m.clock() })).status, "ACCEPTED");
  conserved(m);
  assert.equal(fund(m, o.orderId, o.fundingDue).status, "HELD");
  assert.equal(m.availableBalance("EUR", "buyer"), before - o.fundingDue);
  conserved(m);
});

test("D03: the reservation deposit has a 1-unit minimum unless a test-only flag is set", () => {
  assert.equal(MIN_RESERVATION_DEPOSIT, 1n);
  assert.throws(() => new DigitalServicesMarketplace({ reservationDeposit: 0n }), /RESERVATION_DEPOSIT_BELOW_MINIMUM/);
  assert.throws(() => new DigitalServicesMarketplace({ reservationDeposit: 0n, testOnlyAllowZeroReservationDeposit: false }), /RESERVATION_DEPOSIT_BELOW_MINIMUM/);
  assert.throws(() => new DigitalServicesMarketplace({ reservationDeposit: -1n, testOnlyAllowZeroReservationDeposit: true }), /INVALID_RESERVATION_LIMIT/);
  // Default and bps = 0 both keep the 1-unit floor.
  assert.equal(new DigitalServicesMarketplace().reservationDepositFor(10n), 1n);
  assert.equal(new DigitalServicesMarketplace({ reservationDepositBps: 0 }).reservationDepositFor(10_000n), 1n);
  assert.equal(new DigitalServicesMarketplace({ reservationDeposit: 1n }).reservationDepositFor(10_000n), 1n);
  // A funded buyer pays the deposit at reserve(); a buyer without funds cannot reserve.
  const m = new DigitalServicesMarketplace({ reservationDeposit: 1n });
  const listing = publishAs(m, { providerId: "prov", ...LISTING });
  assert.throws(() => reserveAs(m, { listingId: listing.listingId, buyerId: "broke", quantity: 1n }, { credit: 0n }), /INSUFFICIENT_FUNDS_FOR_DEPOSIT/);
  const o = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n }, { credit: 500n });
  assert.equal(o.depositLocked, 1n);
  conserved(m);
  // Explicit, clearly named test-only escape hatch.
  const t = new DigitalServicesMarketplace({ reservationDeposit: 0n, testOnlyAllowZeroReservationDeposit: true });
  assert.equal(t.testOnlyAllowZeroReservationDeposit, true);
  const tl = publishAs(t, { providerId: "prov", ...LISTING });
  assert.equal(reserveAs(t, { listingId: tl.listingId, buyerId: "buyer", quantity: 1n }, { credit: 0n }).depositLocked, 0n);
  conserved(t);
});

test("identities named by a ledger address must register the key the address commits to", async () => {
  const a = await identity(); const b = await identity();
  const m = new DigitalServicesMarketplace();
  const addrA = encodeAccountAddress(TESTNET.networkId, a.accountId);
  // Wrong key for the address.
  assert.throws(() => m.registerIdentity(addrA, b.spendPublicKey), /IDENTITY_ADDRESS_KEY_MISMATCH/);
  assert.throws(() => m.registerIdentity(addrA, createMarketplaceIdentity("x").publicKeyHex), /IDENTITY_ADDRESS_KEY_MISMATCH/);
  // Malformed, non-canonical, wrong-network and legacy addresses.
  const flipped = addrA.slice(0, 30) + (addrA[30] === "q" ? "p" : "q") + addrA.slice(31);
  assert.throws(() => m.registerIdentity(flipped, a.spendPublicKey), /IDENTITY_ADDRESS_INVALID: ADDRESS_CHECKSUM/);
  assert.throws(() => m.registerIdentity(addrA.toUpperCase(), a.spendPublicKey), /IDENTITY_ADDRESS_INVALID/);
  assert.throws(() => m.registerIdentity(encodeAccountAddress("uep-global-1", a.accountId), a.spendPublicKey), /IDENTITY_ADDRESS_INVALID: ADDRESS_NETWORK/);
  assert.throws(() => m.registerIdentity(`uep:${TESTNET.networkId}:${hAccount(a.secret, a.salt).toHex()}`, a.spendPublicKey), /IDENTITY_ADDRESS_INVALID: ADDRESS_LEGACY_V1/);
  assert.equal(m.isIdentityRegistered(addrA), false);
  // The matching spend key registers; plain names are unaffected.
  const buyer = enrollAccountIdentity(m, a);
  assert.equal(buyer.identityId, addrA);
  assert.ok(m.ledgerAccountOf(addrA)!.eq(a.accountId));
  assert.equal(m.ledgerAccountOf("prov"), undefined);
  // Full flow with address-named buyer and provider; value is conserved.
  const provAddr = enrollAccountIdentity(m, b).identityId;
  const listing = publishAs(m, { providerId: provAddr, ...LISTING });
  const o = reserveAs(m, { listingId: listing.listingId, buyerId: addrA, quantity: 2n }, { credit: 1_000n });
  fund(m, o.orderId, o.fundingDue);
  deliver(m, o.orderId, provAddr, Buffer.from("result"));
  const r = settle(m, o.orderId, addrA);
  assert.equal(r.grossAmount, 200n);
  assert.equal(m.availableBalance("EUR", provAddr), r.providerPayout);
  assert.equal(r.providerPayout + r.marketplaceFee, 200n);
  const acc = conserved(m);
  assert.equal(acc.held, 0n);
});
