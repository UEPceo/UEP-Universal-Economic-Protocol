/**
 * Marketplace identities and buyer authorizations (v0.4.3, UEP-A10).
 *
 * Only identities whose Ed25519 public key is registered with the marketplace
 * can reserve. A reservation (and a buyer cancellation) must carry the buyer's
 * signature over a canonical, domain-separated message, so an identity string
 * alone cannot lock anyone's funds.
 *
 * Status: IMPLEMENTED / TESTED (testnet; registration is self-service, no KYC).
 */
import type { KeyObject } from "node:crypto";
import { generateEd25519KeyPair, signEd25519, stableStringify, type PrivateKeyLike } from "../core/ed25519.ts";

export const DEFAULT_MARKETPLACE_ID = "uep-marketplace-testnet";

export type MarketplaceIdentity = { identityId: string; publicKeyHex: string; privateKey: KeyObject };

export type ReservationAuthorization = {
  marketplaceId?: string;
  listingId: string;
  buyerId: string;
  quantity: bigint;
  idempotencyKey: string;
  orderId?: string;
  gasQuoteId?: string;
};

export type CancellationAuthorization = { marketplaceId?: string; orderId: string; buyerId: string };

/** Generate a fresh Ed25519 identity for the marketplace (client side). */
export function createMarketplaceIdentity(identityId: string): MarketplaceIdentity {
  if (!identityId) throw new Error("IDENTITY_ID_REQUIRED");
  const { privateKey, publicKeyHex } = generateEd25519KeyPair();
  return { identityId, publicKeyHex, privateKey };
}

/** Canonical message a buyer signs to reserve. */
export function reservationMessage(a: ReservationAuthorization): string {
  return stableStringify({
    domain: "UEP-MARKETPLACE-RESERVE-v1",
    marketplaceId: a.marketplaceId ?? DEFAULT_MARKETPLACE_ID,
    listingId: a.listingId,
    buyerId: a.buyerId,
    quantity: a.quantity.toString(),
    idempotencyKey: a.idempotencyKey,
    orderId: a.orderId ?? null,
    gasQuoteId: a.gasQuoteId ?? null,
  });
}

export function signReservation(a: ReservationAuthorization, privateKey: PrivateKeyLike): string {
  return signEd25519(reservationMessage(a), privateKey);
}

/** Canonical message a buyer signs to cancel their own order. */
export function cancellationMessage(a: CancellationAuthorization): string {
  return stableStringify({ domain: "UEP-MARKETPLACE-CANCEL-v1", marketplaceId: a.marketplaceId ?? DEFAULT_MARKETPLACE_ID, orderId: a.orderId, buyerId: a.buyerId });
}

export function signCancellation(a: CancellationAuthorization, privateKey: PrivateKeyLike): string {
  return signEd25519(cancellationMessage(a), privateKey);
}
