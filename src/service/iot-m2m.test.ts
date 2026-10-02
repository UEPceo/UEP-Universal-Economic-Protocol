import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { createIoTMachineIdentity, IoTM2MService, IOT_M2M_CATEGORY, signIoTTelemetry, iotTelemetryDeliveryHash } from "./iot-m2m.ts";
import { encodeCanonicalCbor } from "./iot-m2m-codec.ts";
import { act, createTestAuthority, disputeAs, enrollIdentity, getOrder, iotAuthorization, publishAs, reserveAs, resolveAs, settle } from "../marketplace/testkit.ts";
import { contentHash } from "./content-hash.ts";
import { deliverTelemetryAs, holdAs, machineKey, registerMachineAs, registerProviderAs, requestAs, settleIoTAs, simulateAs, statusAs } from "./iot-testkit.ts";

const ARBITER = createTestAuthority("iot-arbiter");
const ADMIN = createTestAuthority("iot-admin");

function setup(config: ConstructorParameters<typeof DigitalServicesMarketplace>[0] = {}) {
  let now = 1_000_000;
  const marketplace = new DigitalServicesMarketplace({ now: () => now, settlementArbiterId: "iot-arbiter", settlementArbiterPublicKey: ARBITER.publicKeyHex, adminIdentity: "iot-admin", adminPublicKey: ADMIN.publicKeyHex, ...config });
  const iot = new IoTM2MService(marketplace, { now: () => now, telemetryMaxAgeMs: 60_000 });
  registerProviderAs(iot, { providerId: "iot-provider-1", displayName: "UEP IoT Lab" });
  registerMachineAs(iot, { machineId: "machine-01", providerId: "iot-provider-1", serviceType: "temperature-sampling", model: "LAB-SENSOR-1", endpointRef: "sim://machine-01" });
  const listing = publishAs(marketplace, { providerId: "iot-provider-1", title: "Temperature sampling", description: "Simulated machine telemetry", category: IOT_M2M_CATEGORY, asset: "EUR", unitPrice: 100n, capacity: 10n });
  return { marketplace, iot, listing, advance(ms: number) { now += ms; } };
}

/** request -> hold -> machine-signed execution -> provider-signed delivery. */
function runToDelivery(iot: IoTM2MService, listingId: string, buyerId: string, opts: { quantity?: bigint; units?: bigint } = {}) {
  const r = requestAs(iot, { buyerId, listingId, machineId: "machine-01", quantity: opts.quantity ?? 1n });
  holdAs(iot, r.requestId, buyerId);
  const t = simulateAs(iot, r.requestId, "machine-01", { status: "OK" }, undefined, opts.units);
  deliverTelemetryAs(iot, r.requestId, "iot-provider-1", t);
  return { r, t };
}

