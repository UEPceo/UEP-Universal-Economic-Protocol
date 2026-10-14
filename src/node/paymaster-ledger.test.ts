import test from "node:test";
import assert from "node:assert/strict";
import { clientBlinding } from "../core/client-note.ts";
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { createMarketplaceIdentity } from "../marketplace/identity.ts";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { MarketplacePaymaster } from "../marketplace/paymaster.ts";
import { contentHash } from "../service/content-hash.ts";
import { deliverWithExpectedHash, enrollIdentity, fund, publishAs, reserveAs, settle } from "../marketplace/testkit.ts";
import { TESTNET } from "../network/profiles.ts";
import { ValueBridge } from "../settlement/value-bridge.ts";
import { UepLedger } from "../testnet/ledger.ts";

test("paymaster gas captured on the marketplace is spent from custody on the ledger", async () => {
  const snap = generateEd25519KeyPair();
  const faucet = generateEd25519KeyPair();
  const ledger = new UepLedger({ networkId: TESTNET.networkId, domainId: "EARTH", connected: true, allowFaucet: true, snapshotSigningKeys: [snap.privateKey], faucetSigningKey: faucet.privateKey });
  const admin = createMarketplaceIdentity("pay-admin");
  const height = () => ledger.height;
  const paymaster = new MarketplacePaymaster({ height, oracle: () => ({ gasPricePerUnit: 1n, oracleRef: "ledger-height" }) });
  const marketplace = new DigitalServicesMarketplace({
    adminIdentity: admin.identityId,
    adminPublicKey: admin.publicKeyHex,
    adminAuthorizer: (id) => id === admin.identityId,
    ledgerNetworkId: ledger.networkId,
    height,
    paymaster,
  });
  const custody = await identityFromMnemonic(await generateMnemonic(128));
  const feeAccount = await identityFromMnemonic(await generateMnemonic(128));
  const buyer = await identityFromMnemonic(await generateMnemonic(128));
  ledger.faucet(buyer.accountId, "uep-test/teur", 20_000n, clientBlinding(3n));
  enrollIdentity(marketplace, "buyer-1");
  paymaster.fundReserve("uep-test/teur", 1_000n);
  const bridge = new ValueBridge(ledger, marketplace, custody, feeAccount, admin);
  bridge.deposit("buyer-1", buyer, "uep-test/teur", 1_000n, 5n);
  const listing = publishAs(marketplace, { providerId: "provider-1", title: "slot", description: "s", category: "API", asset: "uep-test/teur", unitPrice: 20n, capacity: 5n });
  const quote = marketplace.checkoutQuote(listing.listingId, 1n, 5n).gasQuote;
  assert.equal(quote.quotedAt, ledger.height);
  const order = reserveAs(marketplace, { listingId: listing.listingId, buyerId: "buyer-1", quantity: 1n, gasQuote: quote });
  fund(marketplace, order.orderId, order.fundingDue);
  deliverWithExpectedHash(marketplace, order.orderId, "provider-1", Buffer.from("ok"), contentHash(Buffer.from("ok")));
  const settled = settle(marketplace, order.orderId, "buyer-1");
  assert.ok(settled.gasFee > 0n);
  const before = ledger.balanceOfAsset(feeAccount.accountId, "uep-test/teur");
  const swept = bridge.sweepGas("uep-test/teur", settled.gasFee, 9n);
  assert.equal(swept.amount, settled.gasFee);
  assert.equal(marketplace.valueAccounting("uep-test/teur").gasCaptured, 0n);
  assert.equal(marketplace.valueAccounting("uep-test/teur").conserved, true);
  assert.equal(ledger.balanceOfAsset(feeAccount.accountId, "uep-test/teur"), before + settled.gasFee);
});
