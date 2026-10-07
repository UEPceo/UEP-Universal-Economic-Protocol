/**
 * Test / simulation helpers for the signed IoT / M2M flow (v0.4.4).
 * Keeps machine private keys and signs provider / buyer actions through the
 * marketplace testkit. Not used by production code paths.
 */
import type { KeyObject } from "node:crypto";
import { act, enrollIdentity, iotAuthorization, readAuth, testCredit } from "../marketplace/testkit.ts";
import { createIoTMachineIdentity, iotMachineTerms, iotTelemetryDeliveryHash, type IoTM2MService, type IoTMachine, type IoTTelemetry } from "./iot-m2m.ts";

const machineKeys = new WeakMap<IoTM2MService, Map<string, KeyObject>>();
let autoRequest = 0;

/** Enroll `providerId` in the marketplace (if needed) and register it as an IoT provider with its signature. */
export function registerProviderAs(iot: IoTM2MService, input: { providerId: string; displayName: string }) {
  enrollIdentity(iot.marketplace, input.providerId);
  return iot.registerProvider(input, act(iot.marketplace, input.providerId, "iot-provider-register", input.providerId, { displayName: input.displayName }));
}

/** Register a machine signed by its provider. A fresh Ed25519 machine key is created unless `publicKeyHex` + `privateKey` are given. */
export function registerMachineAs(iot: IoTM2MService, input: Omit<IoTMachine, "registeredAt" | "active" | "publicKeyHex"> & { publicKeyHex?: string; privateKey?: KeyObject }): IoTMachine & { privateKey: KeyObject } {
  const identity = input.publicKeyHex && input.privateKey ? { publicKeyHex: input.publicKeyHex, privateKey: input.privateKey } : createIoTMachineIdentity();
  const { privateKey: _p, ...rest } = input;
  const machine = { ...rest, publicKeyHex: identity.publicKeyHex };
  const registered = iot.registerMachine(machine, act(iot.marketplace, input.providerId, "iot-machine-register", input.machineId, iotMachineTerms(machine)));
  let keys = machineKeys.get(iot);
  if (!keys) { keys = new Map(); machineKeys.set(iot, keys); }
  keys.set(input.machineId, identity.privateKey);
  return { ...registered, privateKey: identity.privateKey };
}

export function machineKey(iot: IoTM2MService, machineId: string): KeyObject {
  const k = machineKeys.get(iot)?.get(machineId);
  if (!k) throw new Error("TESTKIT_MACHINE_UNKNOWN");
  return k;
}

/** Buyer-signed IoT request; the buyer is enrolled and credited (default 10_000) in the listing asset if needed. */
export function requestAs(iot: IoTM2MService, input: { buyerId: string; listingId: string; machineId: string; quantity: bigint; idempotencyKey?: string; requestId?: string }, credit = 10_000n) {
  const m = iot.marketplace;
  enrollIdentity(m, input.buyerId);
  const asset = m.getListing(input.listingId).asset;
  if (credit > 0n && m.availableBalance(asset, input.buyerId) < credit) testCredit(m, input.buyerId, asset, credit - m.availableBalance(asset, input.buyerId));
  const idempotencyKey = input.idempotencyKey ?? `iot-auto-${++autoRequest}`;
  return iot.requestService({ ...input, idempotencyKey, authorization: iotAuthorization(m, { listingId: input.listingId, buyerId: input.buyerId, quantity: input.quantity, idempotencyKey }) });
}

/** Buyer funds the escrow. */
export function holdAs(iot: IoTM2MService, requestId: string, buyerId: string) {
  const orderId = iot.orderIdOf(requestId);
  return iot.hold(requestId, act(iot.marketplace, buyerId, "fund", orderId, { amount: iot.holdAmount(requestId) }));
}

/** Machine-signed simulated execution (uses the key kept by registerMachineAs unless `signer` is given). */
export function simulateAs(iot: IoTM2MService, requestId: string, machineId: string, measurements: Record<string, string>, observedAt?: number, unitsDelivered?: bigint, signer?: KeyObject): IoTTelemetry {
  return iot.simulateExecution(requestId, measurements, observedAt, signer ?? machineKey(iot, machineId), unitsDelivered);
}

/** Provider-signed delivery of a telemetry report. */
export function deliverTelemetryAs(iot: IoTM2MService, requestId: string, providerId: string, telemetry: IoTTelemetry) {
  return iot.deliverTelemetry(requestId, telemetry, act(iot.marketplace, providerId, "deliver", iot.orderIdOf(requestId), { deliveryHash: iotTelemetryDeliveryHash(telemetry) }));
}

export function settleIoTAs(iot: IoTM2MService, requestId: string, actorId: string) {
  return iot.settle(requestId, act(iot.marketplace, actorId, "settle", iot.orderIdOf(requestId)));
}

export function statusAs(iot: IoTM2MService, requestId: string, actorId: string) {
  return iot.serviceStatus(requestId, readAuth(iot.marketplace, actorId, iot.orderIdOf(requestId)));
}