describe("UEP IoT/M2M service", () => {
  it("runs provider -> machine -> request -> contract -> HOLD -> telemetry -> verification -> settlement", () => {
    const { iot, listing } = setup();
    const requested = requestAs(iot, { buyerId: "buyer-1", listingId: listing.listingId, machineId: "machine-01", quantity: 1n, idempotencyKey: "req-1" });
    assert.equal(requested.order.status, "ACCEPTED");
    assert.equal(requested.contract.machineId, "machine-01");
    const held = holdAs(iot, requested.requestId, "buyer-1");
    assert.equal(held.status, "HELD");
    assert.equal(held.heldAmount, 100n); // gross 100: the 1% deposit locked at request time counts toward it
    assert.equal(iot.marketplace.availableBalance("EUR", "buyer-1"), 10_000n - 100n);
    const telemetry = simulateAs(iot, requested.requestId, "machine-01", { temperatureC: "21.50", status: "OK" });
    const delivered = deliverTelemetryAs(iot, requested.requestId, "iot-provider-1", telemetry);
    assert.equal(delivered.status, "DELIVERED");
    const verification = iot.verifyTelemetry(requested.requestId, telemetry);
    assert.equal(verification.ok, true);
    assert.equal(verification.authentication, "ED25519");
    assert.equal(verification.fullyDelivered, true);
    const settled = settleIoTAs(iot, requested.requestId, "buyer-1");
    assert.equal(settled.requestId, requested.requestId);
    assert.equal(settled.machineId, "machine-01");
    assert.equal(settled.marketplaceFee, 3n);
    assert.equal(iot.marketplace.treasury.totalOf("EUR"), 3n);
    assert.equal(iot.marketplace.valueAccounting("EUR").conserved, true);
  });

  it("is idempotent for repeated service requests", () => {
    const { iot, listing } = setup();
    const a = requestAs(iot, { buyerId: "buyer-1", listingId: listing.listingId, machineId: "machine-01", quantity: 1n, idempotencyKey: "same" });
    const b = requestAs(iot, { buyerId: "buyer-1", listingId: listing.listingId, machineId: "machine-01", quantity: 1n, idempotencyKey: "same" });
    assert.equal(a.requestId, b.requestId);
    assert.equal(a.order.orderId, b.order.orderId);
  });

  it("rejects unregistered providers and machines", () => {
    const { iot, listing } = setup();
    assert.throws(() => registerProviderAs(iot, { providerId: "iot-provider-1", displayName: "duplicate" }), /IOT_PROVIDER_ALREADY_REGISTERED/);
    assert.throws(() => requestAs(iot, { buyerId: "buyer", listingId: listing.listingId, machineId: "missing", quantity: 1n }), /IOT_MACHINE_NOT_REGISTERED/);
  });

  it("rejects listing/provider or machine/provider mismatches", () => {
    const { iot, marketplace } = setup();
    registerProviderAs(iot, { providerId: "provider-2", displayName: "Other" });
    registerMachineAs(iot, { machineId: "machine-02", providerId: "provider-2", serviceType: "temperature-sampling", model: "OTHER", endpointRef: "sim://machine-02" });
    const listing = publishAs(marketplace, { providerId: "iot-provider-1", title: "Humidity", description: "Humidity sample", category: IOT_M2M_CATEGORY, asset: "EUR", unitPrice: 50n, capacity: 2n });
    assert.throws(() => requestAs(iot, { buyerId: "buyer", listingId: listing.listingId, machineId: "machine-02", quantity: 1n }), /MACHINE_PROVIDER_MISMATCH/);
  });

  it("requires HOLD before simulated execution and verification before settlement", () => {
    const { iot, listing } = setup();
    const r = requestAs(iot, { buyerId: "buyer", listingId: listing.listingId, machineId: "machine-01", quantity: 1n });
    assert.throws(() => simulateAs(iot, r.requestId, "machine-01", { status: "OK" }), /IOT_EXECUTION_REQUIRES_HOLD/);
    holdAs(iot, r.requestId, "buyer");
    const t = simulateAs(iot, r.requestId, "machine-01", { status: "OK" });
    assert.throws(() => settleIoTAs(iot, r.requestId, "buyer"), /IOT_VERIFICATION_REQUIRED/);
    deliverTelemetryAs(iot, r.requestId, "iot-provider-1", t);
    iot.verifyTelemetry(r.requestId, t);
    assert.equal(settleIoTAs(iot, r.requestId, "buyer").marketplaceFee, 3n);
  });

  it("rejects telemetry tampering, wrong machine and replayed sequence", () => {
    const { iot, listing } = setup();
    const { r, t } = runToDelivery(iot, listing.listingId, "buyer");
    const tampered = { ...t, measurements: { status: "FAIL" } };
    assert.throws(() => iot.verifyTelemetry(r.requestId, tampered), /IOT_TELEMETRY_TAMPERED/);
    const wrongMachine = { ...t, machineId: "machine-x" };
    assert.throws(() => iot.verifyTelemetry(r.requestId, wrongMachine), /IOT_TELEMETRY_MACHINE_MISMATCH/);
    iot.verifyTelemetry(r.requestId, t);
    assert.throws(() => iot.verifyTelemetry(r.requestId, t), /IOT_TELEMETRY_SEQUENCE_REPLAY/);
  });

  it("rejects telemetry from another request/contract and stale telemetry", () => {
    const { iot, listing, advance } = setup();
    const { r: r1, t } = runToDelivery(iot, listing.listingId, "buyer-1");
    const r2 = requestAs(iot, { buyerId: "buyer-2", listingId: listing.listingId, machineId: "machine-01", quantity: 1n });
    holdAs(iot, r2.requestId, "buyer-2");
    assert.throws(() => iot.verifyTelemetry(r2.requestId, t), /IOT_TELEMETRY_REQUEST_MISMATCH/);
    advance(61_000);
    assert.throws(() => iot.verifyTelemetry(r1.requestId, t), /IOT_TELEMETRY_STALE/);
  });

  it("settlement is replay-safe and charges the marketplace fee once", () => {
    const { iot, listing } = setup();
    const { r, t } = runToDelivery(iot, listing.listingId, "buyer");
    iot.verifyTelemetry(r.requestId, t);
    const first = settleIoTAs(iot, r.requestId, "buyer");
    const second = settleIoTAs(iot, r.requestId, "buyer");
    assert.deepEqual(second, first);
    assert.equal(iot.marketplace.treasury.totalOf("EUR"), 3n);
  });
});

