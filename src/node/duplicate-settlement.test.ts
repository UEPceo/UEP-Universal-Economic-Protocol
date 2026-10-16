import test from "node:test";
import assert from "node:assert/strict";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { createTestAuthority, deliver, fund, publishAs, reserveAs, settle } from "../marketplace/testkit.ts";

function market() {
  const admin = createTestAuthority("admin-1");
  const keys = generateEd25519KeyPair();
  const config = { height: () => 10, adminIdentity: "admin-1", adminPublicKey: admin.publicKeyHex, adminAuthorizer: (id: string) => id === "admin-1", snapshotSigningKeys: [keys.privateKey] };
  return { m: new DigitalServicesMarketplace(config), config };
}

function ready(m: DigitalServicesMarketplace) {
  const listing = publishAs(m, { providerId: "p1", title: "t", description: "d", category: "COMPUTE", asset: "uep-test/teur", unitPrice: 20n, capacity: 100n });
  const order = reserveAs(m, { listingId: listing.listingId, buyerId: "b0", quantity: 5n });
  fund(m, order.orderId, 99n, undefined, "b0");
  deliver(m, order.orderId, "p1", Buffer.from("r"));
  return order.orderId;
}

test("settling the same order twice returns the same record and does not move balances", () => {
  const { m } = market();
  const orderId = ready(m);
  const first = settle(m, orderId, "b0");
  const buyer = m.availableBalance("uep-test/teur", "b0");
  const provider = m.availableBalance("uep-test/teur", "p1");
  const second = settle(m, orderId, "b0");
  assert.equal((second as { settlementId?: string }).settlementId, (first as { settlementId?: string }).settlementId);
  assert.equal(m.availableBalance("uep-test/teur", "b0"), buyer);
  assert.equal(m.availableBalance("uep-test/teur", "p1"), provider);
});

test("a restored marketplace keeps the settlement and does not pay again", () => {
  const { m, config } = market();
  const orderId = ready(m);
  const first = settle(m, orderId, "b0");
  const other = new DigitalServicesMarketplace(config);
  other.restoreSnapshot(m.exportSnapshot(), { snapshotPublicKeys: m.snapshotPublicKeys() });
  assert.equal(other.settlementReceipt(orderId)?.receiptHash, m.settlementReceipt(orderId)?.receiptHash);
  assert.equal(other.availableBalance("uep-test/teur", "p1"), m.availableBalance("uep-test/teur", "p1"));
  assert.equal(other.availableBalance("uep-test/teur", "b0"), m.availableBalance("uep-test/teur", "b0"));
});
