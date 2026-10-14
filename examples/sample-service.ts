/**
 * Sample service. Imports the SDK only. The node is already listening.
 * Fees are whatever the node charges (0.1 % protocol, 3 % Marketplace).
 */
import { UepClient } from "../sdk/client/index.ts";
import { MarketplaceClient, type ListingDraft } from "../sdk/marketplace/index.ts";
import type { PrivateKeyLike } from "../src/core/ed25519.ts";

export async function runSampleOrder(input: {
  baseUrl: string;
  marketplaceId: string;
  providerId: string;
  providerKey: PrivateKeyLike;
  buyerId: string;
  buyerKey: PrivateKeyLike;
  listing: ListingDraft;
}): Promise<{ orderId: string; status: number }> {
  const sdk = new MarketplaceClient(new UepClient(input.baseUrl), input.marketplaceId);
  const published = await sdk.publish(input.providerKey, input.listing);
  if (published.status !== 201) throw new Error(`SAMPLE_PUBLISH ${published.status}`);
  const ordered = await sdk.reserve(input.buyerKey, input.listing.listingId, input.buyerId, 1n, "sample-k1");
  if (ordered.status !== 201) throw new Error(`SAMPLE_RESERVE ${ordered.status}`);
  const orderId = ordered.json.data.orderId as string;
  const due = BigInt(ordered.json.data.fundingDue);
  const funded = await sdk.fund(input.buyerKey, input.buyerId, orderId, due);
  if (funded.status !== 200) throw new Error(`SAMPLE_FUND ${funded.status}`);
  const delivered = await sdk.deliver(input.providerKey, input.providerId, orderId, Buffer.from("sample-delivery"));
  if (delivered.status !== 200) throw new Error(`SAMPLE_DELIVER ${delivered.status}`);
  const settled = await sdk.settle(input.buyerKey, input.buyerId, orderId);
  if (settled.status !== 200) throw new Error(`SAMPLE_SETTLE ${settled.status}`);
  return { orderId, status: settled.status };
}
