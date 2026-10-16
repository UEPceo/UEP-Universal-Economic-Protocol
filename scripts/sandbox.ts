/**
 * One-command sandbox. `npm run sandbox` completes a sample order and exits.
 * `npm run sandbox:serve` leaves the local node on 127.0.0.1:8787.
 * Fees and snapshot format are unchanged. Not consensus.
 */
import { identityFromMnemonic, generateMnemonic } from "../src/identity/index.ts";
import { assembleNode } from "../src/node/assemble.ts";
import { IoTM2MService } from "../src/service/iot-m2m.ts";
import { createMarketplaceIdentity } from "../src/marketplace/identity.ts";
import { UepClient } from "../sdk/client/index.ts";
import { MarketplaceClient } from "../sdk/marketplace/index.ts";

const serve = process.argv.includes("--serve");
const custody = await identityFromMnemonic(await generateMnemonic(128));
const feeAccount = await identityFromMnemonic(await generateMnemonic(128));
const node = assembleNode({ custody, feeAccount, adminId: "admin-1" });
const iot = new IoTM2MService(node.marketplace); // time comes from the Marketplace height
const started = await node.listen(serve ? 8787 : 0);
const base = `http://127.0.0.1:${started.port}`;
console.log(`uep-sandbox node=${node.circuitTag} iot=${iot ? "attached" : "missing"} ${base}`);

if (serve) {
  console.log("sample data is not preloaded in serve mode; use npm run sandbox for the sample order");
} else {
  const provider = createMarketplaceIdentity("provider-1");
  const buyer = createMarketplaceIdentity("buyer-1");
  node.marketplace.registerIdentity("provider-1", provider.publicKeyHex);
  node.marketplace.registerIdentity("buyer-1", buyer.publicKeyHex);
  const sdk = new MarketplaceClient(new UepClient(base), node.marketplace.marketplaceId);
  const credited = await sdk.credit(node.admin.privateKey, "buyer-1", "EUR", 1_000n, "sandbox-credit");
  if (credited.status !== 201) throw new Error(`SANDBOX_CREDIT ${credited.status} ${JSON.stringify(credited.json)}`);
  const listing = { listingId: "sandbox-listing", providerId: "provider-1", title: "Sandbox slot", description: "sample", category: "API", asset: "EUR", unitPrice: 20n, capacity: 5n };
  const published = await sdk.publish(provider.privateKey, listing);
  if (published.status !== 201) throw new Error(`SANDBOX_PUBLISH ${published.status} ${JSON.stringify(published.json)}`);
  const ordered = await sdk.reserve(buyer.privateKey, listing.listingId, "buyer-1", 1n, "sandbox-k1");
  if (ordered.status !== 201) throw new Error(`SANDBOX_RESERVE ${ordered.status}`);
  const orderId = ordered.json.data.orderId as string;
  const due = BigInt(ordered.json.data.fundingDue);
  const funded = await sdk.fund(buyer.privateKey, "buyer-1", orderId, due);
  if (funded.status !== 200) throw new Error(`SANDBOX_FUND ${funded.status}`);
  const delivered = await sdk.deliver(provider.privateKey, "provider-1", orderId, Buffer.from("sandbox-delivery"));
  if (delivered.status !== 200) throw new Error(`SANDBOX_DELIVER ${delivered.status}`);
  const settled = await sdk.settle(buyer.privateKey, "buyer-1", orderId);
  if (settled.status !== 200) throw new Error(`SANDBOX_SETTLE ${settled.status}`);
  console.log("SANDBOX OK");
  started.server.close();
}
