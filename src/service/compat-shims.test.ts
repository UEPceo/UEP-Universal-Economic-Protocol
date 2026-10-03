/**
 * v0.5.0 compatibility shims (docs/COMPATIBILITY.md): pre-v0.5.0 inputs keep
 * working through deterministic conversions, with deprecation warnings.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { act, enrollIdentity, publishAs, reserveAs } from "../marketplace/testkit.ts";
import { listingTerms } from "../marketplace/identity.ts";
import { MarketplaceReputation, calculateBayesianReputation } from "../marketplace/reputation.ts";
import { SecurityPolicy } from "../core/security-policy.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { TESTNET } from "../network/profiles.ts";
import { identityFromMnemonic, generateMnemonic } from "../identity/index.ts";
import { LEGACY_ASSET_ID_ALIASES, findAsset, ledgerAssetIdToFr, resolveAssetIdAlias } from "../core/assets.ts";
import { emittedDeprecations, LEGACY_MS_THRESHOLD } from "../core/deprecation.ts";
import { legacyMsToHeight } from "../core/height.ts";
import { MemoryStorageProvider } from "./memory-storage.ts";
import { UepServiceApi } from "./uep-service-api.ts";
import { IoTM2MService, IOT_M2M_CATEGORY } from "./iot-m2m.ts";
import { holdAs, registerMachineAs, registerProviderAs, requestAs, simulateAs, deliverTelemetryAs } from "./iot-testkit.ts";
import { startBlockProducer } from "./block-producer.ts";

describe("v0.5.0 compatibility shims", () => {
  it("asset ids: pre-v0.5.0 ids resolve to namespaced ids in the ledger and the Marketplace", async () => {
    assert.equal(resolveAssetIdAlias("asset:test:eur"), "uep-test/teur");
    assert.equal(resolveAssetIdAlias("uep-test/teur"), "uep-test/teur");
    for (const [legacy, canonical] of Object.entries(LEGACY_ASSET_ID_ALIASES)) {
      assert.match(canonical, /^[a-z0-9-]+\/[a-z0-9._-]+$/);
      assert.ok(ledgerAssetIdToFr(legacy).eq(ledgerAssetIdToFr(canonical)));
    }
    assert.equal(findAsset(TESTNET.networkId, "asset:test:energy")?.assetId, "uep-test/tenergy");
    const ledger = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true });
    const a = await identityFromMnemonic(await generateMnemonic(128));
    const b = await identityFromMnemonic(await generateMnemonic(128));
    ledger.faucet(a.accountId, "asset:test:eur", 10_000n);
    assert.equal(ledger.balanceOfAsset(a.accountId, "uep-test/teur"), 10_000n);
    assert.equal(ledger.balanceOf(a.accountId, ledgerAssetIdToFr("uep-test/teur")), 10_000n);
    const p = ledger.prepareSpend(a, b.accountId, "asset:test:eur", 1_000n);
    assert.ok("tx" in p);
    assert.ok("tx" in ledger.submit(p.tx));
    assert.equal(ledger.balanceOfAsset(b.accountId, "asset:test:eur"), 1_000n);
    // Marketplace: the provider signed the legacy id; the listing is stored and found under the namespaced id.
    const m = new DigitalServicesMarketplace({ assetRegistryNetworkId: TESTNET.networkId });
    const input = { providerId: "p1", title: "Energy", description: "kWh", category: "API" as const, asset: "asset:test:eur", unitPrice: 10n, capacity: 5n };
    enrollIdentity(m, "p1");
    const listing = m.publishListing(input, act(m, "p1", "publish", "", listingTerms(input)));
    assert.equal(listing.asset, "uep-test/teur");
    assert.equal(m.searchListings({ asset: "asset:test:eur" }).length, 1);
    assert.ok(emittedDeprecations().includes("UEP_DEP_ASSET_ALIAS"));
  });

  it("*Ms options and the ms `now` counter still work and warn", () => {
    const m = new DigitalServicesMarketplace({ reservationTtlMs: 60_000 });
    assert.equal(m.baseWindows.reservationTtl, 12);
    assert.equal(m.reservationTtlMs, 60_000);
    let t = 1_000;
    const legacy = new DigitalServicesMarketplace({ now: () => t, reservationTtlMs: 60_000 });
    assert.equal(legacy.timeUnit, "legacy-ms");
    assert.equal(legacy.baseWindows.reservationTtl, 60_000);
    t += 1;
    assert.ok(emittedDeprecations().includes("UEP_DEP_MS_OPTION"));
    assert.ok(emittedDeprecations().includes("UEP_DEP_NOW_OPTION"));
  });

  it("prepareSpend(..., Date.now()) uses the ledger height (no clock read)", async () => {
    const ledger = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true });
    ledger.advanceHeight(4);
    const a = await identityFromMnemonic(await generateMnemonic(128));
    const b = await identityFromMnemonic(await generateMnemonic(128));
    ledger.faucet(a.accountId, "uep-test/teur", 10_000n);
    const p = ledger.prepareSpend(a, b.accountId, "uep-test/teur", 100n, 1_791_000_000_000);
    assert.ok("tx" in p);
    assert.equal(p.tx.createdAt, 4);
    assert.ok("tx" in ledger.submit(p.tx));
    assert.ok(emittedDeprecations().includes("UEP_DEP_SPEND_NOW_MS"));
  });

  it("SecurityPolicy windowMs keeps its pre-v0.5.0 meaning in the probes' unit", () => {
    const p = new SecurityPolicy({ windowMs: 60_000, maxTxPerWindow: 1 });
    const probe = { accountHex: "aa", assetId: "uep-test/teur", amount: 10n, fee: 1n };
    assert.equal(p.check({ ...probe, nowMs: 1_000 }, true).ok, true);
    assert.equal(p.check({ ...probe, nowMs: 30_000 }, true).ok, false);
    assert.equal(p.check({ ...probe, nowMs: 61_001 }, true).ok, true);
    assert.ok(emittedDeprecations().includes("UEP_DEP_POLICY_WINDOW_MS"));
  });

  it("reputation: score() without `now` is deterministic (latest event stamp), also for Unix-ms stamps", () => {
    for (const base of [100, 1_791_000_000_000]) {
      const r = new MarketplaceReputation();
      const day = base >= LEGACY_MS_THRESHOLD ? 86_400_000 : 17_280;
      r.record({ sellerId: "s", buyerId: "b1", orderId: "o1", rating: 5, settledAmount: 1_000n, sellerBond: 0n, createdAt: base });
      r.record({ sellerId: "s", buyerId: "b2", orderId: "o2", rating: 4, settledAmount: 1_000n, sellerBond: 0n, createdAt: base + 40 * day });
      const s = r.score("s");
      assert.deepEqual(s, r.score("s", base + 40 * day, day));
      assert.equal(Math.round(s.accountAgeDays), 40);
      assert.deepEqual(calculateBayesianReputation([...r.listEvents()], "s"), s);
    }
  });

  it("x-uep-issued-at in Unix ms: the service API maps it to a height at the boundary; the Marketplace reads no clock", () => {
    const wall = 1_800_000_000_000;
    const m = new DigitalServicesMarketplace();
    const api = new UepServiceApi({ storageProviders: new Map([["memory", new MemoryStorageProvider()]]), marketplace: m, legacyWallClock: () => wall });
    const listing = publishAs(m, { providerId: "prov", title: "API", description: "x", category: "API", asset: "uep-test/teur", unitPrice: 10n, capacity: 5n });
    const order = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n });
    m.advanceHeight(100);
    const read = (issuedAt: number) => api.marketplaceGetOrder(order.orderId, { auth: { ...act(m, "buyer", "read", order.orderId, { issuedAt }), issuedAt } });
    assert.equal((read(100) as { ok: boolean }).ok, true); // v0.5.0 form: the height
    assert.equal((read(wall - 60_000) as { ok: boolean }).ok, true); // legacy: 1 min old -> 12 heights old
    const stale = read(wall - 10 * 60_000) as { ok: boolean; error?: { message: string } };
    assert.equal(stale.ok, false);
    assert.match(stale.error!.message, /ACTOR_AUTH_EXPIRED/);
    // In-process callers that bypass the service API must sign a height.
    assert.throws(() => m.getOrder(order.orderId, { ...act(m, "buyer", "read", order.orderId, { issuedAt: wall }), issuedAt: wall }), /ACTOR_AUTH_ISSUED_AT_UNIT/);
    assert.deepEqual((api.marketplaceHeight() as { data: unknown }).data, { height: 100, unit: "height", referenceBlockTimeMs: 5_000 });
    assert.equal(legacyMsToHeight(wall - 60_000, 100, wall), 88);
    assert.equal(legacyMsToHeight(wall + 9_999, 100, wall), 101);
    assert.ok(emittedDeprecations().includes("UEP_DEP_ISSUED_AT_MS"));
  });

  it("IoT: a Unix-ms observedAt is refused with a clear code in height mode (signed by the machine, not convertible)", () => {
    const m = new DigitalServicesMarketplace();
    const iot = new IoTM2MService(m);
    registerProviderAs(iot, { providerId: "prov", displayName: "p" });
    registerMachineAs(iot, { machineId: "m1", providerId: "prov", serviceType: "power-kwh", model: "SIM", endpointRef: "sim://m1" });
    const listing = publishAs(m, { providerId: "prov", title: "Power", description: "sim", category: IOT_M2M_CATEGORY, asset: "EUR", unitPrice: 100n, capacity: 10n });
    const r = requestAs(iot, { buyerId: "buyer", listingId: listing.listingId, machineId: "m1", quantity: 1n });
    holdAs(iot, r.requestId, "buyer");
    const t = simulateAs(iot, r.requestId, "m1", { kWh: "1.0" }, 1_800_000_000_000);
    assert.throws(() => { deliverTelemetryAs(iot, r.requestId, "prov", t); iot.verifyTelemetry(r.requestId, t); }, /IOT_TELEMETRY_OBSERVED_AT_UNIT/);
  });

  it("block producer: windows can pass in real time without any clock inside a transition", async () => {
    const ledger = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: false, faucetSigningKey: null });
    const producer = startBlockProducer({ advance: () => ledger.advanceHeight(), intervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    producer.stop();
    assert.equal(producer.running, false);
    const h = ledger.height;
    assert.ok(h >= 2, `height ${h}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(ledger.height, h);
  });
});
