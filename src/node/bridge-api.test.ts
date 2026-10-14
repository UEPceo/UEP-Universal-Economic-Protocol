import test from "node:test";
import assert from "node:assert/strict";
import { encodeAccountAddress } from "../core/address.ts";
import { ledgerAssetIdToFr } from "../core/assets.ts";
import { clientBlinding } from "../core/client-note.ts";
import { deriveSpendKey } from "../core/spend-key.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { TESTNET } from "../network/profiles.ts";
import { UepClient } from "../../sdk/client/index.ts";
import { MarketplaceClient } from "../../sdk/marketplace/index.ts";
import { assembleNode } from "./assemble.ts";

const ASSET = "uep-test/teur";

test("a deposit credits only the sender, and a withdrawal signature does not replay", async () => {
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const feeAccount = await identityFromMnemonic(await generateMnemonic(128));
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  const mallory = await identityFromMnemonic(await generateMnemonic(128));
  const recipient = await identityFromMnemonic(await generateMnemonic(128));
  const buyerKey = deriveSpendKey(buyer.secret, buyer.salt);
  const malloryKey = deriveSpendKey(mallory.secret, mallory.salt);
  const buyerId = encodeAccountAddress(TESTNET.networkId, buyer.accountId);
  const malloryId = encodeAccountAddress(TESTNET.networkId, mallory.accountId);
  const node = assembleNode({ custody, feeAccount, adminId: "admin-1" });
  node.ledger.faucet(buyer.accountId, ASSET, 5_005n, clientBlinding(11n));
  node.marketplace.registerIdentity(buyerId, buyer.spendPublicKey);
  node.marketplace.registerIdentity(malloryId, mallory.spendPublicKey);
  const started = await node.listen(0);
  const sdk = new MarketplaceClient(new UepClient(`http://127.0.0.1:${started.port}`), node.marketplace.marketplaceId);
  try {
    const built = node.ledger.preparePayment(buyer, custody.accountId, ASSET, 5_000n, node.ledger.height, {
      outputBlinding: clientBlinding(21n),
      changeBlinding: clientBlinding(22n),
    });
    if ("error" in built) throw new Error(built.error.code);
    const stolen = await sdk.deposit(malloryKey.privateKey, malloryId, built.txs[0]!);
    assert.equal(stolen.status, 400);
    const deposited = await sdk.deposit(buyerKey.privateKey, buyerId, built.txs[0]!);
    assert.equal(deposited.status, 201, JSON.stringify(deposited.json));
    assert.equal(node.marketplace.availableBalance(ASSET, malloryId), 0n);
    const address = encodeAccountAddress(TESTNET.networkId, recipient.accountId);
    const withdrawn = await sdk.withdraw(buyerKey.privateKey, buyerId, address, 1_000n, 31n, "n1", node.ledger.height + 10);
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.json));
    const replay = await sdk.withdraw(buyerKey.privateKey, buyerId, address, 1_000n, 32n, "n1", node.ledger.height + 10);
    assert.equal(replay.status, 400);
    assert.equal(node.marketplace.availableBalance(ASSET, buyerId), 3_999n);
    node.bridge.reconcile(ASSET);
  } finally {
    await new Promise((resolve) => started.server.close(() => resolve(undefined)));
  }
});
