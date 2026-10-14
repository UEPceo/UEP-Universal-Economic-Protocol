/**
 * Service template. A third party imports the SDK only. The node is already running.
 */
import { UepClient } from "../sdk/client/index.ts";
import { MarketplaceClient, type ListingDraft } from "../sdk/marketplace/index.ts";
import type { PrivateKeyLike } from "../src/core/ed25519.ts";

export async function publishTemplate(baseUrl: string, marketplaceId: string, providerKey: PrivateKeyLike, listing: ListingDraft) {
  const sdk = new MarketplaceClient(new UepClient(baseUrl), marketplaceId);
  return sdk.publish(providerKey, listing);
}