describe("UEP IoT/M2M hardening", () => {
  it("authenticates machine telemetry with Ed25519 (a registered machine key is mandatory)", () => {
    const { iot, listing } = setup();
    assert.throws(() => iot.registerMachine({ machineId: "no-key", providerId: "iot-provider-1", serviceType: "t", model: "m", endpointRef: "sim://x" } as never, act(iot.marketplace, "iot-provider-1", "iot-machine-register", "no-key")), /IOT_MACHINE_PUBLIC_KEY_REQUIRED/);
    const { r, t } = runToDelivery(iot, listing.listingId, "buyer");
    const verification = iot.verifyTelemetry(r.requestId, t);
    assert.equal(verification.authentication, "ED25519");
    assert.throws(() => iot.verifyTelemetry(r.requestId, t), /IOT_TELEMETRY_SEQUENCE_REPLAY/);
  });

  it("rejects unsigned telemetry and telemetry signed by another key (UEP-B13)", () => {
    const { iot, listing } = setup();
    const r = requestAs(iot, { buyerId: "buyer", listingId: listing.listingId, machineId: "machine-01", quantity: 1n });
    holdAs(iot, r.requestId, "buyer");
    assert.throws(() => iot.simulateExecution(r.requestId, { status: "OK" }), /IOT_SIGNED_TELEMETRY_REQUIRED/);
    // A key that is not the machine's registered key.
    assert.throws(() => iot.simulateExecution(r.requestId, { status: "OK" }, undefined, createIoTMachineIdentity().privateKey), /IOT_TELEMETRY_SIGNATURE_INVALID/);
    // Externally produced reports: unsigned, or signed by a foreign key.
    const t = simulateAs(iot, r.requestId, "machine-01", { status: "OK" });
    const forged = { ...t, telemetryId: "telemetry_forged", sequence: t.sequence + 1, nonce: "ab".repeat(16) };
    const { signature: _s, ...unsigned } = forged;
    assert.throws(() => iot.ingestTelemetry(r.requestId, unsigned), /IOT_TELEMETRY_SIGNATURE_INVALID/);
    const foreign = { ...forged, signature: signIoTTelemetry(unsigned, createIoTMachineIdentity().privateKey) };
    assert.throws(() => iot.ingestTelemetry(r.requestId, foreign), /IOT_TELEMETRY_SIGNATURE_INVALID/);
    assert.throws(() => deliverTelemetryAs(iot, r.requestId, "iot-provider-1", foreign), /IOT_TELEMETRY_SIGNATURE_INVALID/);
  });

  it("rejects replayed nonces even under a new sequence", () => {
    const { iot, listing } = setup();
    const { r, t } = runToDelivery(iot, listing.listingId, "buyer");
    const replay = { ...t, telemetryId: "telemetry_replay", sequence: t.sequence + 5 };
    const { signature: _s, ...unsigned } = replay;
    // Correctly signed by the machine key, fresh sequence, but a nonce that was already used.
    const signed = { ...replay, signature: signIoTTelemetry(unsigned, machineKey(iot, "machine-01")) };
    assert.throws(() => iot.ingestTelemetry(r.requestId, signed), /IOT_TELEMETRY_NONCE_REPLAY/);
  });

  it("uses deterministic CBOR for the telemetry payload and exposes clear next actions", () => {
    const { iot, listing } = setup();
    const r = requestAs(iot, { buyerId: "buyer", listingId: listing.listingId, machineId: "machine-01", quantity: 1n });
    assert.equal(statusAs(iot, r.requestId, "buyer").nextAction, "HOLD");
    holdAs(iot, r.requestId, "buyer");
    const t = simulateAs(iot, r.requestId, "machine-01", { temperatureC: "21.50", status: "OK" });
    const fields = { requestId: t.requestId, contractId: t.contractId, providerId: t.providerId, machineId: t.machineId, sequence: t.sequence, observedAt: t.observedAt, nonce: t.nonce, measurements: t.measurements, unitsDelivered: t.unitsDelivered };
    const cbor = encodeCanonicalCbor(fields);
    const json = Buffer.from(JSON.stringify(fields));
    assert.ok(cbor.length < json.length);
    deliverTelemetryAs(iot, r.requestId, "iot-provider-1", t);
    assert.equal(statusAs(iot, r.requestId, "buyer").nextAction, "VERIFY_TELEMETRY");
    // Status is order data: only parties (or the admin) can read it.
    assert.throws(() => statusAs(iot, r.requestId, "stranger"), /ORDER_ACCESS_FORBIDDEN/);
    assert.throws(() => iot.serviceStatus(r.requestId), /ACTOR_SIGNATURE_REQUIRED|ACTOR_AUTH_ISSUED_AT_REQUIRED/);
  });

  it("enforces the tighter future timestamp window", () => {
    const { iot, listing } = setup();
    const r = requestAs(iot, { buyerId: "buyer", listingId: listing.listingId, machineId: "machine-01", quantity: 1n });
    holdAs(iot, r.requestId, "buyer");
    const t = simulateAs(iot, r.requestId, "machine-01", { status: "OK" }, 1_030_001);
    deliverTelemetryAs(iot, r.requestId, "iot-provider-1", t);
    assert.throws(() => iot.verifyTelemetry(r.requestId, t), /IOT_TELEMETRY_FUTURE_TIMESTAMP/);
  });
});

