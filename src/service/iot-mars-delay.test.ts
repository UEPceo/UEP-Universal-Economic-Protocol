/**
 * v0.5.0 (ADR 0002 rule 2): IoT telemetry that travels at light speed from
 * Mars settles when the listing declares the MARS domain profile, with no
 * window widened by hand. Earth-Mars one-way light time: 338.3 s minimum
 * and 1,203.6 s maximum between 2026-10 and 2028-12, computed offline from
 * the public JPL DE442s kernel. Flow: request and hold on Earth, the
 * machine observes on Mars, the report arrives after the light-time delay,
 * then delivery, verification and settlement.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { IoTM2MService, IOT_M2M_CATEGORY, DEFAULT_TELEMETRY_MAX_AGE_HEIGHTS } from "./iot-m2m.ts";
import { createTestAuthority, publishAs } from "../marketplace/testkit.ts";
import { deliverTelemetryAs, holdAs, registerMachineAs, registerProviderAs, requestAs, settleIoTAs, simulateAs } from "./iot-testkit.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { TESTNET } from "../network/profiles.ts";
import { heightsForMs } from "../core/height.ts";
import type { DomainProfileId } from "../core/domain-profiles.ts";

const ARBITER = createTestAuthority("iot-arbiter");
const ADMIN = createTestAuthority("iot-admin");
const LT_MIN_S = 338.3;
const LT_MAX_S = 1_203.6;

type Outcome = string;

/** Height mode: the Marketplace and the IoT service read the single-node testnet's height. */
function runHeights(profile: DomainProfileId | undefined, delayHeights: number): Outcome {
  const ledger = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: false, faucetSigningKey: null });
  const marketplace = new DigitalServicesMarketplace({ height: () => ledger.height, settlementArbiterId: "iot-arbiter", settlementArbiterPublicKey: ARBITER.publicKeyHex, adminIdentity: "iot-admin", adminPublicKey: ADMIN.publicKeyHex });
  const iot = new IoTM2MService(marketplace);
  return flow(marketplace, iot, profile, () => ledger.advanceHeight(delayHeights));
}

/** Pre-v0.5.0 setup (test-only legacy ms clock shared by both services); only the profile is added. */
function runLegacyMs(profile: DomainProfileId | undefined, delayS: number): Outcome {
  let now = 1_000_000_000;
  const marketplace = new DigitalServicesMarketplace({ now: () => now, settlementArbiterId: "iot-arbiter", settlementArbiterPublicKey: ARBITER.publicKeyHex, adminIdentity: "iot-admin", adminPublicKey: ADMIN.publicKeyHex });
  const iot = new IoTM2MService(marketplace, { now: () => now });
  return flow(marketplace, iot, profile, () => { now += Math.round(delayS * 1000); });
}

function flow(marketplace: DigitalServicesMarketplace, iot: IoTM2MService, profile: DomainProfileId | undefined, lightTravel: () => void): Outcome {
  registerProviderAs(iot, { providerId: "mars-provider", displayName: "Mars lab" });
  registerMachineAs(iot, { machineId: "mars-01", providerId: "mars-provider", serviceType: "power-kwh", model: "SIM", endpointRef: "sim://mars-01" });
  const listing = publishAs(marketplace, { providerId: "mars-provider", title: "Power", description: "sim", category: IOT_M2M_CATEGORY, asset: "EUR", unitPrice: 100n, capacity: 10n, ...(profile ? { domainProfile: profile } : {}) });
  const r = requestAs(iot, { buyerId: "earth-buyer", listingId: listing.listingId, machineId: "mars-01", quantity: 1n });
  holdAs(iot, r.requestId, "earth-buyer");
  const observedAt = marketplace.clock(); // the machine observes on Mars
  const t = simulateAs(iot, r.requestId, "mars-01", { kWh: "1.0" }, observedAt);
  lightTravel(); // the report reaches Earth after the light-time delay
  try {
    deliverTelemetryAs(iot, r.requestId, "mars-provider", t);
    const v = iot.verifyTelemetry(r.requestId, t);
    const s = settleIoTAs(iot, r.requestId, "earth-buyer");
    assert.equal(marketplace.valueAccounting("EUR").conserved, true);
    return `OK verified=${v.ok} settled=${s.outcome}`;
  } catch (e) {
    return `REJECTED ${(e as Error).message.split(":")[0]}`;
  }
}

