import { randomBytes } from "node:crypto";
/**
 * @uep/marketplace — buyer and provider calls over the local API.
 */
import { listingTerms, signAction, signReservation } from "../../src/marketplace/identity.ts";
// 0.5.83 (Block A): v2 client helpers (network / domain / nonce / height-window bound signatures).
export { envelopeV2, signActionV2, signReservationV2 } from "../../src/marketplace/identity.ts";
/** 0.5.83: fresh random nonce for a v2 envelope (client side; randomness stays outside the protocol code). */
export function newSignatureNonce(): string { return randomBytes(16).toString("hex"); }
import { signEd25519 } from "../../src/core/ed25519.ts";
import { serializeTx, type UepTransaction } from "../../src/core/transaction.ts";
import { contentHash } from "../../src/service/content-hash.ts";
import { UepClient, type UepAuth } from "../client/index.ts";
import type { PrivateKeyLike } from "../../src/core/ed25519.ts";

export type ListingDraft = { listingId: string; providerId: string; title: string; description: string; category: string; asset: string; unitPrice: bigint; capacity: bigint };

export class MarketplaceClient {
  readonly client: UepClient;
  readonly marketplaceId: string;
  constructor(client: UepClient, marketplaceId: string) {
    this.client = client;
    this.marketplaceId = marketplaceId;
  }

  registerIdentity(identityId: string, publicKeyHex: string, privateKey: PrivateKeyLike) {
    return this.client.post("/v1/marketplace/identities", { identityId, publicKeyHex, signature: signEd25519(identityId, privateKey) });
  }


  async bridgeInfo() {
    const response = await fetch(this.client.baseUrl + "/v1/bridge/info");
    return { status: response.status, json: await response.json() };
  }

  /** Submit a spend the client already signed. buyerId must be the sender address. */
  deposit(buyerKey: PrivateKeyLike, buyerId: string, tx: UepTransaction) {
    const txId = typeof tx.txId === "string" ? tx.txId : tx.txId.toHex();
    const signature = signEd25519(`uep-bridge-deposit:${this.marketplaceId}:${buyerId}:${txId}`, buyerKey);
    return this.client.post("/v1/bridge/deposit", { buyerId, tx: serializeTx(tx), signature });
  }

  claim(buyerKey: PrivateKeyLike, buyerId: string, txId: string) {
    const signature = signEd25519(`uep-bridge-deposit:${this.marketplaceId}:${buyerId}:${txId}`, buyerKey);
    return this.client.post("/v1/bridge/claim", { buyerId, txId, signature });
  }

  withdraw(buyerKey: PrivateKeyLike, buyerId: string, recipient: string, amount: bigint, openingSeed: bigint, nonce: string, expiresAtHeight: number) {
    const message = `uep-bridge-withdraw:${this.marketplaceId}:${buyerId}:${recipient}:uep-test/teur:${amount}:${openingSeed}:${nonce}:${expiresAtHeight}`;
    return this.client.post("/v1/bridge/withdraw", { buyerId, recipient, amount: amount.toString(), openingSeed: openingSeed.toString(), nonce, expiresAtHeight, signature: signEd25519(message, buyerKey) });
  }
  credit(adminKey: PrivateKeyLike, identityId: string, asset: string, amount: bigint, creditId: string) {
    const auth = signAction({ marketplaceId: this.marketplaceId, action: "credit", actorId: "admin-1", target: identityId, details: { asset, amount, creditId } }, adminKey);
    return this.client.post("/v1/marketplace/credits", { identityId, asset, amount: amount.toString(), creditId }, auth);
  }

  publish(providerKey: PrivateKeyLike, listing: ListingDraft) {
    const auth: UepAuth = signAction({ marketplaceId: this.marketplaceId, action: "publish", actorId: listing.providerId, target: listing.listingId, details: listingTerms(listing) }, providerKey);
    return this.client.post("/v1/marketplace/listings", { ...listing, unitPrice: listing.unitPrice.toString(), capacity: listing.capacity.toString() }, auth);
  }

  reserve(buyerKey: PrivateKeyLike, listingId: string, buyerId: string, quantity: bigint, idempotencyKey: string) {
    const signature = signReservation({ marketplaceId: this.marketplaceId, listingId, buyerId, quantity, idempotencyKey }, buyerKey);
    return this.client.post("/v1/marketplace/orders", { listingId, buyerId, quantity: quantity.toString(), idempotencyKey, signature });
  }

  fund(buyerKey: PrivateKeyLike, buyerId: string, orderId: string, amount: bigint) {
    const auth = signAction({ marketplaceId: this.marketplaceId, action: "fund", actorId: buyerId, target: orderId, details: { amount } }, buyerKey);
    return this.client.post(`/v1/marketplace/orders/${orderId}/fund`, { amount: amount.toString() }, auth);
  }

  deliver(providerKey: PrivateKeyLike, providerId: string, orderId: string, body: Uint8Array) {
    const auth = signAction({ marketplaceId: this.marketplaceId, action: "deliver", actorId: providerId, target: orderId, details: { deliveryHash: contentHash(body) } }, providerKey);
    return this.client.postBytes(`/v1/marketplace/orders/${orderId}/deliver`, body, auth);
  }

  settle(buyerKey: PrivateKeyLike, buyerId: string, orderId: string) {
    const auth = signAction({ marketplaceId: this.marketplaceId, action: "settle", actorId: buyerId, target: orderId, details: {} }, buyerKey);
    return this.client.post(`/v1/marketplace/orders/${orderId}/settle`, {}, auth);
  }
}