describe("IoT settlement is based on verified telemetry", () => {
  it("normal settle of an IoT order is blocked without verified telemetry (also via the marketplace)", () => {
    const { iot, listing, marketplace } = setup();
    const { r } = runToDelivery(iot, listing.listingId, "buyer");
    const orderId = iot.orderIdOf(r.requestId);
    assert.throws(() => settle(marketplace, orderId, "buyer"), /IOT_VERIFICATION_REQUIRED/);
    // An IoT-category order reserved directly on the marketplace (no IoT request) cannot be released either.
    const direct = reserveAs(marketplace, { listingId: listing.listingId, buyerId: "direct", quantity: 1n });
    marketplace.fundOrder(direct.orderId, direct.fundingDue, act(marketplace, "direct", "fund", direct.orderId, { amount: direct.fundingDue }));
    const bytes = Buffer.from("not telemetry");
    marketplace.deliver(direct.orderId, act(marketplace, "iot-provider-1", "deliver", direct.orderId, { deliveryHash: contentHash(bytes) }), bytes);
    assert.throws(() => settle(marketplace, direct.orderId, "direct"), /IOT_VERIFIED_TELEMETRY_REQUIRED/);
    // An IoT listing on a marketplace without an attached IoT service never releases normally.
    const bare = new DigitalServicesMarketplace();
    const l2 = publishAs(bare, { providerId: "p", title: "iot", description: "iot", category: IOT_M2M_CATEGORY, asset: "EUR", unitPrice: 10n, capacity: 1n });
    const o2 = reserveAs(bare, { listingId: l2.listingId, buyerId: "b", quantity: 1n });
    bare.fundOrder(o2.orderId, o2.fundingDue, act(bare, "b", "fund", o2.orderId, { amount: o2.fundingDue }));
    bare.deliver(o2.orderId, act(bare, "p", "deliver", o2.orderId, { deliveryHash: contentHash(bytes) }), bytes);
    assert.throws(() => settle(bare, o2.orderId, "b"), /IOT_SETTLEMENT_GUARD_REQUIRED/);
  });

  it("verification only accepts the report delivered to the order", () => {
    const { iot, listing } = setup();
    const r = requestAs(iot, { buyerId: "buyer", listingId: listing.listingId, machineId: "machine-01", quantity: 1n });
    holdAs(iot, r.requestId, "buyer");
    const t = simulateAs(iot, r.requestId, "machine-01", { status: "OK" });
    assert.throws(() => iot.verifyTelemetry(r.requestId, t), /IOT_TELEMETRY_NOT_DELIVERED/);
    // Delivery needs the provider's signature over the report's hash.
    assert.throws(() => iot.deliverTelemetry(r.requestId, t, act(iot.marketplace, "buyer", "deliver", iot.orderIdOf(r.requestId), { deliveryHash: iotTelemetryDeliveryHash(t) })), /PROVIDER_NOT_AUTHORIZED/);
    assert.throws(() => iot.deliverTelemetry(r.requestId, t, act(iot.marketplace, "iot-provider-1", "deliver", iot.orderIdOf(r.requestId), { deliveryHash: "00".repeat(32) })), /ACTOR_SIGNATURE_INVALID/);
  });

  it("a usage shortfall blocks release; the arbiter splits by verified units and value is conserved", () => {
    const { iot, listing, marketplace } = setup();
    const { r, t } = runToDelivery(iot, listing.listingId, "buyer", { quantity: 4n, units: 3n });
    const v = iot.verifyTelemetry(r.requestId, t);
    assert.equal(v.unitsDelivered, 3n);
    assert.equal(v.fullyDelivered, false);
    assert.equal(statusAs(iot, r.requestId, "buyer").nextAction, "DISPUTE_USAGE_SHORTFALL");
    assert.throws(() => settleIoTAs(iot, r.requestId, "buyer"), /IOT_USAGE_SHORTFALL/);
    const orderId = iot.orderIdOf(r.requestId);
    disputeAs(marketplace, "buyer", orderId, "machine reported 3 of 4 units");
    const providerAmount = statusAs(iot, r.requestId, "buyer").verifiedUsageAmount!;
    assert.equal(providerAmount, 300n);
    const s = resolveAs(marketplace, "iot-arbiter", orderId, { outcome: "SPLIT", providerAmount });
    assert.equal(s.outcome, "SPLIT");
    assert.equal(s.marketplaceFee, 9n); // 3% of 300
    assert.equal(s.providerPayout, 291n);
    assert.equal(s.buyerRefund, 100n);
    assert.equal(marketplace.availableBalance("EUR", "buyer"), 10_000n - 300n);
    assert.equal(marketplace.valueAccounting("EUR").conserved, true);
    assert.equal(getOrder(marketplace, orderId, "buyer").status, "SETTLED");
  });

  it("units above the contracted quantity are rejected", () => {
    const { iot, listing } = setup();
    const r = requestAs(iot, { buyerId: "buyer", listingId: listing.listingId, machineId: "machine-01", quantity: 1n });
    holdAs(iot, r.requestId, "buyer");
    assert.throws(() => simulateAs(iot, r.requestId, "machine-01", { status: "OK" }, undefined, 2n), /IOT_TELEMETRY_UNITS_INVALID/);
  });
});

