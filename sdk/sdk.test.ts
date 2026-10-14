import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "../src/marketplace/marketplace.ts";
import { createMarketplaceIdentity } from "../src/marketplace/identity.ts";
import { listenUepHttpApi } from "../src/service/uep-http-api.ts";
import { UepServiceApi } from "../src/service/uep-service-api.ts";
import { UepClient } from "./client/index.ts";
import { MarketplaceClient } from "./marketplace/index.ts";
import { IotClient } from "./iot-m2m/index.ts";

test("the SDK completes a buyer-provider order without calling the Marketplace", async () => {
  const admin = createMarketplaceIdentity("admin-1");
  const provider = createMarketplaceIdentity("provider-1");
  const buyer = createMarketplaceIdentity("buyer-1");
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: () => 10, adminIdentity: "admin-1", adminPublicKey: admin.publicKeyHex, adminAuthorizer: (id) => id === "admin-1" });
  const started = await listenUepHttpApi({ api: new UepServiceApi({ marketplace: m, storageProviders: new Map() }), host: "127.0.0.1", port: 0 });
  const sdk = new MarketplaceClient(new UepClient(`http://127.0.0.1:${started.port}`), m.marketplaceId);
  try {
    assert.equal((await sdk.registerIdentity("provider-1", provider.publicKeyHex, provider.privateKey)).status, 201);
    assert.equal((await sdk.registerIdentity("buyer-1", buyer.publicKeyHex, buyer.privateKey)).status, 201);
    assert.equal((await sdk.credit(admin.privateKey, "buyer-1", "EUR", 1000n, "c1")).status, 201);
    assert.equal((await sdk.publish(provider.privateKey, { listingId: "l-sdk", providerId: "provider-1", title: "slot", description: "d", category: "API", asset: "EUR", unitPrice: 20n, capacity: 4n })).status, 201);
    const ordered = await sdk.reserve(buyer.privateKey, "l-sdk", "buyer-1", 1n, "k1");
    assert.equal(ordered.status, 201);
    const orderId = ordered.json.data.orderId as string;
    const due = BigInt(ordered.json.data.fundingDue);
    assert.equal((await sdk.fund(buyer.privateKey, "buyer-1", orderId, due)).status, 200);
    assert.equal((await sdk.deliver(provider.privateKey, "provider-1", orderId, Buffer.from("done"))).status, 200);
    assert.equal((await sdk.settle(buyer.privateKey, "buyer-1", orderId)).status, 200);
    const iot = new IotClient(() => undefined);
    assert.equal(iot.submit({ telemetryId: "t1", requestId: "r1", contractId: "c", providerId: "p", machineId: "m", sequence: 1, observedAt: 1, measurements: {}, unitsDelivered: "1", nonce: "ab".repeat(16) }), "sent");
    assert.equal(iot.submit({ telemetryId: "t1", requestId: "r1", contractId: "c", providerId: "p", machineId: "m", sequence: 1, observedAt: 1, measurements: {}, unitsDelivered: "1", nonce: "ab".repeat(16) }), "duplicate");
  } finally {
    await new Promise((resolve) => started.server.close(() => resolve(undefined)));
  }
});
