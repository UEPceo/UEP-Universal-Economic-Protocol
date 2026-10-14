import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { IoTM2MService, IOT_M2M_CATEGORY } from "./iot-m2m.ts";
import { createTestAuthority, publishAs } from "../marketplace/testkit.ts";
import { deliverTelemetryAs, holdAs, registerMachineAs, registerProviderAs, requestAs, settleIoTAs, simulateAs } from "./iot-testkit.ts";

test("an IoT delivery emits one telemetry event and settle does not duplicate the order event", () => {
  const admin = createTestAuthority("iot-admin");
  const marketplace = new DigitalServicesMarketplace({ testOnlyNowMs: () => 1_000_000, adminIdentity: "iot-admin", adminPublicKey: admin.publicKeyHex });
  const iot = new IoTM2MService(marketplace, { testOnlyNowMs: () => 1_000_000, telemetryMaxAgeMs: 60_000 });
  registerProviderAs(iot, { providerId: "iot-provider-1", displayName: "UEP IoT Lab" });
  registerMachineAs(iot, { machineId: "machine-01", providerId: "iot-provider-1", serviceType: "temperature-sampling", model: "LAB-SENSOR-1", endpointRef: "sim://machine-01" });
  const listing = publishAs(marketplace, { providerId: "iot-provider-1", title: "Temperature sampling", description: "Simulated machine telemetry", category: IOT_M2M_CATEGORY, asset: "EUR", unitPrice: 100n, capacity: 10n });
  const requested = requestAs(iot, { buyerId: "buyer-1", listingId: listing.listingId, machineId: "machine-01", quantity: 1n });
  holdAs(iot, requested.requestId, "buyer-1");
  const telemetry = simulateAs(iot, requested.requestId, "machine-01", { status: "OK" });
  deliverTelemetryAs(iot, requested.requestId, "iot-provider-1", telemetry);
  iot.verifyTelemetry(requested.requestId, telemetry);
  settleIoTAs(iot, requested.requestId, "buyer-1");
  const types = marketplace.events.list().map((e) => e.type);
  assert.equal(types.filter((t) => t === "iot.telemetry").length, 1);
  assert.equal(types.filter((t) => t === "iot.settled").length, 1);
  assert.equal(types.filter((t) => t === "order.settled").length, 1);
});