describe("IoT authorization hardening", () => {
  it("requires an authenticated buyer, provider (after the window) or arbiter to settle", () => {
    const { iot, listing } = setup();
    const { r, t } = runToDelivery(iot, listing.listingId, "buyer");
    iot.verifyTelemetry(r.requestId, t);
    assert.throws(() => iot.settle(r.requestId), /ACTOR_SIGNATURE_REQUIRED/);
    assert.throws(() => iot.settle(r.requestId, "buyer" as never), /ACTOR_SIGNATURE_REQUIRED/);
    assert.throws(() => settleIoTAs(iot, r.requestId, "attacker"), /SETTLEMENT_NOT_AUTHORIZED/);
    assert.throws(() => settleIoTAs(iot, r.requestId, "iot-provider-1"), /SETTLEMENT_DISPUTE_WINDOW_ACTIVE/);
    assert.equal(settleIoTAs(iot, r.requestId, "buyer").grossAmount, 100n);
  });

  it("providers and machines are registered with the provider's signature", () => {
    const m = new DigitalServicesMarketplace();
    const iot = new IoTM2MService(m);
    assert.throws(() => iot.registerProvider({ providerId: "p", displayName: "P" }), /IDENTITY_NOT_REGISTERED/);
    enrollIdentity(m, "p");
    assert.throws(() => iot.registerProvider({ providerId: "p", displayName: "P" }), /ACTOR_SIGNATURE_REQUIRED/);
    assert.throws(() => iot.registerProvider({ providerId: "p", displayName: "P" }, act(m, "mallory", "iot-provider-register", "p", { displayName: "P" })), /IOT_PROVIDER_NOT_AUTHORIZED/);
    registerProviderAs(iot, { providerId: "p", displayName: "P" });
    const key = createIoTMachineIdentity();
    const input = { machineId: "m", providerId: "p", serviceType: "x", model: "m1", endpointRef: "sim://m", publicKeyHex: key.publicKeyHex };
    assert.throws(() => iot.registerMachine(input, act(m, "mallory", "iot-machine-register", "m", {})), /ACTOR_SIGNATURE_INVALID|IOT_PROVIDER_NOT_AUTHORIZED/);
    assert.throws(() => iot.registerMachine({ ...input, publicKeyHex: "00" }, act(m, "p", "iot-machine-register", "m", {})), /IOT_MACHINE_PUBLIC_KEY_INVALID/);
    assert.ok(registerMachineAs(iot, { ...input, privateKey: key.privateKey }));
  });

  it("requires the admin signature to deactivate a provider; the provider may deactivate its machine", () => {
    const unconfigured = new IoTM2MService(new DigitalServicesMarketplace());
    registerProviderAs(unconfigured, { providerId: "p", displayName: "P" });
    registerMachineAs(unconfigured, { machineId: "m", providerId: "p", serviceType: "x", model: "m1", endpointRef: "sim://m" });
    assert.throws(() => unconfigured.deactivateMachine("m", act(unconfigured.marketplace, "attacker", "iot-machine-deactivate", "m")), /IOT_ADMIN_AUTH_REQUIRED/);
    assert.throws(() => unconfigured.deactivateMachine("m"), /IOT_ADMIN_AUTH_REQUIRED/);
    assert.throws(() => unconfigured.deactivateProvider("p", act(unconfigured.marketplace, "p", "iot-provider-deactivate", "p")), /IOT_ADMIN_AUTH_REQUIRED/);

    const { iot } = setup();
    registerProviderAs(iot, { providerId: "p", displayName: "P" });
    registerMachineAs(iot, { machineId: "m", providerId: "p", serviceType: "x", model: "m1", endpointRef: "sim://m" });
    registerMachineAs(iot, { machineId: "m3", providerId: "p", serviceType: "x", model: "m1", endpointRef: "sim://m3" });
    assert.throws(() => iot.deactivateProvider("p", act(iot.marketplace, "attacker", "iot-provider-deactivate", "p")), /IOT_ADMIN_AUTH_REQUIRED/);
    iot.deactivateMachine("m3", act(iot.marketplace, "p", "iot-machine-deactivate", "m3"));
    iot.deactivateMachine("m", act(iot.marketplace, "iot-admin", "iot-machine-deactivate", "m"));
    iot.deactivateProvider("p", act(iot.marketplace, "iot-admin", "iot-provider-deactivate", "p"));
    assert.throws(() => registerMachineAs(iot, { machineId: "m2", providerId: "p", serviceType: "x", model: "m1", endpointRef: "sim://m2" }), /IOT_PROVIDER_INACTIVE/);
  });

  it("IoT hold funds the remainder after the locked reservation deposit", () => {
    const { iot, marketplace } = setup({ reservationDeposit: 25n });
    const listing = publishAs(marketplace, { providerId: "iot-provider-1", title: "iot", description: "iot", category: IOT_M2M_CATEGORY, asset: "EUR", unitPrice: 100n, capacity: 1n });
    const r = requestAs(iot, { buyerId: "buyer", listingId: listing.listingId, machineId: "machine-01", quantity: 1n });
    assert.equal(r.order.reservationDeposit, 25n);
    assert.equal(marketplace.lockedDeposit("EUR", "buyer"), 25n);
    assert.throws(() => iot.hold(r.requestId), /ACTOR_SIGNATURE_REQUIRED/);
    assert.throws(() => holdAs(iot, r.requestId, "iot-provider-1"), /ORDER_ACCESS_FORBIDDEN/);
    const held = holdAs(iot, r.requestId, "buyer");
    assert.equal(held.heldAmount, 100n);
    assert.equal(marketplace.availableBalance("EUR", "buyer"), 10_000n - 100n);
    assert.equal(holdAs(iot, r.requestId, "buyer").heldAmount, 100n); // idempotent
    assert.equal(marketplace.valueAccounting("EUR").conserved, true);
  });

  it("IoT requests are fail-closed: unregistered or wrongly signed buyers cannot reserve", () => {
    const { iot, listing, marketplace } = setup();
    assert.throws(() => iot.requestService({ buyerId: "ghost", listingId: listing.listingId, machineId: "machine-01", quantity: 1n, idempotencyKey: "k", authorization: "00".repeat(64) }), /IDENTITY_NOT_REGISTERED/);
    enrollIdentity(marketplace, "buyer-x", { asset: "EUR", amount: 1_000n });
    const otherSig = iotAuthorization(marketplace, { listingId: listing.listingId, buyerId: "buyer-x", quantity: 2n, idempotencyKey: "k" });
    assert.throws(() => iot.requestService({ buyerId: "buyer-x", listingId: listing.listingId, machineId: "machine-01", quantity: 1n, idempotencyKey: "k", authorization: otherSig }), /RESERVATION_SIGNATURE_INVALID/);
    assert.equal(marketplace.getListing(listing.listingId).available, 10n);
    assert.equal(marketplace.lockedDeposit("EUR", "buyer-x"), 0n);
  });
});

