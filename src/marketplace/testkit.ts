/**
 * Test / simulation helpers for the signed marketplace flows (v0.4.3 – v0.4.5).
 * Not used by production code paths. Keys of enrolled identities and of
 * test authorities (admin / arbiter) live in this module only.
 */
import { createMarketplaceIdentity, disputeReasonHash, listingTerms, signAction, signCancellation, signReservation, type ActorAuth, type MarketplaceAction, type MarketplaceIdentity } from "./identity.ts";
import type { DigitalServicesMarketplace, DisputeResolution, ServiceListing, ServiceOrder, SettlementRecord } from "./marketplace.ts";
import type { GasQuote } from "./paymaster.ts";
import { contentHash } from "../service/content-hash.ts";
import type { Fr } from "../core/field.ts";
import { encodeAccountAddress } from "../core/address.ts";
import { deriveSpendKey } from "../core/spend-key.ts";

const registry = new WeakMap<DigitalServicesMarketplace, Map<string, MarketplaceIdentity>>();
/** Admin / arbiter test keys, looked up by identity id + public key. */
const authorities = new Map<string, MarketplaceIdentity>();
let autoKey = 0;

/**
 * Create a test authority key (administrator or settlement arbiter). Pass
 * `publicKeyHex` as `adminPublicKey` / `settlementArbiterPublicKey`.
 */
export function createTestAuthority(identityId: string): MarketplaceIdentity {
  const identity = createMarketplaceIdentity(identityId);
  authorities.set(`${identityId}|${identity.publicKeyHex}`, identity);
  return identity;
}

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
  if (credit && credit.amount > 0n) testCredit(m, identityId, credit.asset, credit.amount);
  return identity;
}

let autoCredit = 0;

/**
 * v0.5.3: credit for tests. Since v0.5.3 creditAccount() requires an
 * administrator signature by default. When the marketplace's administrator is
 * a test authority (createTestAuthority), the credit is signed by it with a
 * fresh creditId; otherwise the test marketplace is explicitly switched to
 * unsigned test credits (testOnlyAllowUnsignedCredits, refused in production).
 */
export function testCredit(m: DigitalServicesMarketplace, identityId: string, asset: string, amount: bigint): bigint {
  if (m.requireSignedCredits) {
    const adminKey = m.authorityPublicKeys().admin;
    const authority = m.adminIdentity && adminKey ? authorities.get(`${m.adminIdentity}|${adminKey}`) : undefined;
    if (authority) {
      const creditId = `testkit-credit-${++autoCredit}`;
      try {
        return m.creditAccount(identityId, asset, amount, { creditId, auth: act(m, m.adminIdentity!, "credit", identityId, { asset, amount, creditId }, authority) });
      } catch (err) {
        // A test may configure an adminAuthorizer that refuses the administrator.
        if (!/ADMIN_NOT_AUTHORIZED/.test((err as Error).message)) throw err;
      }
    }
    m.testOnlyAllowUnsignedCredits();
  }
  return m.creditAccount(identityId, asset, amount);
}

/**
 * v0.4.5: register a ledger identity in the marketplace under its v2 address,
 * signing with its deterministic spend key (UEP-ADDR-002 consistency).
 */
export function enrollAccountIdentity(m: DigitalServicesMarketplace, secrets: { secret: Fr; salt: Fr; accountId: Fr }, credit?: { asset: string; amount: bigint }): MarketplaceIdentity {
  const identityId = encodeAccountAddress(m.ledgerNetworkId, secrets.accountId);
  let ids = registry.get(m);
  if (!ids) { ids = new Map(); registry.set(m, ids); }
  let identity = ids.get(identityId);
  if (!identity) {
    const key = deriveSpendKey(secrets.secret, secrets.salt);
    identity = { identityId, publicKeyHex: key.publicKeyHex, privateKey: key.privateKey };
    m.registerIdentity(identityId, identity.publicKeyHex);
    ids.set(identityId, identity);
  }
  if (credit && credit.amount > 0n) testCredit(m, identityId, credit.asset, credit.amount);
  return identity;
}

