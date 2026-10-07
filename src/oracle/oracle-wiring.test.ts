/**
 * v0.5.3: the oracle is wired into the Marketplace (listing price at publish
 * and reserve), the IoT/M2M service (tariff band and buyer budget) and the
 * hashlock swap category (rate check at open). Fail closed when the feed is
 * missing, stale or deviating.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { act, createTestAuthority, enrollIdentity, publishAs, reserveAs } from "../marketplace/testkit.ts";
import { IoTM2MService, IOT_M2M_CATEGORY } from "../service/iot-m2m.ts";
import { registerMachineAs, registerProviderAs, requestAs } from "../service/iot-testkit.ts";
import { SettlementIndex } from "../category/settlement-index.ts";
import { SwapCategory, swapHashlock, swapIntentId } from "../category/swap.ts";
import { OracleAggregator } from "./index.ts";
import { OracleRegistry } from "./registry.ts";
import { OraclePolicyGate } from "./policy-gate.ts";
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

test("marketplace: oracle-bound listing price is checked at publication and at every reservation", () => {
  const w = world();
  // Reference: 10 tENERGY per quantity × 2 = 20 tEUR.
  const ok = publishAs(w.m, listing(20n) as never);
  assert.deepEqual(ok.oracleReference, { baseAssetId: ENERGY, baseUnitsPerQuantity: 10n, maxDeviationPpm: 50_000n });
  assert.throws(() => publishAs(w.m, listing(30n) as never), /ORACLE_POLICY_REJECTED/);
  enrollIdentity(w.m, "buyer", { asset: EUR, amount: 10_000n });
  reserveAs(w.m, { listingId: ok.listingId, buyerId: "buyer", quantity: 1n });
  // Feed goes stale: no further reservations (fail closed).
  w.advance(20);
  assert.throws(() => reserveAs(w.m, { listingId: ok.listingId, buyerId: "buyer", quantity: 1n }), /ORACLE_STALE/);
  // Fresh feed that moved 50%: the listing price is out of band.
  w.publish(ENERGY, EUR, 3_000_000n);
  assert.throws(() => reserveAs(w.m, { listingId: ok.listingId, buyerId: "buyer", quantity: 1n }), /ORACLE_POLICY_REJECTED/);
  // Without a gate the Marketplace refuses oracle-bound listings.
  const admin = createTestAuthority("admin2");
  const bare = new DigitalServicesMarketplace({ adminIdentity: admin.identityId, adminPublicKey: admin.publicKeyHex, height: () => 1 });
  assert.throws(() => publishAs(bare, listing(20n) as never), /ORACLE_NOT_CONFIGURED/);
});

test("IoT: tariff must be oracle-bound when required; band and buyer budget are enforced", () => {
  const w = world();
  assert.throws(() => new IoTM2MService(new DigitalServicesMarketplace({ height: () => 1 }), { requireOracleTariff: true }), /ORACLE_NOT_CONFIGURED/);
  const iot = new IoTM2MService(w.m, { requireOracleTariff: true });
  registerProviderAs(iot, { providerId: "p1", displayName: "P" });
  registerMachineAs(iot, { machineId: "m1", providerId: "p1", serviceType: "energy", model: "M", endpointRef: "sim://m1" });
  const bound = publishAs(w.m, listing(20n, IOT_M2M_CATEGORY) as never);
  const unbound = publishAs(w.m, { providerId: "p1", title: "plain iot", description: "d", category: IOT_M2M_CATEGORY, asset: EUR, unitPrice: 20n, capacity: 100n });
  assert.throws(() => requestAs(iot, { buyerId: "b1", listingId: unbound.listingId, machineId: "m1", quantity: 1n }), /IOT_ORACLE_TARIFF_REQUIRED/);
  assert.ok(requestAs(iot, { buyerId: "b1", listingId: bound.listingId, machineId: "m1", quantity: 2n }).requestId);
  // Buyer budget below the oracle cost of the delivered units (2 × 10 tENERGY × 2 = 40).
  assert.throws(() => iot.requestService({ buyerId: "b1", listingId: bound.listingId, machineId: "m1", quantity: 2n, idempotencyKey: "k-budget", authorization: "x", maxCost: 39n }), /ORACLE_POLICY_REJECTED/);
  w.advance(20);
  assert.throws(() => requestAs(iot, { buyerId: "b1", listingId: bound.listingId, machineId: "m1", quantity: 1n }), /ORACLE_STALE/);
});

function openSwap(w: ReturnType<typeof world>, swap: SwapCategory, fromAmount: bigint, toAmount: bigint, nonce: number) {
  const intent = { version: 1 as const, category: "uep.service.swap.v1" as const, networkId: "uep-testnet", buyerId: "buyer", marketMakerId: "maker", fromAsset: EUR, fromAmount, toAsset: ENERGY, toAmount, hashlock: swapHashlock(`preimage-sixteen-${nonce}`, nonce, "uep-testnet"), deadline: w.height() + 100, orderNonce: nonce };
  const intentId = swapIntentId(intent);
  const { version, category, networkId, buyerId, marketMakerId, hashlock, deadline, orderNonce } = intent;
  return swap.open(act(w.m, "buyer", "swap-intent", intentId, { version, category, networkId, buyerId, marketMakerId, fromAsset: EUR, fromAmount, toAsset: ENERGY, toAmount, hashlock, deadline, orderNonce }), intent, act(w.m, "maker", "swap-accept", intentId, { intentId }), { intentId });
}

test("swap: governed pairs are rate-checked against the oracle at open (fail closed)", () => {
  const w = world();
  enrollIdentity(w.m, "buyer", { asset: EUR, amount: 10_000n });
  enrollIdentity(w.m, "maker", { asset: ENERGY, amount: 10_000n });
  const swap = new SwapCategory(w.m.issueCategoryEscrowPort("swap"), new SettlementIndex(), "uep-testnet", { priceGate: w.gate, maxSkewPpm: 30_000n });
  assert.equal(openSwap(w, swap, 1_000n, 500n, 1).state, "DUAL_HOLD_LOCKED"); // fair: 1 tEUR = 0.5 tENERGY
  assert.throws(() => openSwap(w, swap, 1_000n, 300n, 2), /ORACLE_POLICY_REJECTED/); // buyer short-changed by 40%
  w.advance(20);
  assert.throws(() => openSwap(w, swap, 1_000n, 500n, 3), /ORACLE_STALE/);
  assert.throws(() => new SwapCategory(w.m.issueCategoryEscrowPort("swap"), new SettlementIndex(), "uep-testnet", { requireOracle: true }), /ORACLE_NOT_CONFIGURED|CATEGORY_PORT/);
});

test("the gate refuses an aggregator without signature checks", () => {
  assert.throws(() => new OraclePolicyGate(new OracleAggregator({ requireSignatures: false })), /ORACLE_GATE_UNSIGNED/);
});
