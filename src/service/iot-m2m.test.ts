import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { createIoTMachineIdentity, IoTM2MService, IOT_M2M_CATEGORY } from "./iot-m2m.ts";
import { encodeCanonicalCbor } from "./iot-m2m-codec.ts";

function setup() {
  let now = 1_000_000;
  const marketplace = new DigitalServicesMarketplace({ now: () => now });
  const iot = new IoTM2MService(marketplace, { now: () => now, telemetryMaxAgeMs: 60_000 });
  iot.registerProvider({ providerId: "iot-provider-1", displayName: "UEP IoT Lab" });
  iot.registerMachine({ machineId: "machine-01", providerId: "iot-provider-1", serviceType: "temperature-sampling", model: "LAB-SENSOR-1", endpointRef: "sim://machine-01" });
  const listing = marketplace.publishListing({ providerId: "iot-provider-1", title: "Temperature sampling", description: "Simulated machine telemetry", category: IOT_M2M_CATEGORY, asset: "EUR", unitPrice: 100n, capacity: 10n });
  return { marketplace, iot, listing, advance(ms: number) { now += ms; } };
}

describe("UEP IoT/M2M service", () => {
  it("runs provider -> machine -> request -> contract -> HOLD -> telemetry -> verification -> settlement", () => {
    const { iot, listing } = setup();
    const requested = iot.requestService({ buyerId: "buyer-1", listingId: listing.listingId, machineId: "machine-01", quantity: 1n, idempotencyKey: "req-1" });
    assert.equal(requested.order.status, "ACCEPTED");
    assert.equal(requested.contract.machineId, "machine-01");
    const held = iot.hold(requested.requestId);
    assert.equal(held.status, "HELD");
    const telemetry = iot.simulateExecution(requested.requestId, { temperatureC: "21.50", status: "OK" });
    const delivered = iot.deliverTelemetry(requested.requestId, telemetry);
    assert.equal(delivered.status, "DELIVERED");
    const verification = iot.verifyTelemetry(requested.requestId, telemetry);
    assert.equal(verification.ok, true);
    const settled = iot.settle(requested.requestId);
    assert.equal(settled.requestId, requested.requestId);
    assert.equal(settled.machineId, "machine-01");
    assert.equal(settled.marketplaceFee, 3n);
    assert.equal(iot.marketplace.treasury.totalOf("EUR"), 3n);
  });

  it("is idempotent for repeated service requests", () => {
    const { iot, listing } = setup();
    const a = iot.requestService({ buyerId: "buyer-1", listingId: listing.listingId, machineId: "machine-01", quantity: 1n, idempotencyKey: "same" });
    const b = iot.requestService({ buyerId: "buyer-1", listingId: listing.listingId, machineId: "machine-01", quantity: 1n, idempotencyKey: "same" });
    assert.equal(a.requestId, b.requestId);
    assert.equal(a.order.orderId, b.order.orderId);
  });

  it("rejects unregistered providers and machines", () => {
    const { iot, listing } = setup();
    assert.throws(() => iot.registerProvider({ providerId: "iot-provider-1", displayName: "duplicate" }), /IOT_PROVIDER_ALREADY_REGISTERED/);
    assert.throws(() => iot.requestService({ buyerId: "buyer", listingId: listing.listingId, machineId: "missing", quantity: 1n }), /IOT_MACHINE_NOT_REGISTERED/);
  });

  it("rejects listing/provider or machine/provider mismatches", () => {
    const { iot, marketplace } = setup();
    iot.registerProvider({ providerId: "provider-2", displayName: "Other" });
    iot.registerMachine({ machineId: "machine-02", providerId: "provider-2", serviceType: "temperature-sampling", model: "OTHER", endpointRef: "sim://machine-02" });
    const listing = marketplace.publishListing({ providerId: "iot-provider-1", title: "Humidity", description: "Humidity sample", category: IOT_M2M_CATEGORY, asset: "EUR", unitPrice: 50n, capacity: 2n });
    assert.throws(() => iot.requestService({ buyerId: "buyer", listingId: listing.listingId, machineId: "machine-02", quantity: 1n }), /MACHINE_PROVIDER_MISMATCH/);
  });

  it("requires HOLD before simulated execution and verification before settlement", () => {
    const { iot, listing } = setup();
    const r = iot.requestService({ buyerId: "buyer", listingId: listing.listingId, machineId: "machine-01", quantity: 1n });
    assert.throws(() => iot.simulateExecution(r.requestId, { status: "OK" }), /IOT_EXECUTION_REQUIRES_HOLD/);
    iot.hold(r.requestId);
    const t = iot.simulateExecution(r.requestId, { status: "OK" });
    assert.throws(() => iot.settle(r.requestId), /IOT_VERIFICATION_REQUIRED/);
    iot.deliverTelemetry(r.requestId, t);
    iot.verifyTelemetry(r.requestId, t);
    assert.equal(iot.settle(r.requestId).marketplaceFee, 3n);
  });

  it("rejects telemetry tampering, wrong machine and replayed sequence", () => {
    const { iot, listing } = setup();
    const r = iot.requestService({ buyerId: "buyer", listingId: listing.listingId, machineId: "machine-01", quantity: 1n });
    iot.hold(r.requestId);
    const t = iot.simulateExecution(r.requestId, { status: "OK" });
    const tampered = { ...t, measurements: { status: "FAIL" } };
    assert.throws(() => iot.verifyTelemetry(r.requestId, tampered), /IOT_TELEMETRY_TAMPERED/);
    const wrongMachine = { ...t, machineId: "machine-x" };
    assert.throws(() => iot.verifyTelemetry(r.requestId, wrongMachine), /IOT_TELEMETRY_MACHINE_MISMATCH/);
    iot.verifyTelemetry(r.requestId, t);
    assert.throws(() => iot.verifyTelemetry(r.requestId, t), /IOT_TELEMETRY_SEQUENCE_REPLAY/);
  });

  it("rejects telemetry from another request/contract and stale telemetry", () => {
    const { iot, listing, advance } = setup();
    const r1 = iot.requestService({ buyerId: "buyer-1", listingId: listing.listingId, machineId: "machine-01", quantity: 1n });
    iot.hold(r1.requestId);
    const t = iot.simulateExecution(r1.requestId, { status: "OK" });
    const r2 = iot.requestService({ buyerId: "buyer-2", listingId: listing.listingId, machineId: "machine-01", quantity: 1n });
    iot.hold(r2.requestId);
    assert.throws(() => iot.verifyTelemetry(r2.requestId, t), /IOT_TELEMETRY_REQUEST_MISMATCH/);
    advance(61_000);
    assert.throws(() => iot.verifyTelemetry(r1.requestId, t), /IOT_TELEMETRY_STALE/);
  });

  it("settlement is replay-safe and charges the marketplace fee once", () => {
    const { iot, listing } = setup();
    const r = iot.requestService({ buyerId: "buyer", listingId: listing.listingId, machineId: "machine-01", quantity: 1n });
    iot.hold(r.requestId);
    const t = iot.simulateExecution(r.requestId, { status: "OK" });
    iot.deliverTelemetry(r.requestId, t);
    iot.verifyTelemetry(r.requestId, t);
    const first = iot.settle(r.requestId);
    const second = iot.settle(r.requestId);
    assert.deepEqual(second, first);
    assert.equal(iot.marketplace.treasury.totalOf("EUR"), 3n);
  });
});


