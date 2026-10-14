import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "../src/marketplace/marketplace.ts";
import { createTestAuthority, publishAs } from "../src/marketplace/testkit.ts";
import { listenUepHttpApi } from "../src/service/uep-http-api.ts";
import { UepServiceApi } from "../src/service/uep-service-api.ts";
import { runDeveloperCli } from "./cli.ts";

test("the developer CLI reads height and listings from the local API", async () => {
  const admin = createTestAuthority("admin-1");
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: () => 10, adminIdentity: "admin-1", adminPublicKey: admin.publicKeyHex, adminAuthorizer: (id) => id === "admin-1" });
  publishAs(m, { providerId: "p1", title: "slot", description: "d", category: "API", asset: "EUR", unitPrice: 20n, capacity: 2n });
  const started = await listenUepHttpApi({ api: new UepServiceApi({ marketplace: m, storageProviders: new Map() }), host: "127.0.0.1", port: 0 });
  try {
    const url = `http://127.0.0.1:${started.port}`;
    assert.equal(await runDeveloperCli(["height", "--url", url]), "height=10");
    assert.equal(await runDeveloperCli(["listings", "--url", url]), "listings=1");
  } finally {
    await new Promise((resolve) => started.server.close(() => resolve(undefined)));
  }
});
