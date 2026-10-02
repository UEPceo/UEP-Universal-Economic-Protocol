/**
 * Test / simulation helpers for the signed, funded reservation flow (v0.4.3).
 * Not used by production code paths.
 */
import { createMarketplaceIdentity, signCancellation, signReservation, type MarketplaceIdentity } from "./identity.ts";
import type { DigitalServicesMarketplace, ServiceOrder } from "./marketplace.ts";
import type { GasQuote } from "./paymaster.ts";

const registry = new WeakMap<DigitalServicesMarketplace, Map<string, MarketplaceIdentity>>();
let autoKey = 0;

/** Register `identityId` with a fresh Ed25519 key (once per marketplace) and optionally credit it. */
export function enrollIdentity(m: DigitalServicesMarketplace, identityId: string, credit?: { asset: string; amount: bigint }): MarketplaceIdentity {
  let ids = registry.get(m);
  if (!ids) { ids = new Map(); registry.set(m, ids); }
  let identity = ids.get(identityId);
  if (!identity) {
    identity = createMarketplaceIdentity(identityId);
    m.registerIdentity(identityId, identity.publicKeyHex);
    ids.set(identityId, identity);
  }
  if (credit && credit.amount > 0n) m.creditAccount(identityId, credit.asset, credit.amount);
  return identity;
}

/**
 * Sign and submit a reservation as `buyerId`. By default the buyer is enrolled
 * and credited with `credit` (default 1_000_000) in the listing asset if needed.
 */
export function reserveAs(
  m: DigitalServicesMarketplace,
  input: { listingId: string; buyerId: string; quantity: bigint; orderId?: string; idempotencyKey?: string; gasQuote?: GasQuote },
  opts: { credit?: bigint } = {},
): ServiceOrder {
  const asset = m.getListing(input.listingId).asset;
  const identity = enrollIdentity(m, input.buyerId);
  const credit = opts.credit ?? 1_000_000n;
  if (credit > 0n && m.availableBalance(asset, input.buyerId) < credit) m.creditAccount(input.buyerId, asset, credit - m.availableBalance(asset, input.buyerId));
  const idempotencyKey = input.idempotencyKey ?? `auto-${++autoKey}`;
  const signature = signReservation({ marketplaceId: m.marketplaceId, listingId: input.listingId, buyerId: input.buyerId, quantity: input.quantity, idempotencyKey, orderId: input.orderId, gasQuoteId: input.gasQuote?.quoteId }, identity.privateKey);
  return m.reserve({ ...input, idempotencyKey, signature });
}

/** Buyer-signed cancellation. */
export function cancelAsBuyer(m: DigitalServicesMarketplace, orderId: string, buyerId: string): ServiceOrder {
  const identity = registry.get(m)?.get(buyerId);
  if (!identity) throw new Error("TESTKIT_IDENTITY_UNKNOWN");
  return m.cancel(orderId, buyerId, { signature: signCancellation({ marketplaceId: m.marketplaceId, orderId, buyerId }, identity.privateKey) });
}

/** Signature for an IoT requestService() call by an enrolled buyer. */
export function iotAuthorization(m: DigitalServicesMarketplace, input: { listingId: string; buyerId: string; quantity: bigint; idempotencyKey: string }): string {
  const identity = registry.get(m)?.get(input.buyerId) ?? enrollIdentity(m, input.buyerId);
  return signReservation({ marketplaceId: m.marketplaceId, ...input }, identity.privateKey);
}
