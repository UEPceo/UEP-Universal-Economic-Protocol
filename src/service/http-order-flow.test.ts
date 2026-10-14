import test from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { createMarketplaceIdentity, listingTerms, signReservation, signAction } from "../marketplace/identity.ts";
import { contentHash } from "./content-hash.ts";
import { signEd25519 } from "../core/ed25519.ts";
import { listenUepHttpApi } from "./uep-http-api.ts";
import { UepServiceApi } from "./uep-service-api.ts";

test("a buyer and a provider complete an order through the local API only", async () => {
  const admin = createMarketplaceIdentity("admin-1");
  const provider = createMarketplaceIdentity("provider-1");
  const buyer = createMarketplaceIdentity("buyer-1");
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: () => 10, adminIdentity: "admin-1", adminPublicKey: admin.publicKeyHex, adminAuthorizer: (id) => id === "admin-1" });
  const api = new UepServiceApi({ marketplace: m, storageProviders: new Map() });
  const started = await listenUepHttpApi({ api, host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${started.port}`;
  const post = async (path: string, body: unknown, auth?: { actorId: string; signature: string }) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth) { headers["x-uep-actor-id"] = auth.actorId; headers["x-uep-signature"] = auth.signature; }
    const response = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() as any };
  };
  try {
    assert.equal((await post("/v1/marketplace/identities", { identityId: "provider-1", publicKeyHex: provider.publicKeyHex, signature: signEd25519("provider-1", provider.privateKey) })).status, 201);
    assert.equal((await post("/v1/marketplace/identities", { identityId: "buyer-1", publicKeyHex: buyer.publicKeyHex, signature: signEd25519("buyer-1", buyer.privateKey) })).status, 201);
    const credit = signAction({ marketplaceId: m.marketplaceId, action: "credit", actorId: "admin-1", target: "buyer-1", details: { asset: "EUR", amount: 1000n, creditId: "c1" } }, admin.privateKey);
    assert.equal((await post("/v1/marketplace/credits", { identityId: "buyer-1", asset: "EUR", amount: "1000", creditId: "c1" }, credit)).status, 201);
    const listing = { listingId: "l-api", providerId: "provider-1", title: "slot", description: "d", category: "API", asset: "EUR", unitPrice: 20n, capacity: 4n };
    const publish = signAction({ marketplaceId: m.marketplaceId, action: "publish", actorId: "provider-1", target: "l-api", details: listingTerms(listing) }, provider.privateKey);
    const published = await post("/v1/marketplace/listings", { ...listing, unitPrice: "20", capacity: "4" }, publish);
    assert.equal(published.status, 201);
    const signature = signReservation({ marketplaceId: m.marketplaceId, listingId: "l-api", buyerId: "buyer-1", quantity: 1n, idempotencyKey: "k1" }, buyer.privateKey);
    const ordered = await post("/v1/marketplace/orders", { listingId: "l-api", buyerId: "buyer-1", quantity: "1", idempotencyKey: "k1", signature });
    assert.equal(ordered.status, 201);
    const orderId = ordered.json.data.orderId as string;
    const due = String(ordered.json.data.fundingDue);
    const fund = signAction({ marketplaceId: m.marketplaceId, action: "fund", actorId: "buyer-1", target: orderId, details: { amount: BigInt(due) } }, buyer.privateKey);
    assert.equal((await post(`/v1/marketplace/orders/${orderId}/fund`, { amount: due }, fund)).status, 200);
    const bytes = Buffer.from("done");
    const deliver = signAction({ marketplaceId: m.marketplaceId, action: "deliver", actorId: "provider-1", target: orderId, details: { deliveryHash: contentHash(bytes) } }, provider.privateKey);
    const delivered = await fetch(base + `/v1/marketplace/orders/${orderId}/deliver`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-uep-actor-id": deliver.actorId, "x-uep-signature": deliver.signature }, body: bytes });
    assert.equal(delivered.status, 200);
    const settle = signAction({ marketplaceId: m.marketplaceId, action: "settle", actorId: "buyer-1", target: orderId, details: {} }, buyer.privateKey);
    const settled = await post(`/v1/marketplace/orders/${orderId}/settle`, {}, settle);
    assert.equal(settled.status, 200);
    assert.equal(m.getOrder(orderId, { actorId: "buyer-1", signature: signAction({ marketplaceId: m.marketplaceId, action: "read", actorId: "buyer-1", target: orderId, details: { issuedAt: 10 } }, buyer.privateKey).signature, issuedAt: 10 }).status, "SETTLED");
  } finally {
    await new Promise((resolve) => started.server.close(() => resolve(undefined)));
  }
});