function keyOf(m: DigitalServicesMarketplace, actorId: string): MarketplaceIdentity {
  const enrolled = registry.get(m)?.get(actorId);
  if (enrolled) return enrolled;
  const configured = m.authorityPublicKeys();
  const authorityKey = actorId === m.adminIdentity ? configured.admin : actorId === m.settlementArbiterId ? configured.arbiter : undefined;
  if (authorityKey) {
    const authority = authorities.get(`${actorId}|${authorityKey}`);
    if (authority) return authority;
  }
  if (m.isIdentityRegistered(actorId)) throw new Error("TESTKIT_IDENTITY_UNKNOWN");
  // Unknown, unregistered actor (e.g. an attacker in a test): enroll it with its own key.
  return enrollIdentity(m, actorId);
}

/** Sign `action` on `target` as `actorId` (enrolled identity, test authority, or auto-enrolled). */
export function act(m: DigitalServicesMarketplace, actorId: string, action: MarketplaceAction, target: string, details: Record<string, unknown> = {}, identity?: MarketplaceIdentity): ActorAuth {
  const signer = identity ?? keyOf(m, actorId);
  return signAction({ marketplaceId: m.marketplaceId, action, actorId, target, details }, signer.privateKey);
}

/** Fresh read authorization for one order. */
export function readAuth(m: DigitalServicesMarketplace, actorId: string, orderId: string): ActorAuth {
  return act(m, actorId, "read", orderId, { issuedAt: m.clock() });
}

/** Fresh list authorization. */
export function listAuth(m: DigitalServicesMarketplace, actorId: string): ActorAuth {
  return act(m, actorId, "list", "orders", { issuedAt: m.clock() });
}

/** Publish as `input.providerId` (enrolled on first use). */
export function publishAs(m: DigitalServicesMarketplace, input: Parameters<DigitalServicesMarketplace["publishListing"]>[0]): ServiceListing {
  enrollIdentity(m, input.providerId);
  return m.publishListing(input, act(m, input.providerId, "publish", input.listingId ?? "", listingTerms(input)));
}

/**
 * Sign and submit a reservation as `buyerId`. By default the buyer is enrolled
 * and credited with `credit` (default 1_000_000) in the listing asset if needed.
 */
export function reserveAs(
  m: DigitalServicesMarketplace,
  input: { listingId: string; buyerId: string; quantity: bigint; orderId?: string; idempotencyKey?: string; gasQuote?: GasQuote; notAfterHeight?: number },
  opts: { credit?: bigint } = {},
): ServiceOrder {
  const asset = m.getListing(input.listingId).asset;
  const identity = enrollIdentity(m, input.buyerId);
  const credit = opts.credit ?? 1_000_000n;
  if (credit > 0n && m.availableBalance(asset, input.buyerId) < credit) testCredit(m, input.buyerId, asset, credit - m.availableBalance(asset, input.buyerId));
  const idempotencyKey = input.idempotencyKey ?? `auto-${++autoKey}`;
  const signature = signReservation({ marketplaceId: m.marketplaceId, listingId: input.listingId, buyerId: input.buyerId, quantity: input.quantity, idempotencyKey, orderId: input.orderId, gasQuoteId: input.gasQuote?.quoteId, notAfterHeight: input.notAfterHeight }, identity.privateKey);
  const order = m.reserve({ ...input, idempotencyKey, signature });
  let tracked = orderBuyers.get(m);
  if (!tracked) { tracked = new Map(); orderBuyers.set(m, tracked); }
  tracked.set(order.orderId, input.buyerId);
  return order;
}

/** Orders reserved through reserveAs(): orderId -> buyer (lets fund() sign as the buyer). */
const orderBuyers = new WeakMap<DigitalServicesMarketplace, Map<string, string>>();

// The helpers below keep the v0.4.3 argument order and add the v0.4.4 signature.

export function fund(m: DigitalServicesMarketplace, orderId: string, amount: bigint, idempotencyKey?: string, buyerId?: string): ServiceOrder {
  const buyer = buyerId ?? orderBuyers.get(m)?.get(orderId);
  if (!buyer) throw new Error("TESTKIT_ORDER_UNKNOWN");
  return m.fundOrder(orderId, amount, act(m, buyer, "fund", orderId, { amount }), idempotencyKey);
}

export function deliver(m: DigitalServicesMarketplace, orderId: string, providerId: string, bytes: Uint8Array | Buffer, idempotencyKey?: string): ServiceOrder {
  return m.deliver(orderId, act(m, providerId, "deliver", orderId, { deliveryHash: contentHash(bytes) }), bytes, idempotencyKey);
}

