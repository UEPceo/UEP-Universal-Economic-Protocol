import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "../src/marketplace/marketplace.ts";
import { createMarketplaceIdentity } from "../src/marketplace/identity.ts";
import { listenUepHttpApi } from "../src/service/uep-http-api.ts";
import { UepServiceApi } from "../src/service/uep-service-api.ts";
import { UepClient } from "../sdk/client/index.ts";
import { MarketplaceClient } from "../sdk/marketplace/index.ts";
import { runSampleOrder } from "./sample-service.ts";

test("the sample service completes an order through the SDK only", async () => {
  const admin = createMarketplaceIdentity("admin-1");
  const provider = createMarketplaceIdentity("provider-1");
  const buyer = createMarketplaceIdentity("buyer-1");
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: () => 10, adminIdentity: "admin-1", adminPublicKey: admin.publicKeyHex, adminAuthorizer: (id) => id === "admin-1" });
  const started = await listenUepHttpApi({ api: new UepServiceApi({ marketplace: m, storageProviders: new Map() }), host: "127.0.0.1", port: 0 });
  const sdk = new MarketplaceClient(new UepClient(`http://127.0.0.1:${started.port}`), m.marketplaceId);
  try {
    await sdk.registerIdentity("provider-1", provider.publicKeyHex, provider.privateKey);
    await sdk.registerIdentity("buyer-1", buyer.publicKeyHex, buyer.privateKey);
    assert.equal((await sdk.credit(admin.privateKey, "buyer-1", "EUR", 1000n, "sample-credit")).status, 201);
    const result = await runSampleOrder({
      baseUrl: `http://127.0.0.1:${started.port}`,
      marketplaceId: m.marketplaceId,
      providerId: "provider-1",
      providerKey: provider.privateKey,
      buyerId: "buyer-1",
      buyerKey: buyer.privateKey,
      listing: { listingId: "sample-listing", providerId: "provider-1", title: "Sample slot", description: "template", category: "API", asset: "EUR", unitPrice: 20n, capacity: 4n },
    });
    assert.equal(result.status, 200);
  } finally {
    await new Promise((resolve) => started.server.close(() => resolve(undefined)));
  }
});