describe("UEP IoT/M2M hardening", () => {
  it("authenticates machine telemetry with Ed25519 when a public key is registered", () => {
    let now = 2_000_000;
    const marketplace = new DigitalServicesMarketplace({ now: () => now });
    const iot = new IoTM2MService(marketplace, { now: () => now });
    const identity = createIoTMachineIdentity();
    iot.registerProvider({ providerId: "signed-provider", displayName: "Signed IoT" });
    iot.registerMachine({ machineId: "signed-machine", providerId: "signed-provider", serviceType: "temperature", model: "SIGNED-1", endpointRef: "sim://signed", publicKeyHex: identity.publicKeyHex });
    const listing = marketplace.publishListing({ providerId: "signed-provider", title: "Signed temperature", description: "Signed telemetry", category: IOT_M2M_CATEGORY, asset: "EUR", unitPrice: 100n, capacity: 2n });
    const r = iot.requestService({ buyerId: "buyer", listingId: listing.listingId, machineId: "signed-machine", quantity: 1n });
    iot.hold(r.requestId);
    const telemetry = iot.simulateExecution(r.requestId, { temperatureC: "21.50" }, now, identity.privateKey);
    const verification = iot.verifyTelemetry(r.requestId, telemetry);
    assert.equal(verification.authentication, "ED25519");
    assert.throws(() => iot.verifyTelemetry(r.requestId, telemetry), /IOT_TELEMETRY_SEQUENCE_REPLAY/);
  });

  it("rejects unsigned telemetry for cryptographically registered machines", () => {
    const { iot, listing } = setup();
    const identity = createIoTMachineIdentity();
    // Register a second machine with a real Ed25519 identity.
    iot.registerMachine({ machineId: "signed-machine", providerId: "iot-provider-1", serviceType: "temperature", model: "SIGNED-1", endpointRef: "sim://signed", publicKeyHex: identity.publicKeyHex });
    const r = iot.requestService({ buyerId: "buyer", listingId: listing.listingId, machineId: "signed-machine", quantity: 1n });
    iot.hold(r.requestId);
    assert.throws(() => iot.simulateExecution(r.requestId, { status: "OK" }), /IOT_SIGNED_TELEMETRY_REQUIRED/);
  });

  it("uses deterministic CBOR for the telemetry payload and exposes clear next actions", () => {
    const { iot, listing } = setup();
    const r = iot.requestService({ buyerId: "buyer", listingId: listing.listingId, machineId: "machine-01", quantity: 1n });
    assert.equal(iot.serviceStatus(r.requestId).nextAction, "HOLD");
    iot.hold(r.requestId);
    const t = iot.simulateExecution(r.requestId, { temperatureC: "21.50", status: "OK" });
    const cbor = encodeCanonicalCbor({ requestId: t.requestId, contractId: t.contractId, providerId: t.providerId, machineId: t.machineId, sequence: t.sequence, observedAt: t.observedAt, nonce: t.nonce, measurements: t.measurements });
    const json = Buffer.from(JSON.stringify({ requestId: t.requestId, contractId: t.contractId, providerId: t.providerId, machineId: t.machineId, sequence: t.sequence, observedAt: t.observedAt, nonce: t.nonce, measurements: t.measurements }));
    assert.ok(cbor.length < json.length);
    iot.deliverTelemetry(r.requestId, t);
    assert.equal(iot.serviceStatus(r.requestId).nextAction, "VERIFY_TELEMETRY");
  });

  it("enforces the tighter future timestamp window", () => {
    const { iot, listing } = setup();
    const r = iot.requestService({ buyerId: "buyer", listingId: listing.listingId, machineId: "machine-01", quantity: 1n });
    iot.hold(r.requestId);
    const t = iot.simulateExecution(r.requestId, { status: "OK" }, 1_030_001);
    assert.throws(() => iot.verifyTelemetry(r.requestId, t), /IOT_TELEMETRY_FUTURE_TIMESTAMP/);
  });
});
