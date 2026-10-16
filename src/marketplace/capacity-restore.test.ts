import test from "node:test";
import assert from "node:assert/strict";
import { DigitalServicesMarketplace } from "./marketplace.ts";
import { buildMarketplaceSnapshot } from "./marketplace-snapshot.ts";
import { createTestAuthority, publishAs } from "./testkit.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";

test("restore refuses a snapshot whose listing capacity does not add up", () => {
  const admin = createTestAuthority("admin-1");
  const keys = generateEd25519KeyPair();
  const config = { testOnlyNowMs: () => 10, adminIdentity: "admin-1", adminPublicKey: admin.publicKeyHex, adminAuthorizer: (id: string) => id === "admin-1", snapshotSigningKeys: [keys.privateKey] };
  const m = new DigitalServicesMarketplace(config);
  publishAs(m, { providerId: "p1", title: "t", description: "d", category: "COMPUTE", asset: "EUR", unitPrice: 20n, capacity: 100n });
  const snap = m.exportSnapshot();
  const listings = snap.state!.marketplace.listings as { $m: [string, { available: { $b: string } }][] };
  listings.$m[0]![1].available = { $b: "101" };
  const forged = buildMarketplaceSnapshot({
    marketplaceId: snap.marketplaceId,
    treasuryId: snap.treasuryId,
    networkId: snap.networkId as string,
    height: snap.height,
    orderSequence: snap.orderSequence,
    receipts: snap.settlement.receipts,
    state: snap.state,
    signingKeys: [keys.privateKey],
  });
  const fresh = new DigitalServicesMarketplace(config);
  assert.throws(() => fresh.restoreSnapshot(forged, { snapshotPublicKeys: m.snapshotPublicKeys() }), /capacity not conserved/);
});
