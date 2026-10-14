/**
 * Phase 2.10 simulators. Seeded: no clock and no random source. A scenario
 * returns the same counts and the same conserved flags on every run.
 */
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { createTestAuthority, deliver, fund, publishAs, reserveAs, settle } from "../marketplace/testkit.ts";
import { IoTM2MService, IOT_M2M_CATEGORY } from "./iot-m2m.ts";
import { IoTGateway } from "./iot-gateway.ts";
import { deliverTelemetryAs, holdAs, registerMachineAs, registerProviderAs, requestAs, settleIoTAs, simulateAs } from "./iot-testkit.ts";

export type ScenarioReport = {
  name: string;
  seed: number;
  settled: number;
  rejected: number;
  valueConserved: boolean;
  capacityConserved: boolean;
};

export function providerScenario(seed: number, orders = 4): ScenarioReport {
  const admin = createTestAuthority(`sim-admin-${seed}`);
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: () => 1_000 + seed, adminIdentity: admin.identityId, adminPublicKey: admin.publicKeyHex, adminAuthorizer: (id) => id === admin.identityId });
  const listing = publishAs(m, { providerId: `prov-${seed}`, title: `slot-${seed}`, description: "sim", category: "API", asset: "EUR", unitPrice: 20n, capacity: BigInt(orders) });
  let settled = 0;
  let rejected = 0;
  for (let i = 0; i < orders; i++) {
    const order = reserveAs(m, { listingId: listing.listingId, buyerId: `buyer-${seed}`, quantity: 1n, idempotencyKey: `sim-${seed}-${i}` });
    fund(m, order.orderId, order.fundingDue);
    deliver(m, order.orderId, `prov-${seed}`, Buffer.from(`body-${seed}-${i}`));
    settle(m, order.orderId, `buyer-${seed}`);
    settled += 1;
    try {
      settle(m, order.orderId, `buyer-${seed}`);
    } catch {
      rejected += 1;
    }
  }
  return {
    name: "provider",
    seed,
    settled,
    rejected,
    valueConserved: m.valueAccounting("EUR").conserved,
    capacityConserved: m.capacityAccounting(listing.listingId).conserved,
  };
}

export function adversaryScenario(seed: number): ScenarioReport {
  const honest = providerScenario(seed, 1);
  const admin = createTestAuthority(`sim-admin-${seed}`);
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: () => 1_000 + seed, adminIdentity: admin.identityId, adminPublicKey: admin.publicKeyHex, adminAuthorizer: (id) => id === admin.identityId });
  const listing = publishAs(m, { providerId: `prov-${seed}`, title: `slot-${seed}`, description: "sim", category: "API", asset: "EUR", unitPrice: 20n, capacity: 2n });
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: `buyer-${seed}`, quantity: 1n, idempotencyKey: `adv-${seed}` });
  let rejected = 0;
  try {
    settle(m, order.orderId, `mallory-${seed}`);
  } catch {
    rejected += 1;
  }
  return {
    name: "adversary",
    seed,
    settled: 0,
    rejected: rejected + honest.rejected,
    valueConserved: m.valueAccounting("EUR").conserved && honest.valueConserved,
    capacityConserved: m.capacityAccounting(listing.listingId).conserved && honest.capacityConserved,
  };
}

export function machineDropScenario(seed: number): ScenarioReport {
  const admin = createTestAuthority(`sim-admin-${seed}`);
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: () => 1_000_000 + seed, adminIdentity: admin.identityId, adminPublicKey: admin.publicKeyHex });
  const iot = new IoTM2MService(m, { testOnlyNowMs: () => 1_000_000 + seed, telemetryMaxAgeMs: 60_000 });
  registerProviderAs(iot, { providerId: `iot-${seed}`, displayName: "sim" });
  registerMachineAs(iot, { machineId: `machine-${seed}`, providerId: `iot-${seed}`, serviceType: "temperature-sampling", model: "SIM", endpointRef: `sim://machine-${seed}` });
  const listing = publishAs(m, { providerId: `iot-${seed}`, title: "sample", description: "sim", category: IOT_M2M_CATEGORY, asset: "EUR", unitPrice: 100n, capacity: 2n });
  const requested = requestAs(iot, { buyerId: `buyer-${seed}`, listingId: listing.listingId, machineId: `machine-${seed}`, quantity: 1n, idempotencyKey: `iot-${seed}` });
  holdAs(iot, requested.requestId, `buyer-${seed}`);
  const telemetry = simulateAs(iot, requested.requestId, `machine-${seed}`, { status: "OK" });
  let drops = 1;
  const gateway = new IoTGateway((report) => {
    if (drops > 0) { drops -= 1; throw new Error("NETWORK_DROP"); }
    deliverTelemetryAs(iot, requested.requestId, `iot-${seed}`, report);
  });
  gateway.submit(telemetry);
  const sent = gateway.flush();
  iot.verifyTelemetry(requested.requestId, telemetry);
  settleIoTAs(iot, requested.requestId, `buyer-${seed}`);
  return {
    name: "machine-drop",
    seed,
    settled: sent,
    rejected: gateway.submit(telemetry) === "duplicate" ? 1 : 0,
    valueConserved: m.valueAccounting("EUR").conserved,
    capacityConserved: m.capacityAccounting(listing.listingId).conserved,
  };
}