const OK = "OK verified=true settled=RELEASE";

describe("IoT telemetry with Earth-Mars light-time delay (in heights)", () => {
  it("MARS profile: settles at the minimum (338.3 s) and maximum (1,203.6 s) one-way light time", () => {
    assert.equal(heightsForMs(LT_MIN_S * 1000), 68);
    assert.equal(heightsForMs(LT_MAX_S * 1000), 241);
    assert.equal(runHeights("MARS", heightsForMs(LT_MIN_S * 1000)), OK);
    assert.equal(runHeights("MARS", heightsForMs(LT_MAX_S * 1000)), OK);
  });

  it("EARTH profile keeps the previous behaviour: the same delays are rejected", () => {
    assert.equal(runHeights(undefined, 0), OK);
    assert.equal(runHeights("EARTH", heightsForMs(60_000)), OK);
    assert.equal(runHeights("EARTH", heightsForMs(LT_MIN_S * 1000)), "REJECTED IOT_TELEMETRY_STALE");
    assert.equal(runHeights("EARTH", heightsForMs(LT_MAX_S * 1000)), "REJECTED RESERVATION_EXPIRED");
  });

  it("MARS windows are fixed: telemetry age 60 + 602 heights, reservation 120 + 602; contact gaps are not covered", () => {
    assert.equal(DEFAULT_TELEMETRY_MAX_AGE_HEIGHTS, 60);
    assert.equal(runHeights("MARS", 662), OK);
    assert.equal(runHeights("MARS", 663), "REJECTED IOT_TELEMETRY_STALE");
    assert.equal(runHeights("MARS", 723), "REJECTED RESERVATION_EXPIRED");
    // Maximum light time plus one hour waiting for a contact window: outside the light-time windows.
    assert.equal(runHeights("MARS", heightsForMs((LT_MAX_S + 3_600) * 1000)), "REJECTED RESERVATION_EXPIRED");
  });

  it("MOON profile: about 1.3 s one-way fits in one delay height", () => {
    assert.equal(runHeights("MOON", heightsForMs(1_300)), OK);
    assert.equal(runHeights("MOON", 61), OK); // 60 + 1
    assert.equal(runHeights("MOON", 62), "REJECTED IOT_TELEMETRY_STALE");
  });

  it("pre-v0.5.0 setup (test-only ms clock): MARS passes at 338.3 s and 1,203.6 s, EARTH defaults unchanged", () => {
    assert.equal(runLegacyMs("MARS", LT_MIN_S), OK);
    assert.equal(runLegacyMs("MARS", LT_MAX_S), OK);
    assert.equal(runLegacyMs(undefined, 60), OK);
    assert.equal(runLegacyMs(undefined, LT_MIN_S), "REJECTED IOT_TELEMETRY_STALE");
    assert.equal(runLegacyMs(undefined, LT_MAX_S), "REJECTED RESERVATION_EXPIRED");
  });

  it("the IoT service follows the Marketplace height; a legacy `now` is ignored in height mode", () => {
    const marketplace = new DigitalServicesMarketplace();
    marketplace.advanceHeight(7);
    const legacy = new IoTM2MService(marketplace, { now: () => 1_800_000_000_000 });
    assert.equal(registerProviderAs(legacy, { providerId: "p-legacy", displayName: "legacy" }).registeredAt, 7);
    const iot = new IoTM2MService(new DigitalServicesMarketplace(), { telemetryMaxAgeHeights: 10 });
    assert.equal(iot.telemetryMaxAge, 10);
    assert.throws(() => new IoTM2MService(new DigitalServicesMarketplace(), { telemetryMaxAgeHeights: 1, telemetryMaxAgeMs: 1 }), /CLOCK_CONFIG_CONFLICT/);
  });
});
