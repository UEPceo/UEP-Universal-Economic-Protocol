import test from "node:test";
import assert from "node:assert/strict";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { clientBlinding } from "../core/client-note.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { contentHash } from "../service/content-hash.ts";
import { deliverWithExpectedHash, enrollIdentity, fund, publishAs, reserveAs, settle } from "../marketplace/testkit.ts";
import { TESTNET } from "../network/profiles.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { assembleNode } from "./assemble.ts";

const ASSET = "uep-test/teur";

test("node: faucet, deposit, order, settlement, anchor, snapshot, restore", async () => {
  const snapshotKey = generateEd25519KeyPair();
  const faucetKey = generateEd25519KeyPair();
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const feeAccount = await identityFromMnemonic(await generateMnemonic(128));
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  const node = assembleNode({ custody, feeAccount, snapshotKey, faucetKey });
  node.ledger.faucet(buyer.accountId, ASSET, 20_000n, clientBlinding(11n));
  enrollIdentity(node.marketplace, "buyer-1");
  const deposited = node.bridge.deposit("buyer-1", buyer, ASSET, 5_000n, 21n);
  assert.equal(deposited.amount, 5_000n);
  assert.equal(deposited.marketplaceBalance, 5_000n);
  assert.equal(node.marketplace.valueAccounting(ASSET).conserved, true);
  const listing = publishAs(node.marketplace, {
    providerId: "provider-1",
    title: "relay slot",
    description: "one delivery",
    category: "API",
    asset: ASSET,
    unitPrice: 20n,
    capacity: 10n,
  });
  const order = reserveAs(node.marketplace, { listingId: listing.listingId, buyerId: "buyer-1", quantity: 1n });
  fund(node.marketplace, order.orderId, order.fundingDue);
  deliverWithExpectedHash(node.marketplace, order.orderId, "provider-1", Buffer.from("ok"), contentHash(Buffer.from("ok")));
  settle(node.marketplace, order.orderId, "buyer-1");
  const anchor = node.marketplace.anchorSettlements(node.ledger);
  assert.ok(anchor);
  const snap = node.ledger.snapshot();
  const marketSnap = node.marketplace.exportSnapshot();
  const restored = UepLedger.restore(snap, { authorities: [snapshotKey.publicKeyHex], faucetPublicKeys: [faucetKey.publicKeyHex] });
  assert.equal(restored.networkId, TESTNET.networkId);
  assert.ok(restored.settlementAnchorOf(node.marketplace.marketplaceId, order.orderId));
  assert.equal(marketSnap.formatVersion, 4);
  assert.equal(marketSnap.marketplaceId, node.marketplace.marketplaceId);
  const { server, port } = await node.listen(0);
  try {
    const health = await fetch(`http://127.0.0.1:${port}/v1/health`);
    assert.ok(health.status === 200 || health.status === 202);
    const pushed = await fetch(`http://127.0.0.1:${port}/v1/relay/envelopes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "e1", body: "chunk" }) });
    assert.ok(pushed.status === 200 || pushed.status === 202);
    const body = await pushed.json() as { data: { module: string } };
    assert.equal(body.data.module, "category/relay");
  } finally {
    await new Promise((r) => server.close(() => r(undefined)));
  }
});