describe("IoT identities named by ledger addresses (v0.4.5)", () => {
  it("an address-named provider and buyer run the signed flow; the address binds the key", async () => {
    const { identityFromMnemonic, generateMnemonic } = await import("../identity/index.ts");
    const { enrollAccountIdentity } = await import("../marketplace/testkit.ts");
    const provider = await identityFromMnemonic(await generateMnemonic(128));
    const buyer = await identityFromMnemonic(await generateMnemonic(128));
    let now = 1_000_000;
    const marketplace = new DigitalServicesMarketplace({ now: () => now, settlementArbiterId: "iot-arbiter", settlementArbiterPublicKey: ARBITER.publicKeyHex, adminIdentity: "iot-admin", adminPublicKey: ADMIN.publicKeyHex });
    const iot = new IoTM2MService(marketplace, { now: () => now, telemetryMaxAgeMs: 60_000 });
    // Nobody can claim the provider's address with another key.
    const providerAddr = enrollAccountIdentity(marketplace, provider).identityId;
    assert.equal(marketplace.ledgerAccountOf("iot-admin"), undefined);
    assert.throws(() => marketplace.registerIdentity(providerAddr.replace(/.$/, (c) => (c === "q" ? "p" : "q")), buyer.spendPublicKey), /IDENTITY_ADDRESS_INVALID/);
    const buyerAddr = enrollAccountIdentity(marketplace, buyer).identityId;
    assert.ok(marketplace.ledgerAccountOf(providerAddr)!.eq(provider.accountId));
    registerProviderAs(iot, { providerId: providerAddr, displayName: "Address-named lab" });
    registerMachineAs(iot, { machineId: "machine-a", providerId: providerAddr, serviceType: "temperature-sampling", model: "LAB-SENSOR-1", endpointRef: "sim://machine-a" });
    const listing = publishAs(marketplace, { providerId: providerAddr, title: "Temperature sampling", description: "Simulated machine telemetry", category: IOT_M2M_CATEGORY, asset: "EUR", unitPrice: 100n, capacity: 10n });
    const r = requestAs(iot, { buyerId: buyerAddr, listingId: listing.listingId, machineId: "machine-a", quantity: 1n });
    holdAs(iot, r.requestId, buyerAddr);
    const t = simulateAs(iot, r.requestId, "machine-a", { status: "OK" });
    deliverTelemetryAs(iot, r.requestId, providerAddr, t);
    iot.verifyTelemetry(r.requestId, t);
    const s = settleIoTAs(iot, r.requestId, buyerAddr);
    assert.equal(s.providerPayout + s.marketplaceFee, 100n);
    assert.equal(marketplace.valueAccounting("EUR").conserved, true);
  });
});
