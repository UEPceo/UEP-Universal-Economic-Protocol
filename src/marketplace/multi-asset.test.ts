/**
 * v0.4.7 multi-asset Marketplace: per-asset balance keying, asset id and
 * identity id validation, optional asset-registry mode, per-asset fee and
 * deposit floors, administrator-signed credits, idempotency scoping and value
 * conservation per asset over every order path with several assets at once.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace, MAX_IDENTITY_ID_LENGTH, MIN_RESERVATION_DEPOSIT } from "./marketplace.ts";
import { MarketplacePaymaster } from "./paymaster.ts";
import { MarketplaceTreasury, MIN_MARKETPLACE_FEE, calculateMarketplaceFee } from "./economy.ts";
import { createMarketplaceIdentity, signReservation } from "./identity.ts";
import { act, cancel, createTestAuthority, creditAs, deliver, disputeAs, enrollIdentity, expire, fund, publishAs, refundAs, reserveAs, resolveAs, settle } from "./testkit.ts";

const T0 = 1_700_000_000_000;
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const ADMIN = createTestAuthority("ops-admin");
const ARBITER = createTestAuthority("arbiter-1");
type Config = ConstructorParameters<typeof DigitalServicesMarketplace>[0];
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

function setup(config: Config = {}, gasAssets: string[] = []) {
  let now = T0;
  const paymaster = new MarketplacePaymaster({ now: () => now });
  for (const a of gasAssets) paymaster.fundReserve(a, 1_000_000n);
  const m = new DigitalServicesMarketplace({ now: () => now, paymaster, adminIdentity: "ops-admin", adminPublicKey: ADMIN.publicKeyHex, settlementArbiterId: "arbiter-1", settlementArbiterPublicKey: ARBITER.publicKeyHex, ...config });
  return { m, paymaster, advance(ms: number) { now += ms; } };
}

function assertConserved(m: DigitalServicesMarketplace, assets: string[]) {
  for (const a of assets) {
    const v = m.valueAccounting(a);
    assert.equal(v.conserved, true, `${a}: ${json(v)}`);
  }
}

// ---------------------------------------------------------------- balance keying

test("balance keying: every (asset, identity) pair holds an independent balance", () => {
  const { m } = setup();
  const assets = ["uep-test/teur", "asset:test", "asset", "EUR", "eur", "asset:test:eur:x", "a.b", "a_b", "a-b"];
  const ids = ["alice", "eur:alice", "test:eur:alice", "alice:", ":alice", "a", "eur", "x|y", "ünï", "asset:test:eur:alice"];
  const expected = new Map<string, bigint>();
  let n = 1n;
  for (const id of ids) enrollIdentity(m, id);
  for (const a of assets) for (const id of ids) {
    m.creditAccount(id, a, n);
    expected.set(JSON.stringify([a, id]), n);
    n++;
  }
  for (const a of assets) {
    let total = 0n;
    for (const id of ids) {
      const want = expected.get(JSON.stringify([a, id]))!;
      assert.equal(m.availableBalance(a, id), want, `${a} / ${id}`);
      total += want;
    }
    const v = m.valueAccounting(a);
    assert.equal(v.available, total);
    assert.equal(v.credited, total);
    assert.equal(v.conserved, true);
  }
});

test("balance keying: a reservation only ever draws on the buyer's own balance in the listing asset", () => {
  const { m } = setup();
  enrollIdentity(m, "alice", { asset: "uep-test/teur", amount: 1_000n });
  enrollIdentity(m, "eur:alice");
  const listing = publishAs(m, { providerId: "prov-x", title: "Svc", description: "x", category: "COMPUTE", asset: "asset:test", unitPrice: 100n, capacity: 10n });
  assert.equal(m.availableBalance("asset:test", "eur:alice"), 0n);
  assert.throws(() => reserveAs(m, { listingId: listing.listingId, buyerId: "eur:alice", quantity: 5n }, { credit: 0n }), /INSUFFICIENT_FUNDS_FOR_DEPOSIT/);
  assert.equal(m.availableBalance("uep-test/teur", "alice"), 1_000n);
  assert.equal(m.heldBalance("uep-test/teur", "alice"), 0n);
  assert.equal(m.availableBalance("asset:test", "prov-x"), 0n);
  assertConserved(m, ["uep-test/teur", "asset:test"]);
});

test("idempotency keys are scoped to the signing identity", () => {
  const { m } = setup();
  const listing = publishAs(m, { providerId: "prov", title: "Svc", description: "x", category: "COMPUTE", asset: "EUR", unitPrice: 10n, capacity: 10n });
  const o1 = reserveAs(m, { listingId: listing.listingId, buyerId: "a", quantity: 1n, idempotencyKey: "b:c" });
  const o2 = reserveAs(m, { listingId: listing.listingId, buyerId: "a:b", quantity: 1n, idempotencyKey: "c" });
  assert.notEqual(o1.orderId, o2.orderId);
  assert.equal(o2.buyerId, "a:b");
  assert.equal(m.getListing(listing.listingId).available, 8n);
});

// ---------------------------------------------------------------- ids

test("asset ids: malformed asset ids are rejected for listings and credits", () => {
  const { m } = setup();
  enrollIdentity(m, "buyer");
  for (const bad of ["\u0000EUR", "E UR", "é", "a|b", ":eur", "x".repeat(65), "EUR\n"]) {
    assert.throws(() => m.creditAccount("buyer", bad, 1n), /ASSET_ID_INVALID/, json(bad));
    assert.throws(() => publishAs(m, { providerId: "prov", title: `T ${bad.length}`, description: "x", category: "COMPUTE", asset: bad, unitPrice: 1n, capacity: 1n }), /ASSET_ID_INVALID/, json(bad));
  }
  assert.ok(m.creditAccount("buyer", "x".repeat(64), 1n));
});

test("asset ids: with assetRegistryNetworkId only registered ledger assets are accepted", () => {
  const { m } = setup({ assetRegistryNetworkId: "uep-testnet-1" });
  enrollIdentity(m, "buyer");
  assert.throws(() => m.creditAccount("buyer", "EUR", 1n), /ASSET_NOT_REGISTERED/);
  assert.throws(() => m.creditAccount("buyer", "asset:test", 1n), /ASSET_NOT_REGISTERED/);
  assert.throws(() => publishAs(m, { providerId: "prov", title: "T", description: "x", category: "COMPUTE", asset: "uep-global/eur", unitPrice: 1n, capacity: 1n }), /ASSET_NOT_REGISTERED/);
  assert.equal(m.creditAccount("buyer", "uep-test/teur", 5n), 5n);
  assert.ok(publishAs(m, { providerId: "prov", title: "T", description: "x", category: "COMPUTE", asset: "uep-test/tbtc", unitPrice: 1n, capacity: 1n }));
  assert.throws(() => new DigitalServicesMarketplace({ assetRegistryNetworkId: "" }), /ASSET_REGISTRY_NETWORK_INVALID/);
});

test("identity ids: control characters and over-long ids are rejected", () => {
  const { m } = setup();
  const key = createMarketplaceIdentity("k").publicKeyHex;
  for (const bad of ["a\u0000", "a\nb", "\u007f", "a\u0085", "x".repeat(MAX_IDENTITY_ID_LENGTH + 1)]) {
    assert.throws(() => m.registerIdentity(bad, key), /IDENTITY_ID_INVALID/, json(bad));
  }
  assert.ok(m.registerIdentity("x".repeat(MAX_IDENTITY_ID_LENGTH), key));
});

// ---------------------------------------------------------------- fees and deposits

test("fees: per-asset Marketplace fee and deposit floors; 3% and the defaults are unchanged", () => {
  assert.equal(calculateMarketplaceFee(10_000n), 300n);
  assert.equal(calculateMarketplaceFee(1n), MIN_MARKETPLACE_FEE);
  assert.equal(calculateMarketplaceFee(1_000n, 300, 100n), 100n);
  assert.equal(calculateMarketplaceFee(50n, 300, 100n), 50n); // never above the amount
  assert.throws(() => calculateMarketplaceFee(10n, 300, 0n), /INVALID_MIN_FEE/);
  assert.throws(() => new MarketplaceTreasury({ minFeeByAsset: { BTC: 0n } }), /INVALID_MIN_FEE/);
  const treasury = new MarketplaceTreasury({ minFeeByAsset: { "uep-test/tbtc": 100n } });
  const { m } = setup({ treasury, minReservationDepositByAsset: { "uep-test/tbtc": 500n } });
  assert.equal(m.feeQuoteFor(1_000n, "uep-test/tbtc").marketplaceFee, 100n);
  assert.equal(m.feeQuoteFor(1_000n, "uep-test/teur").marketplaceFee, 30n);
  assert.equal(m.feeQuoteFor(100_000n, "uep-test/tbtc").marketplaceFee, 3_000n);
  assert.equal(m.reservationDepositFor(1_000n, 0n, "uep-test/tbtc"), 500n);
  assert.equal(m.reservationDepositFor(1_000n, 0n, "uep-test/teur"), 10n);
  assert.equal(m.reservationDepositFor(10n, 0n, "uep-test/teur"), MIN_RESERVATION_DEPOSIT);
  assert.equal(m.reservationDepositFor(100n, 0n, "uep-test/tbtc"), 100n); // capped at the order total
  const l = publishAs(m, { providerId: "prov", title: "T", description: "x", category: "COMPUTE", asset: "uep-test/tbtc", unitPrice: 1_000n, capacity: 5n });
  assert.equal(m.checkoutQuote(l.listingId, 1n).reservationDeposit, 500n);
  const o = reserveAs(m, { listingId: l.listingId, buyerId: "b", quantity: 1n }, { credit: 2_000n });
  assert.equal(o.reservationDeposit, 500n);
  fund(m, o.orderId, o.fundingDue);
  deliver(m, o.orderId, "prov", Buffer.from("r"));
  const rec = settle(m, o.orderId, "b");
  assert.equal(rec.marketplaceFee, 100n);
  assert.equal(rec.providerPayout, 900n);
  assertConserved(m, ["uep-test/tbtc"]);
  assert.throws(() => setup({ minReservationDepositByAsset: { EUR: 0n } }), /INVALID_RESERVATION_LIMIT/);
});

// ---------------------------------------------------------------- credits

test("credits: with requireSignedCredits only administrator-signed, single-use credits are accepted", () => {
  const { m } = setup({ requireSignedCredits: true });
  enrollIdentity(m, "buyer");
  assert.throws(() => m.creditAccount("buyer", "EUR", 10n), /CREDIT_AUTHORIZATION_REQUIRED/);
  assert.throws(() => creditAs(m, "buyer", "buyer", "EUR", 10n, "c-1"), /CREDIT_NOT_AUTHORIZED/);
  assert.equal(creditAs(m, "ops-admin", "buyer", "EUR", 10n, "c-1"), 10n);
  assert.throws(() => creditAs(m, "ops-admin", "buyer", "EUR", 10n, "c-1"), /CREDIT_REPLAY/);
  assert.throws(() => m.creditAccount("buyer", "EUR", 10n, { creditId: "c-2", auth: { actorId: "ops-admin", signature: "00" } }), /ACTOR_SIGNATURE_INVALID/);
  // A signature for one amount, asset or identity does not authorize another.
  const signedFor5 = act(m, "ops-admin", "credit", "buyer", { asset: "EUR", amount: 5n, creditId: "c-3" });
  assert.throws(() => m.creditAccount("buyer", "EUR", 50n, { creditId: "c-3", auth: signedFor5 }), /ACTOR_SIGNATURE_INVALID/);
  assert.throws(() => m.creditAccount("buyer", "uep-test/teur", 5n, { creditId: "c-3", auth: signedFor5 }), /ACTOR_SIGNATURE_INVALID/);
  assert.equal(m.availableBalance("EUR", "buyer"), 10n);
  assertConserved(m, ["EUR"]);
  // Default: the testnet funding rail is unchanged.
  const plain = setup().m;
  enrollIdentity(plain, "buyer");
  assert.equal(plain.creditAccount("buyer", "EUR", 7n), 7n);
});

// ---------------------------------------------------------------- lifecycle

test("lifecycle: every order path conserves value per asset with several assets and gas in the order asset", () => {
  const assets = ["uep-test/teur", "uep-test/tbtc", "asset:test", "EUR"];
  const s = setup({ cancellationGraceMs: 2 * MIN }, assets);
  const { m } = s;
  const listings = assets.flatMap((asset, i) => [0, 1].map((j) => publishAs(m, { providerId: j === 0 ? `prov-${i}` : `${asset}:prov`, title: `Svc ${i}-${j}`, description: `d ${asset}`, category: "COMPUTE", asset, unitPrice: BigInt(50 + 25 * i + j), capacity: 1_000n })));
  // Bystanders hold value in every asset and never act.
  for (const asset of assets) enrollIdentity(m, `${asset}:bystander`, { asset, amount: 12_345n });
  let seed = 7;
  const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
  const paths = new Map<string, number>();
  for (let i = 0; i < 240; i++) {
    const listing = listings[rnd(listings.length)]!;
    const buyer = rnd(2) === 0 ? `buyer-${i % 13}` : `${listing.asset}:buyer-${i % 7}`;
    const quantity = BigInt(1 + rnd(4));
    const gasUnits = rnd(3) === 0 ? BigInt(1 + rnd(9)) : 0n;
    const gasQuote = gasUnits > 0n ? m.checkoutQuote(listing.listingId, quantity, gasUnits).gasQuote : undefined;
    const o = reserveAs(m, { listingId: listing.listingId, buyerId: buyer, quantity, gasQuote }, { credit: 5_000n });
    assertConserved(m, assets);
    const path = rnd(11);
    let name: string;
    if (path === 0) { cancel(m, o.orderId, buyer); name = "buyer-cancel-grace"; }
    else if (path === 1) { s.advance(3 * MIN); cancel(m, o.orderId, buyer); name = "buyer-cancel-forfeit"; }
    else if (path === 2) { cancel(m, o.orderId, listing.providerId); name = "provider-cancel"; }
    else if (path === 3) { s.advance(11 * MIN); expire(m, o.orderId, buyer); name = "expire-unfunded"; }
    else {
      fund(m, o.orderId, o.fundingDue);
      assertConserved(m, assets);
      if (path === 4) { s.advance(11 * MIN); m.reapExpiredReservations(); name = "expire-funded"; }
      else {
        deliver(m, o.orderId, listing.providerId, Buffer.from(`r-${i}`));
        if (path === 5) { settle(m, o.orderId, buyer); name = "release"; }
        else if (path === 6) { refundAs(m, listing.providerId, o.orderId); name = "provider-refund"; }
        else {
          disputeAs(m, buyer, o.orderId, `reason ${i}`);
          assertConserved(m, assets);
          if (path === 7) { resolveAs(m, "arbiter-1", o.orderId, { outcome: "RELEASE" }); name = "resolve-release"; }
          else if (path === 8) { resolveAs(m, "arbiter-1", o.orderId, { outcome: "REFUND_BUYER" }); name = "resolve-refund"; }
          else if (path === 9) { resolveAs(m, "arbiter-1", o.orderId, { outcome: "SPLIT", providerAmount: o.grossAmount / 2n || 1n }); name = "resolve-split"; }
          else { s.advance(8 * DAY); settle(m, o.orderId, buyer); name = "timeout-refund"; }
        }
      }
    }
    paths.set(name, (paths.get(name) ?? 0) + 1);
    assertConserved(m, assets);
    for (const l of listings) assert.equal(m.capacityAccounting(l.listingId).conserved, true);
  }
  assert.equal(paths.size, 11, json([...paths]));
  for (const asset of assets) {
    assert.equal(m.availableBalance(asset, `${asset}:bystander`), 12_345n);
    const v = m.valueAccounting(asset);
    assert.equal(v.lockedDeposits, 0n);
    assert.equal(v.held, 0n);
    assert.equal(v.marketplaceFees, m.treasury.totalOf(asset));
  }
  // Fees and gas of one asset never appear in another asset's accounting.
  const total = assets.reduce((sum, a) => sum + m.valueAccounting(a).credited, 0n);
  assert.equal(total, assets.reduce((sum, a) => { const v = m.valueAccounting(a); return sum + v.available + v.lockedDeposits + v.held + v.marketplaceFees + v.gasCaptured; }, 0n));
});

test("lifecycle: a gas quote in another asset than the listing is refused", () => {
  const s = setup({}, ["uep-test/teur", "uep-test/tbtc"]);
  const l = publishAs(s.m, { providerId: "prov", title: "T", description: "x", category: "COMPUTE", asset: "uep-test/teur", unitPrice: 10n, capacity: 5n });
  const q = s.paymaster.quote("uep-test/tbtc", 3n);
  enrollIdentity(s.m, "b", { asset: "uep-test/teur", amount: 100n });
  const sig = signReservation({ marketplaceId: s.m.marketplaceId, listingId: l.listingId, buyerId: "b", quantity: 1n, idempotencyKey: "k", gasQuoteId: q.quoteId }, enrollIdentity(s.m, "b").privateKey);
  assert.throws(() => s.m.reserve({ listingId: l.listingId, buyerId: "b", quantity: 1n, idempotencyKey: "k", signature: sig, gasQuote: q }), /GAS_ASSET_MISMATCH/);
  assertConserved(s.m, ["uep-test/teur", "uep-test/tbtc"]);
});
