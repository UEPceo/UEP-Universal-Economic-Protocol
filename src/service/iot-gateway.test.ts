import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { IoTM2MService, IOT_M2M_CATEGORY } from "./iot-m2m.ts";
import { IoTGateway } from "./iot-gateway.ts";
import { createTestAuthority, publishAs } from "../marketplace/testkit.ts";
import { deliverTelemetryAs, holdAs, registerMachineAs, registerProviderAs, requestAs, settleIoTAs, simulateAs } from "./iot-testkit.ts";

test("a dropped telemetry report is retried once and does not settle twice", () => {
  const admin = createTestAuthority("iot-admin");
  const marketplace = new DigitalServicesMarketplace({ testOnlyNowMs: () => 1_000_000, adminIdentity: "iot-admin", adminPublicKey: admin.publicKeyHex });
  const iot = new IoTM2MService(marketplace, { testOnlyNowMs: () => 1_000_000, telemetryMaxAgeMs: 60_000 });
  registerProviderAs(iot, { providerId: "iot-provider-1", displayName: "UEP IoT Lab" });
  registerMachineAs(iot, { machineId: "machine-01", providerId: "iot-provider-1", serviceType: "temperature-sampling", model: "LAB-SENSOR-1", endpointRef: "sim://machine-01" });
  const listing = publishAs(marketplace, { providerId: "iot-provider-1", title: "Temperature sampling", description: "Simulated machine telemetry", category: IOT_M2M_CATEGORY, asset: "EUR", unitPrice: 100n, capacity: 10n });
  const requested = requestAs(iot, { buyerId: "buyer-1", listingId: listing.listingId, machineId: "machine-01", quantity: 1n });
  holdAs(iot, requested.requestId, "buyer-1");
  const telemetry = simulateAs(iot, requested.requestId, "machine-01", { status: "OK" });
  let drops = 1;
  const gateway = new IoTGateway((report) => {
    if (drops > 0) { drops -= 1; throw new Error("NETWORK_DROP"); }
    deliverTelemetryAs(iot, requested.requestId, "iot-provider-1", report);
  });
  assert.equal(gateway.submit(telemetry), "queued");
  assert.equal(gateway.flush(), 1);
  assert.equal(gateway.submit(telemetry), "duplicate");
  assert.equal(gateway.flush(), 0);
  iot.verifyTelemetry(requested.requestId, telemetry);
  settleIoTAs(iot, requested.requestId, "buyer-1");
  settleIoTAs(iot, requested.requestId, "buyer-1");
  assert.equal(marketplace.events.list().filter((e) => e.type === "iot.settled").length, 1);
});
