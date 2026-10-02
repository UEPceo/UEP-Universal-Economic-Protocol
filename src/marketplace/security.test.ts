import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "./marketplace.ts";
import { createTestAuthority, deliver, fund, getOrder, publishAs, reserveAs } from "./testkit.ts";

test("delivery validator can reject invalid digital licenses before settlement", () => {
  const m = new DigitalServicesMarketplace({
    deliveryValidator: (_order, bytes) => ({ ok: bytes.toString().startsWith("LICENSE:"), reason: "LICENSE_INVALID" }),
  });
  const l = publishAs(m, { providerId: "p", title: "License API", description: "license", category: "API", asset: "EUR", unitPrice: 10n, capacity: 1n });
  const o = reserveAs(m, { listingId: l.listingId, buyerId: "b", quantity: 1n });
  fund(m, o.orderId, 9n); // gross 10 minus the minimum deposit 1 locked at reserve()
  assert.throws(() => deliver(m, o.orderId, "p", Buffer.from("INVALID")), /DELIVERY_VALIDATION_FAILED/);
  assert.equal(getOrder(m, o.orderId, "b").status, "HELD");
  deliver(m, o.orderId, "p", Buffer.from("LICENSE:valid"));
  assert.equal(getOrder(m, o.orderId, "b").status, "DELIVERED");
});
