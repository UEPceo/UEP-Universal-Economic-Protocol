/**
 * UEP Digital Services Marketplace v0.1
 *
 * Business-layer marketplace lifecycle. This module is intentionally separate
 * from UEP consensus/ZK/SMT. It accounts for HOLD -> DELIVERY -> SETTLEMENT
 * and delegates marketplace fee accounting to MarketplaceTreasury.
 * Production payment/custody remains external until a real payment rail is wired.
 */
import { createHash } from "node:crypto";
import { MarketplaceReputation, type SellerReputation } from "./reputation.ts";
import { contentHash, verifyContentHash } from "../service/content-hash.ts";
import {
  MarketplaceTreasury,
  type TreasurySnapshot,
  type TreasuryBucket,
  type TreasuryBalance,
} from "./economy.ts";
import { MarketplacePaymaster, type GasQuote } from "./paymaster.ts";

export const MARKETPLACE_VERSION = "0.2" as const;

export type ServiceCategory = "COMPUTE" | "STORAGE" | "API" | "DATA";
export type OrderStatus = "ACCEPTED" | "HELD" | "DELIVERED" | "SETTLED" | "CANCELLED" | "EXPIRED";

export type ServiceListing = {
  listingId: string;
  providerId: string;
  title: string;
  description: string;
  category: ServiceCategory;
  asset: string;
  unitPrice: bigint;
  capacity: bigint;
  available: bigint;
  active: boolean;
  sellerBond: bigint;
  catalogFingerprint: string;
};

export type ServiceOrder = {
  orderId: string;
  listingId: string;
  buyerId: string;
  providerId: string;
  asset: string;
  quantity: bigint;
  grossAmount: bigint;
  status: OrderStatus;
  heldAmount: bigint;
  marketplaceFeeEstimate: bigint;
  providerNetEstimate: bigint;
  deliveryHash?: string;
  gasFee?: bigint;
  gasQuoteId?: string;
  settledFee?: bigint;
  providerPayout?: bigint;
  createdAt: number;
  updatedAt: number;
  reservationExpiresAt?: number;
};

export type SettlementRecord = {
  orderId: string;
  asset: string;
  grossAmount: bigint;
  marketplaceFee: bigint;
  providerPayout: bigint;
  treasuryId: string;
  settledAt: number;
  gasFee?: bigint;
};

export type MarketplaceConfig = {
  treasury?: MarketplaceTreasury;
  reputation?: MarketplaceReputation;
  now?: () => number;
  reservationTtlMs?: number;
  maxListingsPerWindow?: number;
  listingWindowMs?: number;
  deliveryValidator?: (order: ServiceOrder, bytes: Uint8Array | Buffer) => { ok: boolean; reason?: string };
  paymaster?: MarketplacePaymaster;
};

