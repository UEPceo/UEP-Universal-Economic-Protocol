/**
 * v0.5.3: the oracle is wired into the Marketplace (listing price at publish
 * and reserve), the IoT/M2M service (tariff band and buyer budget) and the
 * hashlock swap category (rate check at open), each only when the signed
 * terms opt in. Out of band: refused. Oracle unavailable: the signed
 * onOracleUnavailable decides (default: follow the signed price).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { act, createTestAuthority, enrollIdentity, publishAs, reserveAs } from "../marketplace/testkit.ts";
import { listingTerms } from "../marketplace/identity.ts";
import { IoTM2MService, IOT_M2M_CATEGORY } from "../service/iot-m2m.ts";
import { registerMachineAs, registerProviderAs, requestAs } from "../service/iot-testkit.ts";
import { SettlementIndex } from "../category/settlement-index.ts";
import { SwapCategory, swapHashlock, swapIntentId, type SwapIntentBody } from "../category/swap.ts";
import { OracleAggregator } from "./index.ts";
import { OracleRegistry } from "./registry.ts";
import { aggregatedQuoteHash, OraclePolicyGate } from "./policy-gate.ts";
import { createOracleTestKey, makeQuote, registerOracleTestKey, signQuote, resetOracleSequence } from "./testkit.ts";

const EUR = "uep-test/teur";
const ENERGY = "uep-test/tenergy";

function world(priceE6 = 2_000_000n) {
  resetOracleSequence(1n);
  let h = 1000;
  const keys = [createOracleTestKey("a"), createOracleTestKey("b")];
  const registry = new OracleRegistry();
  for (const k of keys) registerOracleTestKey(registry, k);
  registry.setPairPolicy({ baseAssetId: ENERGY, quoteAssetId: EUR, maxStalenessHeights: 12, maxDeviationPpm: 50_000n, minSources: 2 });
  registry.setPairPolicy({ baseAssetId: EUR, quoteAssetId: ENERGY, maxStalenessHeights: 12, maxDeviationPpm: 50_000n, minSources: 2 });
  const aggregator = new OracleAggregator({ defaultMinSources: 2 }, registry);
  const publish = (base: string, quote: string, p: bigint) => {
    for (const k of keys) assert.equal(aggregator.publish(signQuote(makeQuote({ source: k.sourceId, baseAssetId: base, quoteAssetId: quote, priceE6: p, observedAtHeight: h }), k.privateKey, k.publicKeyHex), h).ok, true);
  };
  publish(ENERGY, EUR, priceE6); // 1 tENERGY = 2 tEUR units
  publish(EUR, ENERGY, 500_000n); // 1 tEUR = 0.5 tENERGY
  const gate = new OraclePolicyGate(aggregator);
  const admin = createTestAuthority("admin");
  const m = new DigitalServicesMarketplace({ adminIdentity: admin.identityId, adminPublicKey: admin.publicKeyHex, height: () => h, oracleGate: gate });
  return { m, gate, aggregator, publish, advance: (n: number) => { h += n; }, height: () => h };
}

const listing = (unitPrice: bigint, category = "COMPUTE") => ({ providerId: "p1", title: `energy ${unitPrice} ${category}`, description: "d", category, asset: EUR, unitPrice, capacity: 100n, oracleReference: { baseAssetId: ENERGY, baseUnitsPerQuantity: 10n, maxDeviationPpm: 50_000n } });

test("marketplace: oracle-bound listing price is checked at publication and at every reservation; the quote hash is stored", () => {
  const w = world();
  // Reference: 10 tENERGY per quantity × 2 = 20 tEUR.
  const ok = publishAs(w.m, listing(20n) as never);
  assert.deepEqual(ok.oracleReference, { baseAssetId: ENERGY, baseUnitsPerQuantity: 10n, maxDeviationPpm: 50_000n });
  assert.equal(ok.publishOracleCheck?.outcome, "IN_BAND");
  assert.throws(() => publishAs(w.m, listing(30n) as never), /ORACLE_POLICY_REJECTED/);
  enrollIdentity(w.m, "buyer", { asset: EUR, amount: 10_000n });
  const o = reserveAs(w.m, { listingId: ok.listingId, buyerId: "buyer", quantity: 1n });
  assert.equal(o.oracleCheck?.outcome, "IN_BAND");
  assert.equal(o.oracleCheck?.quoteHash, aggregatedQuoteHash(w.gate.quote(ENERGY, EUR, w.height())));
  // Feed goes stale: by default the signed price is followed and the outcome recorded.
  w.advance(20);
  const followed = reserveAs(w.m, { listingId: ok.listingId, buyerId: "buyer", quantity: 1n });
  assert.deepEqual({ ...followed.oracleCheck }, { outcome: "ORACLE_UNAVAILABLE_SIGNED_PRICE", height: w.height(), reason: "ORACLE_STALE" });
  // Fresh feed that moved 50%: the listing price is out of band (always refused).
  w.publish(ENERGY, EUR, 3_000_000n);
  assert.throws(() => reserveAs(w.m, { listingId: ok.listingId, buyerId: "buyer", quantity: 1n }), /ORACLE_POLICY_REJECTED/);
  // Without a gate: the default follows the signed price; BLOCK_NEW refuses.
  const admin = createTestAuthority("admin2");
  const bare = new DigitalServicesMarketplace({ adminIdentity: admin.identityId, adminPublicKey: admin.publicKeyHex, height: () => 1 });
  assert.equal(publishAs(bare, listing(20n) as never).publishOracleCheck?.reason, "ORACLE_NOT_CONFIGURED");
  const blocking = { ...listing(21n), oracleReference: { baseAssetId: ENERGY, baseUnitsPerQuantity: 10n, maxDeviationPpm: 50_000n, onOracleUnavailable: "BLOCK_NEW" } };
  assert.throws(() => publishAs(bare, blocking as never), /ORACLE_NOT_CONFIGURED/);
  // onOracleUnavailable is a signed term: changing it after signing breaks the provider signature.
  enrollIdentity(w.m, "p1");
  const signed = act(w.m, "p1", "publish", "", listingTerms(listing(22n) as never));
  assert.throws(() => w.m.publishListing({ ...listing(22n), oracleReference: { ...listing(22n).oracleReference, onOracleUnavailable: "BLOCK_NEW" } } as never, signed), /SIGNATURE|NOT_AUTHORIZED/);
  assert.throws(() => publishAs(w.m, { ...listing(23n), oracleReference: { ...listing(23n).oracleReference, onOracleUnavailable: "MAYBE" } } as never), /ORACLE_UNAVAILABLE_POLICY_INVALID/);
});

test("IoT: oracle binding is per listing; band and buyer budget are enforced; the service flag is a no-op shim", () => {
  const w = world();
  // Deprecated shim: accepted, no gate needed, does not force listings onto the oracle.
  assert.equal(new IoTM2MService(new DigitalServicesMarketplace({ height: () => 1 }), { requireOracleTariff: true }).requireOracleTariff, true);
  const iot = new IoTM2MService(w.m, { requireOracleTariff: true });
  registerProviderAs(iot, { providerId: "p1", displayName: "P" });
  registerMachineAs(iot, { machineId: "m1", providerId: "p1", serviceType: "energy", model: "M", endpointRef: "sim://m1" });
  const bound = publishAs(w.m, listing(20n, IOT_M2M_CATEGORY) as never);
  const unbound = publishAs(w.m, { providerId: "p1", title: "plain iot", description: "d", category: IOT_M2M_CATEGORY, asset: EUR, unitPrice: 20n, capacity: 100n });
  assert.ok(requestAs(iot, { buyerId: "b1", listingId: unbound.listingId, machineId: "m1", quantity: 1n }).requestId);
  assert.ok(requestAs(iot, { buyerId: "b1", listingId: bound.listingId, machineId: "m1", quantity: 2n }).requestId);
  // Buyer budget below the oracle cost of the delivered units (2 × 10 tENERGY × 2 = 40).
  assert.throws(() => iot.requestService({ buyerId: "b1", listingId: bound.listingId, machineId: "m1", quantity: 2n, idempotencyKey: "k-budget", authorization: "x", maxCost: 39n }), /ORACLE_POLICY_REJECTED/);
  const blocking = publishAs(w.m, { ...listing(20n, IOT_M2M_CATEGORY), title: "blocking iot", oracleReference: { baseAssetId: ENERGY, baseUnitsPerQuantity: 10n, maxDeviationPpm: 50_000n, onOracleUnavailable: "BLOCK_NEW" } } as never);
  // Stale feed: the listing's default follows the signed price.
  w.advance(20);
  assert.ok(requestAs(iot, { buyerId: "b2", listingId: bound.listingId, machineId: "m1", quantity: 1n }).requestId);
  assert.throws(() => requestAs(iot, { buyerId: "b3", listingId: blocking.listingId, machineId: "m1", quantity: 1n }), /ORACLE_STALE/);
});

function openSwap(w: ReturnType<typeof world>, swap: SwapCategory, fromAmount: bigint, toAmount: bigint, nonce: number, oracleBand?: SwapIntentBody["oracleBand"], signedBand: SwapIntentBody["oracleBand"] | null | "same" = "same") {
  const intent: SwapIntentBody = { version: 1 as const, category: "uep.service.swap.v1" as const, networkId: "uep-testnet", buyerId: "buyer", marketMakerId: "maker", fromAsset: EUR, fromAmount, toAsset: ENERGY, toAmount, hashlock: swapHashlock(`preimage-sixteen-${nonce}`, nonce, "uep-testnet"), deadline: w.height() + 100, orderNonce: nonce, ...(oracleBand ? { oracleBand } : {}) };
  const intentId = swapIntentId(intent);
  const { version, category, networkId, buyerId, marketMakerId, hashlock, deadline, orderNonce } = intent;
  const band = signedBand === "same" ? oracleBand : signedBand ?? undefined;
  return swap.open(act(w.m, "buyer", "swap-intent", intentId, { version, category, networkId, buyerId, marketMakerId, fromAsset: EUR, fromAmount, toAsset: ENERGY, toAmount, hashlock, deadline, orderNonce, ...(band ? { oracleBand: band } : {}) }), intent, act(w.m, "maker", "swap-accept", intentId, { intentId }), { intentId });
}

test("swap: the oracle rate check is an explicit, signed per-swap opt-in (oracleBand)", () => {
  const w = world();
  enrollIdentity(w.m, "buyer", { asset: EUR, amount: 10_000n });
  enrollIdentity(w.m, "maker", { asset: ENERGY, amount: 10_000n });
  const swap = new SwapCategory(w.m.issueCategoryEscrowPort("swap"), new SettlementIndex(), "uep-testnet", { priceGate: w.gate });
  const band = { maxSkewPpm: 30_000n };
  const fair = openSwap(w, swap, 1_000n, 500n, 1, band); // fair: 1 tEUR = 0.5 tENERGY
  assert.equal(fair.state, "DUAL_HOLD_LOCKED");
  assert.equal(fair.oracleCheck?.outcome, "IN_BAND");
  assert.match(fair.oracleCheck?.quoteHash ?? "", /^[0-9a-f]{64}$/);
  assert.throws(() => openSwap(w, swap, 1_000n, 300n, 2, band), /ORACLE_POLICY_REJECTED/); // buyer short-changed by 40%
  // A registry pair policy alone does not bind a swap: without oracleBand the oracle is not consulted.
  assert.equal(w.gate.governs(EUR, ENERGY), true);
  const plain = openSwap(w, swap, 1_000n, 300n, 3);
  assert.equal(plain.state, "DUAL_HOLD_LOCKED");
  assert.equal(plain.oracleCheck, undefined);
  // The band is part of the signed intent: adding it after signing (or dropping it) breaks the buyer signature.
  assert.throws(() => openSwap(w, swap, 1_000n, 500n, 4, band, null));
  assert.throws(() => openSwap(w, swap, 1_000n, 500n, 5, undefined, band));
  assert.throws(() => openSwap(w, swap, 1_000n, 500n, 6, { maxSkewPpm: -1n }), /SWAP_ORACLE_BAND_INVALID/);
  assert.throws(() => openSwap(w, swap, 1_000n, 500n, 7, { maxSkewPpm: 1n, onOracleUnavailable: "PANIC" as never }), /ORACLE_UNAVAILABLE_POLICY_INVALID/);
  // Feed stale: by default the signed price is followed (and recorded); BLOCK_NEW refuses the new swap only.
  w.advance(20);
  const followed = openSwap(w, swap, 1_000n, 500n, 8, band);
  assert.equal(followed.oracleCheck?.outcome, "ORACLE_UNAVAILABLE_SIGNED_PRICE");
  assert.equal(followed.oracleCheck?.reason, "ORACLE_STALE");
  assert.throws(() => openSwap(w, swap, 1_000n, 500n, 9, { maxSkewPpm: 30_000n, onOracleUnavailable: "BLOCK_NEW" }), /ORACLE_STALE/);
  assert.equal(openSwap(w, swap, 1_000n, 500n, 10).state, "DUAL_HOLD_LOCKED");
  // Deprecated shim: requireOracle no longer binds pairs, but still needs a gate.
  assert.throws(() => new SwapCategory(w.m.issueCategoryEscrowPort("swap"), new SettlementIndex(), "uep-testnet", { requireOracle: true }), /ORACLE_NOT_CONFIGURED|CATEGORY_PORT/);
});

test("swap: without a gate an opted-in swap follows the signed price by default", () => {
  const w = world();
  enrollIdentity(w.m, "buyer", { asset: EUR, amount: 10_000n });
  enrollIdentity(w.m, "maker", { asset: ENERGY, amount: 10_000n });
  const swap = new SwapCategory(w.m.issueCategoryEscrowPort("swap"), new SettlementIndex(), "uep-testnet");
  assert.equal(openSwap(w, swap, 1_000n, 500n, 1, { maxSkewPpm: 30_000n }).oracleCheck?.reason, "ORACLE_NOT_CONFIGURED");
  assert.throws(() => openSwap(w, swap, 1_000n, 500n, 2, { maxSkewPpm: 30_000n, onOracleUnavailable: "BLOCK_NEW" }), /ORACLE_NOT_CONFIGURED/);
});

test("pausing a pair never creates a pair policy", () => {
  const registry = new OracleRegistry();
  registry.setPairPaused(EUR, ENERGY, true);
  assert.equal(registry.getPairPolicy(EUR, ENERGY), undefined);
  assert.equal(registry.isPairPaused(EUR, ENERGY), true);
  registry.setPairPaused(EUR, ENERGY, false);
  assert.equal(registry.isPairPaused(EUR, ENERGY), false);
  assert.equal(registry.getPairPolicy(EUR, ENERGY), undefined);
  // With a policy, pause / resume keep its other fields.
  registry.setPairPolicy({ baseAssetId: EUR, quoteAssetId: ENERGY, maxStalenessHeights: 12, maxDeviationPpm: 50_000n, minSources: 2 });
  registry.setPairPaused(EUR, ENERGY, true);
  assert.equal(registry.isPairPaused(EUR, ENERGY), true);
  assert.equal(registry.getPairPolicy(EUR, ENERGY)?.minSources, 2);
});

test("the gate refuses an aggregator without signature checks", () => {
  assert.throws(() => new OraclePolicyGate(new OracleAggregator({ requireSignatures: false })), /ORACLE_GATE_UNSIGNED/);
});
