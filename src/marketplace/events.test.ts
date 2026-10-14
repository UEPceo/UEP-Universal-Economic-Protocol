import test from "node:test";
import assert from "node:assert/strict";
import { ServiceEventBus } from "./events.ts";
import { DigitalServicesMarketplace } from "./marketplace.ts";
import { contentHash } from "../service/content-hash.ts";
import { createTestAuthority, deliverWithExpectedHash, fund, publishAs, reserveAs, settle } from "./testkit.ts";

test("an order emits one event per transition and a replay does not duplicate it", () => {
  const admin = createTestAuthority("admin-1");
  const m = new DigitalServicesMarketplace({ testOnlyNowMs: () => 10, adminIdentity: "admin-1", adminPublicKey: admin.publicKeyHex, adminAuthorizer: (id) => id === "admin-1" });
  const listing = publishAs(m, { providerId: "provider-1", title: "slot", description: "s", category: "API", asset: "EUR", unitPrice: 20n, capacity: 5n });
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: "buyer-1", quantity: 1n });
  fund(m, order.orderId, order.fundingDue);
  deliverWithExpectedHash(m, order.orderId, "provider-1", Buffer.from("ok"), contentHash(Buffer.from("ok")));
  settle(m, order.orderId, "buyer-1");
  settle(m, order.orderId, "buyer-1");
  const types = m.events.list().map((e) => e.type);
  assert.deepEqual(types, ["order.accepted", "order.held", "order.delivered", "order.settled"]);
  assert.equal(new Set(m.events.list().map((e) => e.id)).size, 4);
});

test("event ids are deterministic", () => {
  const a = new ServiceEventBus();
  const b = new ServiceEventBus();
  const left = a.emit("order.settled", "ord-1", 3);
  const right = b.emit("order.settled", "ord-1", 3);
  assert.equal(left?.id, right?.id);
  assert.equal(a.emit("order.settled", "ord-1", 3), undefined);
});