function normalizeCatalogText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function tokenSimilarity(a: string, b: string): number {
  const aa = new Set(normalizeCatalogText(a).split(" ").filter(Boolean));
  const bb = new Set(normalizeCatalogText(b).split(" ").filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  let intersection = 0;
  for (const token of aa) if (bb.has(token)) intersection++;
  return intersection / (aa.size + bb.size - intersection);
}

function catalogFingerprint(input: { providerId: string; title: string; description: string; category: string; asset: string }): string {
  return createHash("sha256").update(JSON.stringify({
    providerId: input.providerId,
    title: normalizeCatalogText(input.title),
    description: normalizeCatalogText(input.description),
    category: input.category,
    asset: input.asset,
  })).digest("hex");
}

function key(asset: string, account: string): string {
  return `${asset}:${account}`;
}

function makeId(prefix: string, payload: string, counter: number): string {
  const digest = createHash("sha256").update(`${prefix}|${counter}|${payload}`).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

export class DigitalServicesMarketplace {
  readonly version = MARKETPLACE_VERSION;
  readonly treasury: MarketplaceTreasury;
  private readonly now: () => number;
  private sequence = 0;
  private readonly listings = new Map<string, ServiceListing>();
  private readonly orders = new Map<string, ServiceOrder>();
  private readonly held = new Map<string, bigint>();
  private readonly settlements = new Map<string, SettlementRecord>();
  readonly reputation: MarketplaceReputation;
  readonly reservationTtlMs: number;
  private readonly maxListingsPerWindow: number;
  private readonly listingWindowMs: number;
  private readonly listingAttempts = new Map<string, number[]>();
  private readonly orderIdempotency = new Map<string, string>();
  private readonly operationIdempotency = new Map<string, string>();
  private readonly listingIndex = new Map<string, Set<string>>();
  private readonly deliveryValidator?: MarketplaceConfig["deliveryValidator"];
  readonly paymaster?: MarketplacePaymaster;

  constructor(config: MarketplaceConfig = {}) {
    this.treasury = config.treasury ?? new MarketplaceTreasury();
    this.reputation = config.reputation ?? new MarketplaceReputation();
    this.now = config.now ?? (() => Date.now());
    this.reservationTtlMs = config.reservationTtlMs ?? 10 * 60 * 1000;
    this.maxListingsPerWindow = config.maxListingsPerWindow ?? 10;
    this.listingWindowMs = config.listingWindowMs ?? 60 * 60 * 1000;
    this.deliveryValidator = config.deliveryValidator;
    this.paymaster = config.paymaster;
  }

  publishListing(input: Omit<ServiceListing, "listingId" | "available" | "active" | "sellerBond" | "catalogFingerprint"> & { listingId?: string; sellerBond?: bigint }): ServiceListing {
    if (!input.providerId || !input.title || !input.asset) throw new Error("LISTING_METADATA_REQUIRED");
    if (input.unitPrice <= 0n || input.capacity <= 0n) throw new Error("INVALID_LISTING_ECONOMICS");
    const now = this.now();
    const recent = (this.listingAttempts.get(input.providerId) ?? []).filter((t) => now - t < this.listingWindowMs);
    if (recent.length >= this.maxListingsPerWindow) throw new Error("LISTING_RATE_LIMITED");
    const fingerprint = catalogFingerprint(input);
    if ([...this.listings.values()].some((l) => l.active && l.catalogFingerprint === fingerprint)) throw new Error("DUPLICATE_LISTING_FINGERPRINT");
    if ([...this.listings.values()].some((l) => l.active && l.providerId === input.providerId && l.category === input.category && l.asset === input.asset && tokenSimilarity(l.title, input.title) >= 0.9)) throw new Error("SIMILAR_LISTING_FINGERPRINT");
    const listingId = input.listingId ?? makeId("lst", `${input.providerId}|${input.title}|${input.asset}`, ++this.sequence);
    if (this.listings.has(listingId)) throw new Error("LISTING_ALREADY_EXISTS");
    recent.push(now);
    this.listingAttempts.set(input.providerId, recent);
    const listing: ServiceListing = { ...input, listingId, available: input.capacity, active: true, sellerBond: input.sellerBond ?? 0n, catalogFingerprint: fingerprint };
    this.listings.set(listingId, listing);
    const indexKey = `${listing.category}:${listing.asset}`;
    const bucket = this.listingIndex.get(indexKey) ?? new Set<string>();
    bucket.add(listingId);
    this.listingIndex.set(indexKey, bucket);
    return { ...listing };
  }

  getListing(listingId: string): ServiceListing {
    this.reapExpiredReservations();
    const listing = this.listings.get(listingId);
    if (!listing) throw new Error("LISTING_NOT_FOUND");
    return { ...listing };
  }

  searchListings(query?: { category?: ServiceCategory; asset?: string; providerId?: string; activeOnly?: boolean; offset?: number; limit?: number }): ServiceListing[] {
    this.reapExpiredReservations();
    const activeOnly = query?.activeOnly ?? true;
    const offset = Math.max(0, query?.offset ?? 0);
    const limit = Math.min(200, Math.max(1, query?.limit ?? 50));
    const candidates = query?.category && query?.asset
      ? [...(this.listingIndex.get(`${query.category}:${query.asset}`) ?? new Set<string>())].map((id) => this.listings.get(id)!).filter(Boolean)
      : [...this.listings.values()];
    return candidates
      .filter((l) => !activeOnly || l.active)
      .filter((l) => !query?.category || l.category === query.category)
      .filter((l) => !query?.asset || l.asset === query.asset)
      .filter((l) => !query?.providerId || l.providerId === query.providerId)
      .slice(offset, offset + limit)
      .map((l) => ({ ...l }));
  }

  acceptOrder(input: { listingId: string; buyerId: string; quantity: bigint; orderId?: string; idempotencyKey?: string; gasQuote?: GasQuote }): ServiceOrder {
    const listing = this.listings.get(input.listingId);
    if (!listing || !listing.active) throw new Error("LISTING_NOT_FOUND");
    if (!input.buyerId) throw new Error("BUYER_REQUIRED");
    if (input.idempotencyKey) {
      const previous = this.orderIdempotency.get(`${input.buyerId}:${input.idempotencyKey}`);
      if (previous) return { ...this.order(previous) };
    }
    if (input.quantity <= 0n || input.quantity > listing.available) throw new Error("INSUFFICIENT_CAPACITY");
    // This synchronous state transition is atomic within the process: the availability check and decrement
    // happen in one turn. Production SQL adapters MUST use an atomic conditional UPDATE/SELECT FOR UPDATE.
    const grossAmount = input.quantity * listing.unitPrice;
    if (input.gasQuote && !this.paymaster) throw new Error("PAYMASTER_NOT_CONFIGURED");
    if (input.gasQuote && input.gasQuote.asset !== listing.asset) throw new Error("GAS_ASSET_MISMATCH");
    const orderId = input.orderId ?? makeId("ord", `${listing.listingId}|${input.buyerId}|${input.quantity}`, ++this.sequence);
    const existing = this.orders.get(orderId);
    if (existing) return { ...existing };
    listing.available -= input.quantity;
    const now = this.now();
    const order: ServiceOrder = {
      orderId,
      listingId: listing.listingId,
      buyerId: input.buyerId,
      providerId: listing.providerId,
      asset: listing.asset,
      quantity: input.quantity,
      grossAmount,
      status: "ACCEPTED",
      heldAmount: 0n,
      gasFee: input.gasQuote?.gasFee ?? 0n,
      gasQuoteId: input.gasQuote?.quoteId,
      marketplaceFeeEstimate: this.treasury.quote(grossAmount, listing.asset).marketplaceFee,
      providerNetEstimate: this.treasury.quote(grossAmount, listing.asset).providerNet,
      createdAt: now,
      updatedAt: now,
      reservationExpiresAt: now + this.reservationTtlMs,
    };
    this.orders.set(orderId, order);
    if (input.gasQuote && this.paymaster) {
      try {
        this.paymaster.sponsor(orderId, input.gasQuote, this.now());
      } catch (error) {
        listing.available += input.quantity;
        this.orders.delete(orderId);
        throw error;
      }
    }
    if (input.idempotencyKey) this.orderIdempotency.set(`${input.buyerId}:${input.idempotencyKey}`, orderId);
    return { ...order };
  }

  fundOrder(orderId: string, amount: bigint, idempotencyKey?: string): ServiceOrder {
    if (idempotencyKey) {
      const previous = this.operationIdempotency.get(`fund:${orderId}:${idempotencyKey}`);
      if (previous) {
        if (previous !== `${orderId}:${amount.toString()}`) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
        return { ...this.order(orderId) };
      }
    }
    const order = this.order(orderId);
    this.assertReservationLive(order);
    if (order.status !== "ACCEPTED") throw new Error("ORDER_NOT_FUNDABLE");
    const required = order.grossAmount + (order.gasFee ?? 0n);
    if (amount !== required) throw new Error("HOLD_AMOUNT_MISMATCH");
    const k = key(order.asset, order.buyerId);
    this.held.set(k, (this.held.get(k) ?? 0n) + amount);
    order.heldAmount = amount;
    order.status = "HELD";
    order.updatedAt = this.now();
    if (idempotencyKey) this.operationIdempotency.set(`fund:${orderId}:${idempotencyKey}`, `${orderId}:${amount.toString()}`);
    return { ...order };
  }

  deliver(orderId: string, providerId: string, bytes: Uint8Array | Buffer, idempotencyKey?: string): ServiceOrder {
    if (idempotencyKey) {
      const previous = this.operationIdempotency.get(`deliver:${orderId}:${idempotencyKey}`);
      if (previous) {
        if (previous !== orderId) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
        return { ...this.order(orderId) };
      }
    }
    const order = this.order(orderId);
    this.assertReservationLive(order);
    if (order.status !== "HELD") throw new Error("ORDER_NOT_DELIVERABLE");
    if (providerId !== order.providerId) throw new Error("PROVIDER_NOT_AUTHORIZED");
    if (this.deliveryValidator) {
      const validation = this.deliveryValidator(order, bytes);
      if (!validation.ok) throw new Error(`DELIVERY_VALIDATION_FAILED:${validation.reason ?? "INVALID_DELIVERY"}`);
    }
    const hash = contentHash(bytes);
    order.deliveryHash = hash;
    order.status = "DELIVERED";
    order.updatedAt = this.now();
    if (idempotencyKey) this.operationIdempotency.set(`deliver:${orderId}:${idempotencyKey}`, orderId);
    return { ...order };
  }

  deliverWithExpectedHash(orderId: string, providerId: string, bytes: Uint8Array | Buffer, expectedHash: string, idempotencyKey?: string): ServiceOrder {
    const check = verifyContentHash(bytes, expectedHash);
    if (!check.ok) throw new Error(check.reason);
    return this.deliver(orderId, providerId, bytes, idempotencyKey);
  }

  settle(orderId: string): SettlementRecord {
    const order = this.order(orderId);
    this.assertReservationLive(order);
    if (order.status === "SETTLED") {
      const existing = this.settlements.get(orderId);
      if (existing) return { ...existing };
      throw new Error("SETTLEMENT_RECORD_MISSING");
    }
    if (order.status !== "DELIVERED") throw new Error("ORDER_NOT_SETTLEABLE");
    const required = order.grossAmount + (order.gasFee ?? 0n);
    if (order.heldAmount !== required) throw new Error("HOLD_NOT_COMPLETE");
    const heldKey = key(order.asset, order.buyerId);
    const held = this.held.get(heldKey) ?? 0n;
    if (held < order.heldAmount) throw new Error("HELD_BALANCE_INSUFFICIENT");

    if (order.gasFee && order.gasFee > 0n) {
      if (!this.paymaster || !order.gasQuoteId) throw new Error("PAYMASTER_STATE_MISSING");
      const gasQuote = this.paymaster.sponsoredQuote(order.orderId, order.gasQuoteId);
      if (gasQuote.asset !== order.asset || gasQuote.gasFee !== order.gasFee) throw new Error("GAS_QUOTE_MISMATCH");
      this.paymaster.capture(order.orderId, gasQuote, this.now());
    }
    const quote = this.treasury.settleMarketplaceFee(order.orderId, order.grossAmount, order.asset, this.now());
    this.held.set(heldKey, held - order.heldAmount);
    order.heldAmount = 0n;
    order.settledFee = quote.marketplaceFee;
    order.providerPayout = quote.providerNet;
    order.status = "SETTLED";
    order.updatedAt = this.now();
    const record: SettlementRecord = {
      orderId: order.orderId,
      asset: order.asset,
      grossAmount: order.grossAmount,
      marketplaceFee: quote.marketplaceFee,
      providerPayout: quote.providerNet,
      treasuryId: this.treasury.treasuryId,
      settledAt: order.updatedAt,
      gasFee: order.gasFee ?? 0n,
    };
    this.settlements.set(orderId, record);
    return { ...record };
  }

  cancel(orderId: string, actorId: string, reason = "buyer_or_provider_cancelled"): ServiceOrder {
    const order = this.order(orderId);
    if (actorId !== order.buyerId && actorId !== order.providerId && actorId !== "marketplace-admin") throw new Error("ORDER_ACTION_FORBIDDEN");
    if (order.status === "SETTLED") throw new Error("ORDER_ALREADY_SETTLED");
    if (order.status === "CANCELLED" || order.status === "EXPIRED") return { ...order };
    if (order.status === "HELD") {
      const k = key(order.asset, order.buyerId);
      const held = this.held.get(k) ?? 0n;
      if (held < order.heldAmount) throw new Error("HELD_BALANCE_INSUFFICIENT");
      this.held.set(k, held - order.heldAmount);
      order.heldAmount = 0n;
    }
    this.releasePaymaster(order);
    this.listing(order.listingId).available += order.quantity;
    order.status = "CANCELLED";
    order.updatedAt = this.now();
    void reason;
    return { ...order };
  }

  expire(orderId: string, actorId?: string): ServiceOrder {
    const order = this.order(orderId);
    if (actorId !== "marketplace-admin" && actorId !== "marketplace-system") throw new Error("ORDER_ACTION_FORBIDDEN");
    if (order.status === "SETTLED") throw new Error("ORDER_ALREADY_SETTLED");
    if (order.status === "CANCELLED" || order.status === "EXPIRED") return { ...order };
    if (order.status === "HELD") {
      const k = key(order.asset, order.buyerId);
      const held = this.held.get(k) ?? 0n;
      if (held < order.heldAmount) throw new Error("HELD_BALANCE_INSUFFICIENT");
      this.held.set(k, held - order.heldAmount);
      order.heldAmount = 0n;
    }
    this.releasePaymaster(order);
    this.listing(order.listingId).available += order.quantity;
    order.status = "EXPIRED";
    order.updatedAt = this.now();
    return { ...order };
  }

  getOrder(orderId: string, actorId?: string): ServiceOrder {
    const order = this.order(orderId);
    if (actorId && actorId !== order.buyerId && actorId !== order.providerId && actorId !== "marketplace-admin") throw new Error("ORDER_ACCESS_FORBIDDEN");
    return { ...order };
  }

  recordSellerReview(input: { orderId: string; buyerId: string; rating: 1 | 2 | 3 | 4 | 5 }): SellerReputation {
    const order = this.order(input.orderId);
    if (order.status !== "SETTLED") throw new Error("REVIEW_REQUIRES_SETTLEMENT");
    if (input.buyerId !== order.buyerId) throw new Error("REVIEW_NOT_AUTHORIZED");
    this.reputation.record({ sellerId: order.providerId, buyerId: input.buyerId, orderId: order.orderId, rating: input.rating, settledAmount: order.grossAmount, sellerBond: this.listing(order.listingId).sellerBond, createdAt: order.updatedAt });
    return this.reputation.score(order.providerId, this.now());
  }

  sellerReputation(providerId: string): SellerReputation {
    return this.reputation.score(providerId, this.now());
  }

  listOrders(): ServiceOrder[] {
    return [...this.orders.values()].map((o) => ({ ...o }));
  }

  listOrdersPage(offset = 0, limit = 50, actorId?: string): ServiceOrder[] {
    if (actorId && actorId !== "marketplace-admin") {
      return [...this.orders.values()].filter((o) => o.buyerId === actorId || o.providerId === actorId).slice(Math.max(0, offset), Math.max(0, offset) + Math.min(200, Math.max(1, limit))).map((o) => ({ ...o }));
    }
    return [...this.orders.values()].slice(Math.max(0, offset), Math.max(0, offset) + Math.min(200, Math.max(1, limit))).map((o) => ({ ...o }));
  }

  reapExpiredReservations(): number {
    let expired = 0;
    const now = this.now();
    for (const order of this.orders.values()) {
      if ((order.status === "ACCEPTED" || order.status === "HELD") && order.reservationExpiresAt !== undefined && now > order.reservationExpiresAt) {
        if (order.status === "HELD") {
          const k = key(order.asset, order.buyerId);
          const held = this.held.get(k) ?? 0n;
          this.held.set(k, held >= order.heldAmount ? held - order.heldAmount : 0n);
          order.heldAmount = 0n;
        }
        this.releasePaymaster(order);
        const listing = this.listing(order.listingId);
        listing.available += order.quantity;
        order.status = "EXPIRED";
        order.updatedAt = now;
        expired++;
      }
    }
    return expired;
  }

  feeQuoteFor(grossAmount: bigint, asset: string) {
    return this.treasury.quote(grossAmount, asset);
  }

  checkoutQuote(listingId: string, quantity: bigint, gasUnits = 0n) {
    const listing = this.listing(listingId);
    if (quantity <= 0n || quantity > listing.available) throw new Error("INSUFFICIENT_CAPACITY");
    const grossAmount = quantity * listing.unitPrice;
    const quote = this.treasury.quote(grossAmount, listing.asset);
    const gasQuote = gasUnits > 0n ? (this.paymaster?.quote(listing.asset, gasUnits, this.now()) ?? (() => { throw new Error("PAYMASTER_NOT_CONFIGURED"); })()) : undefined;
    return { listingId, quantity, asset: listing.asset, unitPrice: listing.unitPrice, grossAmount, marketplaceFee: quote.marketplaceFee, providerNet: quote.providerNet, feeBps: quote.feeBps, gasFee: gasQuote?.gasFee ?? 0n, buyerTotal: grossAmount + (gasQuote?.gasFee ?? 0n), gasQuote, reservationTtlMs: this.reservationTtlMs };
  }

  heldBalance(asset: string, buyerId: string): bigint {
    return this.held.get(key(asset, buyerId)) ?? 0n;
  }

  treasuryBalance(asset: string): TreasuryBalance {
    return this.treasury.balanceOf(asset);
  }

  treasurySnapshot(asset: string): TreasurySnapshot {
    return this.treasury.snapshot(asset);
  }

  private releasePaymaster(order: ServiceOrder): void {
    if (order.gasFee && order.gasFee > 0n && order.gasQuoteId && this.paymaster) {
      const quote = this.paymaster.sponsoredQuote(order.orderId, order.gasQuoteId);
      this.paymaster.release(order.orderId, quote);
    }
  }

  private listing(listingId: string): ServiceListing {
    const listing = this.listings.get(listingId);
    if (!listing) throw new Error("LISTING_NOT_FOUND");
    return listing;
  }

  private assertReservationLive(order: ServiceOrder): void {
    if (order.reservationExpiresAt !== undefined && this.now() > order.reservationExpiresAt) {
      this.expire(order.orderId, "marketplace-system");
      throw new Error("RESERVATION_EXPIRED");
    }
  }

  private order(orderId: string): ServiceOrder {
    const order = this.orders.get(orderId);
    if (!order) throw new Error("ORDER_NOT_FOUND");
    return order;
  }
}
