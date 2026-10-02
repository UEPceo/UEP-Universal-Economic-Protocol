/**
 * Marketplace identities and signed authorizations (v0.4.3 UEP-A10, v0.4.4 UEP-B07/B08/B12).
 *
 * Only identities whose Ed25519 public key is registered with the marketplace
 * can reserve or publish. Since v0.4.4 every state-changing or reading call
 * (publish, fund, deliver, settle, cancel, expire, read, list, dispute,
 * resolve, refund, review) carries an `ActorAuth`: the actor's signature over a
 * canonical, domain-separated action message. The administrator and the
 * settlement arbiter sign with keys configured on the marketplace. An identity
 * string alone authorizes nothing.
 *
 * Status: IMPLEMENTED / TESTED (testnet; registration is self-service, no KYC).
 */
import type { KeyObject } from "node:crypto";
import { generateEd25519KeyPair, sha256Hex, signEd25519, stableStringify, type PrivateKeyLike } from "../core/ed25519.ts";

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

/** Signed proof that `actorId` requested one action (v0.4.4). `issuedAt` is required for read / list. */
export type ActorAuth = { actorId: string; signature: string; issuedAt?: number };

export type MarketplaceAction =
  | "publish" | "fund" | "deliver" | "settle" | "cancel" | "expire" | "read" | "list"
  | "dispute" | "resolve" | "refund" | "review" | "credit"
  | "iot-provider-register" | "iot-provider-deactivate" | "iot-machine-register" | "iot-machine-deactivate";

export type ActionAuthorization = {
  marketplaceId?: string;
  action: MarketplaceAction;
  actorId: string;
  /** Order id, listing id, provider id or machine id the action applies to. */
  target: string;
  /** Action parameters bound into the signature (amount, delivery hash, outcome, ...). */
  details?: Record<string, unknown>;
};

/** Canonical, domain-separated message signed for any marketplace action. */
export function actionMessage(a: ActionAuthorization): string {
  return stableStringify({ domain: "UEP-MARKETPLACE-ACTION-v1", marketplaceId: a.marketplaceId ?? DEFAULT_MARKETPLACE_ID, action: a.action, actorId: a.actorId, target: a.target, details: a.details ?? {} });
}

/** Sign an action; returns the ActorAuth to pass to the marketplace. */
export function signAction(a: ActionAuthorization, privateKey: PrivateKeyLike): ActorAuth {
  const issuedAt = a.details?.issuedAt;
  return { actorId: a.actorId, signature: signEd25519(actionMessage(a), privateKey), ...(typeof issuedAt === "number" ? { issuedAt } : {}) };
}

/** Canonical listing terms bound into a provider's publish signature. */
export function listingTerms(input: { title: string; description: string; category: string; asset: string; unitPrice: bigint; capacity: bigint; sellerBond?: bigint }): Record<string, unknown> {
  return { title: input.title, description: input.description, category: input.category, asset: input.asset, unitPrice: input.unitPrice, capacity: input.capacity, sellerBond: input.sellerBond ?? 0n };
}

/** Hash of a dispute reason (the reason text itself is not stored on the order). */
export function disputeReasonHash(reason: string): string {
  return sha256Hex(`UEP-MARKETPLACE-DISPUTE-REASON-v1\n${reason}`);
}

/** Canonical message a buyer signs to cancel their own order (a "cancel" action since v0.4.4). */
export function cancellationMessage(a: CancellationAuthorization): string {
  return actionMessage({ marketplaceId: a.marketplaceId, action: "cancel", actorId: a.buyerId, target: a.orderId });
}

export function signCancellation(a: CancellationAuthorization, privateKey: PrivateKeyLike): string {
  return signEd25519(cancellationMessage(a), privateKey);
}