export function deliverWithExpectedHash(m: DigitalServicesMarketplace, orderId: string, providerId: string, bytes: Uint8Array | Buffer, expectedHash: string, idempotencyKey?: string): ServiceOrder {
  return m.deliverWithExpectedHash(orderId, act(m, providerId, "deliver", orderId, { deliveryHash: contentHash(bytes) }), bytes, expectedHash, idempotencyKey);
}

export function settle(m: DigitalServicesMarketplace, orderId: string, actorId: string): SettlementRecord {
  return m.settle(orderId, act(m, actorId, "settle", orderId));
}

export function getOrder(m: DigitalServicesMarketplace, orderId: string, actorId: string): ServiceOrder {
  return m.getOrder(orderId, readAuth(m, actorId, orderId));
}

export function listOrders(m: DigitalServicesMarketplace, actorId: string): ServiceOrder[] {
  return m.listOrders(listAuth(m, actorId));
}

export function cancel(m: DigitalServicesMarketplace, orderId: string, actorId: string): ServiceOrder {
  return m.cancel(orderId, act(m, actorId, "cancel", orderId));
}

export function expire(m: DigitalServicesMarketplace, orderId: string, actorId: string): ServiceOrder {
  return m.expire(orderId, act(m, actorId, "expire", orderId));
}

export function review(m: DigitalServicesMarketplace, input: { orderId: string; buyerId: string; rating: 1 | 2 | 3 | 4 | 5 }) {
  return m.recordSellerReview({ orderId: input.orderId, rating: input.rating }, act(m, input.buyerId, "review", input.orderId, { rating: input.rating }));
}

export function disputeAs(m: DigitalServicesMarketplace, buyerId: string, orderId: string, reason: string): ServiceOrder {
  return m.openDispute(orderId, act(m, buyerId, "dispute", orderId, { reasonHash: disputeReasonHash(reason) }), reason);
}

export function resolveAs(m: DigitalServicesMarketplace, arbiterId: string, orderId: string, resolution: DisputeResolution): SettlementRecord {
  return m.resolveDispute(orderId, act(m, arbiterId, "resolve", orderId, { outcome: resolution.outcome, providerAmount: resolution.outcome === "SPLIT" ? resolution.providerAmount : null }), resolution);
}

export function refundAs(m: DigitalServicesMarketplace, providerId: string, orderId: string): SettlementRecord {
  return m.refundBuyer(orderId, act(m, providerId, "refund", orderId));
}

export function reviewAs(m: DigitalServicesMarketplace, buyerId: string, orderId: string, rating: 1 | 2 | 3 | 4 | 5) {
  return m.recordSellerReview({ orderId, rating }, act(m, buyerId, "review", orderId, { rating }));
}

/** Buyer-signed cancellation. */
export function cancelAsBuyer(m: DigitalServicesMarketplace, orderId: string, buyerId: string): ServiceOrder {
  const identity = registry.get(m)?.get(buyerId);
  if (!identity) throw new Error("TESTKIT_IDENTITY_UNKNOWN");
  return m.cancel(orderId, { actorId: buyerId, signature: signCancellation({ marketplaceId: m.marketplaceId, orderId, buyerId }, identity.privateKey) });
}

/** Signature for an IoT requestService() call by an enrolled buyer. */
export function iotAuthorization(m: DigitalServicesMarketplace, input: { listingId: string; buyerId: string; quantity: bigint; idempotencyKey: string }): string {
  const identity = registry.get(m)?.get(input.buyerId) ?? enrollIdentity(m, input.buyerId);
  return signReservation({ marketplaceId: m.marketplaceId, ...input }, identity.privateKey);
}

/** v0.4.7: credit signed by `actorId` (the administrator when `requireSignedCredits` is set). */
export function creditAs(m: DigitalServicesMarketplace, actorId: string, identityId: string, asset: string, amount: bigint, creditId: string): bigint {
  return m.creditAccount(identityId, asset, amount, { creditId, auth: act(m, actorId, "credit", identityId, { asset, amount, creditId }) });
}

/**
 * v0.5.3 (snapshot format 4): carry the testkit's identities and order -> buyer
 * records from `from` to a Marketplace restored from its snapshot, so the
 * helpers keep signing with the same (ephemeral, in-memory) keys after a restart.
 */
export function adoptTestIdentities(from: DigitalServicesMarketplace, to: DigitalServicesMarketplace): void {
  const ids = registry.get(from);
  if (ids) registry.set(to, new Map(ids));
  const buyers = orderBuyers.get(from);
  if (buyers) orderBuyers.set(to, new Map(buyers));
}
