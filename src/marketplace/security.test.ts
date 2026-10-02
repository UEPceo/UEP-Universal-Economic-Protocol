import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "./marketplace.ts";

test("delivery validator can reject invalid digital licenses before settlement", () => {
  const m = new DigitalServicesMarketplace({
    deliveryValidator: (_order, bytes) => ({ ok: bytes.toString().startsWith("LICENSE:"), reason: "LICENSE_INVALID" }),
  });
  const l = m.publishListing({ providerId: "p", title: "License API", description: "license", category: "API", asset: "EUR", unitPrice: 10n, capacity: 1n });
  const o = m.acceptOrder({ listingId: l.listingId, buyerId: "b", quantity: 1n });
  m.fundOrder(o.orderId, 10n);
  assert.throws(() => m.deliver(o.orderId, "p", Buffer.from("INVALID")), /DELIVERY_VALIDATION_FAILED/);
  assert.equal(m.getOrder(o.orderId).status, "HELD");
  m.deliver(o.orderId, "p", Buffer.from("LICENSE:valid"));
  assert.equal(m.getOrder(o.orderId).status, "DELIVERED");
});
