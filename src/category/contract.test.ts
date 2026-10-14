import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { createTestAuthority, deliver, fund, publishAs, reserveAs, settle } from "../marketplace/testkit.ts";

test("a new category settles through the existing hooks without a Marketplace edit", () => {
  const admin = createTestAuthority("admin-1");
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: () => 10, adminIdentity: "admin-1", adminPublicKey: admin.publicKeyHex, adminAuthorizer: (id) => id === "admin-1" });
  m.registerCategoryContract({ categoryId: "OBSERVATION", inputSchema: "obs.in", outputSchema: "obs.out", requirements: ["hash"], slaHeights: 2 });
  const listing = publishAs(m, { providerId: "p1", title: "sighting", description: "d", category: "OBSERVATION", asset: "EUR", unitPrice: 20n, capacity: 5n });
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: "b1", quantity: 1n });
  fund(m, order.orderId, order.fundingDue);
  deliver(m, order.orderId, "p1", Buffer.from("sighting"));
  settle(m, order.orderId, "b1");
  assert.equal(m.categoryContract("OBSERVATION").slaHeights, 2);
  assert.throws(() => publishAs(m, { providerId: "p1", title: "other", description: "d", category: "NOT_REGISTERED", asset: "EUR", unitPrice: 20n, capacity: 5n }), /CATEGORY_UNKNOWN/);
});
