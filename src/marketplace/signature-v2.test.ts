/**
 * 0.5.83 Block A: v2 signatures bound to network, domain, signer, nonce,
 * operation context and height window; v1 deprecation shim; snapshot migration.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DigitalServicesMarketplace } from "./marketplace.ts";
import { listingTerms, signActionV2, signReservation, signReservationV2 } from "./identity.ts";
import { act, createTestAuthority, enrollIdentity, publishAs, reserveAs, testCredit, testEnvelope as envelopeV2 } from "./testkit.ts";
import { LegacyV1Policy, MAX_V2_WINDOW_HEIGHTS, NonceRegistry } from "./signature-v2.ts";
import { IoTM2MService, IOT_M2M_CATEGORY, signIoTTelemetry } from "../service/iot-m2m.ts";
import { deliverTelemetryAs, holdAs, machineKey, registerMachineAs, registerProviderAs, requestAs, simulateAs } from "../service/iot-testkit.ts";

const ADMIN = createTestAuthority("v2-admin");
const ARB = createTestAuthority("v2-arbiter");

function mk(extra: ConstructorParameters<typeof DigitalServicesMarketplace>[0] = {}) {
  let now = 1_000_000;
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: () => now, adminIdentity: "v2-admin", adminPublicKey: ADMIN.publicKeyHex, settlementArbiterId: "v2-arbiter", settlementArbiterPublicKey: ARB.publicKeyHex, legacyV1Signatures: false, ...extra });
  return { m, advance(ms: number) { now += ms; } };
}

function setupListing(m: DigitalServicesMarketplace) {
  const listing = publishAs(m, { providerId: "prov", title: "t", description: "d", category: "compute", asset: "EUR", unitPrice: 10n, capacity: 100n });
  const buyer = enrollIdentity(m, "buyer");
  testCredit(m, "buyer", "EUR", 100_000n);
  return { listing, buyer };
}

describe("0.5.83 Block A: v2 signed payload", () => {
  it("full flow with v1 refused: publish + reserve signed v2", () => {
    const { m } = mk();
    const { listing } = setupListing(m);
    const order = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer", quantity: 1n });
    assert.equal(order.status, "ACCEPTED");
    assert.ok(m.signatureNonces.size >= 2);
  });

  it("rejects a v1 signature when the shim is off", () => {
    const { m } = mk();
    const { listing, buyer } = setupListing(m);
    const sig = signReservation({ marketplaceId: m.marketplaceId, listingId: listing.listingId, buyerId: "buyer", quantity: 1n, idempotencyKey: "k1" }, buyer.privateKey);
    assert.throws(() => m.reserve({ listingId: listing.listingId, buyerId: "buyer", quantity: 1n, idempotencyKey: "k1", signature: sig }), /LEGACY_V1_SIGNATURE_REFUSED/);
  });

  it("rejects a valid reservation signature replayed on another network", () => {
    const a = mk({ ledgerNetworkId: "uep-net-a" });
    const b = mk({ ledgerNetworkId: "uep-net-b" });
    const la = setupListing(a.m).listing;
    // same identity key on both, same listing id
    const buyer = enrollIdentity(a.m, "buyer");
    publishAs(b.m, { providerId: "prov", title: "t", description: "d", category: "compute", asset: "EUR", unitPrice: 10n, capacity: 100n });
    b.m.registerIdentity("buyer", buyer.publicKeyHex);
    const env = envelopeV2(a.m.clock());
    const r = { listingId: la.listingId, buyerId: "buyer", quantity: 1n, idempotencyKey: "x" };
    const sig = signReservationV2(a.m.bindingContext(), r, env, buyer.privateKey);
    assert.throws(() => b.m.reserve({ ...r, signature: sig, envelope: env }), /RESERVATION_SIGNATURE_INVALID/);
    testCredit(a.m, "buyer", "EUR", 1000n);
    assert.equal(a.m.reserve({ ...r, signature: sig, envelope: env }).status, "ACCEPTED");
  });

  it("rejects a valid action signature replayed in another domain (Marketplace id)", () => {
    const a = mk({ marketplaceId: "domain-A" });
    const b = mk({ marketplaceId: "domain-B" });
    const prov = enrollIdentity(a.m, "prov");
    b.m.registerIdentity("prov", prov.publicKeyHex);
    const input = { providerId: "prov", listingId: "L1", title: "t", description: "d", category: "compute", asset: "EUR", unitPrice: 10n, capacity: 5n };
    const auth = signActionV2(a.m.bindingContext(), { action: "publish", actorId: "prov", target: "L1", details: listingTerms(input) }, envelopeV2(a.m.clock()), prov.privateKey);
    assert.throws(() => b.m.publishListing(input, auth), /ACTOR_SIGNATURE_INVALID/);
    assert.equal(a.m.publishListing(input, auth).listingId, "L1");
  });

  it("rejects a different nonce (envelope tampered) and nonce reuse", () => {
    const { m } = mk();
    const prov = enrollIdentity(m, "prov");
    const input = { providerId: "prov", listingId: "L2", title: "t", description: "d", category: "compute", asset: "EUR", unitPrice: 10n, capacity: 5n };
    const env = envelopeV2(m.clock());
    const auth = signActionV2(m.bindingContext(), { action: "publish", actorId: "prov", target: "L2", details: listingTerms(input) }, env, prov.privateKey);
    assert.throws(() => m.publishListing(input, { ...auth, envelope: { ...env, nonce: "00".repeat(16) } }), /ACTOR_SIGNATURE_INVALID/);
    m.publishListing(input, auth);
    // same nonce, new correctly signed operation -> refused
    const auth2 = signActionV2(m.bindingContext(), { action: "delist", actorId: "prov", target: "L2", details: {} }, env, prov.privateKey);
    assert.throws(() => m.delistListing("L2", auth2), /SIGNATURE_V2_NONCE_REUSED/);
  });

  it("rejects the signature in another operation context (type, ids, amounts)", () => {
    const { m } = mk();
    const { listing, buyer } = setupListing(m);
    const env = envelopeV2(m.clock());
    const r = { listingId: listing.listingId, buyerId: "buyer", quantity: 1n, idempotencyKey: "ctx" };
    const sig = signReservationV2(m.bindingContext(), r, env, buyer.privateKey);
    assert.throws(() => m.reserve({ ...r, quantity: 2n, signature: sig, envelope: env }), /RESERVATION_SIGNATURE_INVALID/);
    assert.throws(() => m.reserve({ ...r, idempotencyKey: "other", signature: sig, envelope: env }), /RESERVATION_SIGNATURE_INVALID/);
    // a publish signature used as delist
    const prov = enrollIdentity(m, "prov");
    const auth = signActionV2(m.bindingContext(), { action: "publish", actorId: "prov", target: listing.listingId, details: {} }, envelopeV2(m.clock()), prov.privateKey);
    assert.throws(() => m.delistListing(listing.listingId, auth), /ACTOR_SIGNATURE_INVALID/);
  });

  it("enforces the height window (not yet valid, expired, too long)", () => {
    const { m, advance } = mk();
    const { listing, buyer } = setupListing(m);
    const h = m.clock();
    const r = { listingId: listing.listingId, buyerId: "buyer", quantity: 1n, idempotencyKey: "w" };
    const future = envelopeV2(h + 10, 10);
    assert.throws(() => m.reserve({ ...r, signature: signReservationV2(m.bindingContext(), r, future, buyer.privateKey), envelope: future }), /SIGNATURE_V2_NOT_YET_VALID/);
    const long = envelopeV2(h, MAX_V2_WINDOW_HEIGHTS + 1);
    assert.throws(() => m.reserve({ ...r, signature: signReservationV2(m.bindingContext(), r, long, buyer.privateKey), envelope: long }), /SIGNATURE_V2_WINDOW_TOO_LONG/);
    const short = envelopeV2(h, 1);
    const sig = signReservationV2(m.bindingContext(), r, short, buyer.privateKey);
    advance(5_000 * 10);
    assert.ok(m.clock() > h + 1);
    assert.throws(() => m.reserve({ ...r, signature: sig, envelope: short }), /SIGNATURE_V2_EXPIRED/);
  });

  it("the identical v2 reservation is idempotent, the nonce cannot open a second reservation", () => {
    const { m } = mk();
    const { listing, buyer } = setupListing(m);
    const env = envelopeV2(m.clock());
    const r = { listingId: listing.listingId, buyerId: "buyer", quantity: 1n, idempotencyKey: "idem" };
    const sig = signReservationV2(m.bindingContext(), r, env, buyer.privateKey);
    const o1 = m.reserve({ ...r, signature: sig, envelope: env });
    const o2 = m.reserve({ ...r, signature: sig, envelope: env });
    assert.equal(o1.orderId, o2.orderId);
    const r2 = { ...r, idempotencyKey: "idem-2" };
    assert.throws(() => m.reserve({ ...r2, signature: signReservationV2(m.bindingContext(), r2, env, buyer.privateKey), envelope: env }), /SIGNATURE_V2_NONCE_REUSED/);
  });

  it("nonces survive snapshot / restore (replay after restart refused); pre-0.5.83 snapshots migrate to an empty registry", () => {
    const { m } = mk();
    const prov = enrollIdentity(m, "prov");
    const input = { providerId: "prov", listingId: "L3", title: "t", description: "d", category: "compute", asset: "EUR", unitPrice: 10n, capacity: 5n };
    const env = envelopeV2(m.clock());
    m.publishListing(input, signActionV2(m.bindingContext(), { action: "publish", actorId: "prov", target: "L3", details: listingTerms(input) }, env, prov.privateKey));
    const snap = m.exportSnapshot();
    assert.ok(JSON.stringify((snap.state!.marketplace as Record<string, unknown>).signatureNonces).includes(env.nonce));
    const { m: m2 } = mk();
    m2.restoreSnapshot(snap, { snapshotPublicKeys: m.snapshotPublicKeys() });
    assert.equal(m2.signatureNonces.has("prov", env.nonce), true);
    const replay = signActionV2(m2.bindingContext(), { action: "delist", actorId: "prov", target: "L3", details: {} }, env, prov.privateKey);
    assert.throws(() => m2.delistListing("L3", replay), /SIGNATURE_V2_NONCE_REUSED/);
    assert.equal(NonceRegistry.fromJSON(undefined).size, 0);
    assert.throws(() => NonceRegistry.fromJSON("bad"), /SIGNATURE_V2_NONCES_INVALID/);
  });
});

describe("0.5.83 Block A: v1 deprecation shim", () => {
  it("accepts v1 below the sunset height with one warning, refuses at / after it", () => {
    const warnings: string[] = [];
    const p = new LegacyV1Policy({ sunsetHeight: 100, warn: (w) => warnings.push(w) });
    p.assertAllowed("reservation", 10); p.assertAllowed("reservation", 99);
    assert.equal(warnings.length, 1);
    assert.throws(() => p.assertAllowed("reservation", 100), /LEGACY_V1_SIGNATURE_SUNSET/);
    assert.throws(() => new LegacyV1Policy(false).assertAllowed("x", 0), /LEGACY_V1_SIGNATURE_REFUSED/);
  });

  it("is off by default under NODE_ENV=production", () => {
    // The production flag is injected (configuration time); no environment mutation in the test.
    assert.equal(new LegacyV1Policy(undefined, 0, 1, true).enabled, false);
    assert.equal(new LegacyV1Policy(undefined, 0, 1, false).enabled, true);
  });

  it("Marketplace: v1 accepted before sunset and refused after (height-based)", () => {
    const warnings: string[] = [];
    let now = 1_000_000;
    const m = new DigitalServicesMarketplace({ testOnlyNowMs: () => now, adminIdentity: "v2-admin", adminPublicKey: ADMIN.publicKeyHex });
    const sunset = m.clock() + 3;
    const m2 = new DigitalServicesMarketplace({ testOnlyNowMs: () => now, adminIdentity: "v2-admin", adminPublicKey: ADMIN.publicKeyHex, legacyV1Signatures: { sunsetHeight: sunset, warn: (w) => warnings.push(w) } });
    publishAs(m2, { providerId: "prov", listingId: "S1", title: "t", description: "d", category: "compute", asset: "EUR", unitPrice: 10n, capacity: 5n });
    assert.equal(warnings.length, 1);
    now += 5_000 * 10;
    assert.throws(() => m2.delistListing("S1", act(m2, "prov", "delist", "S1")), /LEGACY_V1_SIGNATURE_SUNSET/);
    assert.equal(m.legacyV1.enabled, true);
  });
});

describe("0.5.83 Block A: IoT telemetry v2", () => {
  function iotSetup(extra: ConstructorParameters<typeof DigitalServicesMarketplace>[0] = {}) {
    const { m, advance } = mk(extra);
    const iot = new IoTM2MService(m, { testOnlyNowMs: () => 1_000_000, telemetryMaxAgeMs: 60_000 });
    registerProviderAs(iot, { providerId: "iot-prov", displayName: "lab" });
    registerMachineAs(iot, { machineId: "mach-1", providerId: "iot-prov", serviceType: "s", model: "m", endpointRef: "sim://1" });
    const listing = publishAs(m, { providerId: "iot-prov", title: "t", description: "d", category: IOT_M2M_CATEGORY, asset: "EUR", unitPrice: 100n, capacity: 10n });
    return { m, iot, listing, advance };
  }

  it("v2 telemetry runs end to end with v1 refused", () => {
    const { iot, listing } = iotSetup();
    const r = requestAs(iot, { buyerId: "b", listingId: listing.listingId, machineId: "mach-1", quantity: 1n });
    holdAs(iot, r.requestId, "b");
    const t = simulateAs(iot, r.requestId, "mach-1", { status: "OK" });
    assert.equal(t.sigVersion, 2);
    deliverTelemetryAs(iot, r.requestId, "iot-prov", t);
    assert.equal(iot.verifyTelemetry(r.requestId, t).ok, true);
  });

  it("machine-signed v2 telemetry for another network or domain is refused; v1 telemetry is refused without the shim", () => {
    const { iot, listing, m } = iotSetup();
    const r = requestAs(iot, { buyerId: "b", listingId: listing.listingId, machineId: "mach-1", quantity: 1n });
    holdAs(iot, r.requestId, "b");
    const t = simulateAs(iot, r.requestId, "mach-1", { status: "OK" });
    const key = machineKey(iot, "mach-1");
    const base = { ...t, telemetryId: t.telemetryId + "-x", sequence: t.sequence + 1, nonce: "ab".repeat(16) };
    const otherNet = { ...base, networkId: "uep-other" }; otherNet.signature = signIoTTelemetry(otherNet, key);
    assert.throws(() => iot.ingestTelemetry(r.requestId, otherNet), /IOT_TELEMETRY_NETWORK_MISMATCH/);
    const otherDom = { ...base, domainId: "other-domain" }; otherDom.signature = signIoTTelemetry(otherDom, key);
    assert.throws(() => iot.ingestTelemetry(r.requestId, otherDom), /IOT_TELEMETRY_DOMAIN_MISMATCH/);
    const { sigVersion: _a, networkId: _b, domainId: _c, validUntilHeight: _d, ...v1 } = base; const v1s = { ...v1, signature: "" }; v1s.signature = signIoTTelemetry(v1s, key);
    assert.throws(() => iot.ingestTelemetry(r.requestId, v1s), /LEGACY_V1_SIGNATURE_REFUSED/);
    // a v2 report whose signed network was swapped after signing fails the signature
    const swapped = { ...otherNet, networkId: m.ledgerNetworkId };
    assert.throws(() => iot.ingestTelemetry(r.requestId, swapped), /IOT_TELEMETRY_SIGNATURE_INVALID/);
    // nonce reuse of the delivered report is refused
    const reuse = { ...base, nonce: t.nonce }; reuse.signature = signIoTTelemetry(reuse, key);
    assert.throws(() => iot.ingestTelemetry(r.requestId, reuse), /IOT_TELEMETRY_NONCE_REPLAY/);
  });
});
