import test from "node:test";
import assert from "node:assert/strict";
import { authorizeAgentAction, createAgentKeypair, debitBudget, issueCapability } from "./agent-identity.ts";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { createTestAuthority, getOrder, publishAs, reserveAs } from "../marketplace/testkit.ts";

test("an agent may request a marketplace order only inside its grant", () => {
  const admin = createTestAuthority("admin-1");
  const marketplace = new DigitalServicesMarketplace({ testOnlyNowMs: () => 1_700_000_000_000, adminIdentity: "admin-1", adminPublicKey: admin.publicKeyHex, adminAuthorizer: (id) => id === "admin-1" });
  const listing = publishAs(marketplace, { providerId: "provider-1", title: "slot", description: "s", category: "API", asset: "EUR", unitPrice: 20n, capacity: 5n });
  const agent = createAgentKeypair("agent-1");
  const cap = issueCapability({ agentId: agent.agentId, publicKeyHex: agent.publicKeyHex, ownerId: "buyer-1", permissions: ["contract_service", "pay"], spendingLimit: 100n, allowedAssets: ["EUR"], allowedServices: [listing.listingId], ttlMs: 60_000 });
  const denied = authorizeAgentAction(cap, { permission: "settle", asset: "EUR", serviceId: listing.listingId, amount: 20n });
  assert.equal(denied.ok, false);
  const allowed = authorizeAgentAction(cap, { permission: "contract_service", asset: "EUR", serviceId: listing.listingId, amount: 20n });
  assert.equal(allowed.ok, true);
  const order = reserveAs(marketplace, { listingId: listing.listingId, buyerId: "buyer-1", quantity: 1n });
  const spent = debitBudget(cap, order.grossAmount);
  assert.equal(spent.remainingBudget, cap.spendingLimit - order.grossAmount);
  assert.equal(order.buyerId, "buyer-1");
  assert.equal(getOrder(marketplace, order.orderId, "buyer-1").buyerId, "buyer-1");
});
