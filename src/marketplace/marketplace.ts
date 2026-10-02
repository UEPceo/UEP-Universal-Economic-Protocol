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
  BPS_DENOMINATOR,
  MarketplaceTreasury,
  type TreasurySnapshot,
  type TreasuryBucket,
  type TreasuryBalance,
} from "./economy.ts";
import { MarketplacePaymaster, type GasQuote } from "./paymaster.ts";
import type { KeyObject } from "node:crypto";
import { publicKeyHexOf, toPublicKey, verifyEd25519, type PublicKeyLike } from "../core/ed25519.ts";
import { DEFAULT_MARKETPLACE_ID, cancellationMessage, reservationMessage } from "./identity.ts";

export const MARKETPLACE_VERSION = "0.3" as const;

/** Default reservation deposit: 1.00% of the order's gross amount (same bps model as the Marketplace fee). */
export const DEFAULT_RESERVATION_DEPOSIT_BPS = 100;
/** Minimum default reservation deposit (smallest asset unit), so no reservation is free by default. */
export const MIN_RESERVATION_DEPOSIT = 1n;
/** Default buyer cancellation grace window: the deposit is refunded if the buyer cancels within it. */
export const DEFAULT_CANCELLATION_GRACE_MS = 2 * 60 * 1000;
/** Default reservation TTL. */
export const DEFAULT_RESERVATION_TTL_MS = 10 * 60 * 1000;
/** Default limit of concurrent open reservations per identity. */
export const DEFAULT_MAX_ACTIVE_RESERVATIONS = 8;

export type ServiceCategory = "COMPUTE" | "STORAGE" | "API" | "DATA" | "IOT_M2M";
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
  /** Deposit locked from the buyer's balance at reserve() time; counts toward the payment when funded. */
  reservationDeposit: bigint;
  /** Amount the buyer still has to fund (grossAmount + gasFee - reservationDeposit); 0 once funded. */
  fundingDue: bigint;
  /** Deposit currently locked (unfunded reservation); moves into escrow when funded. */
  depositLocked: bigint;
  /** What happened to the deposit once the reservation closed. */
  depositOutcome?: "APPLIED_TO_PAYMENT" | "REFUNDED" | "FORFEITED_TO_PROVIDER";
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
  /** Authenticated marketplace administrator identity; the legacy literal is permanently reserved. */
  adminIdentity?: string;
  adminAuthorizer?: (actorId: string) => boolean;
  settlementArbiterId?: string;
  deliveryDisputeWindowMs?: number;
  /**
   * Fixed reservation deposit per order. When omitted, the deposit is
   * max(MIN_RESERVATION_DEPOSIT, grossAmount * reservationDepositBps / 10_000).
   * Setting `0n` explicitly disables deposits (not recommended outside tests).
   */
  reservationDeposit?: bigint;
  /** Proportional deposit in basis points when no fixed deposit is set (default 100 = 1%). */
  reservationDepositBps?: number;
  /** Concurrent open (not settled / cancelled / expired) reservations per identity. Default 8. */
  maxActiveReservationsPerIdentity?: number;
  /** Buyer cancellation within this window after reserve() refunds the deposit; later it is forfeited. Default 2 min. */
  cancellationGraceMs?: number;
  /** Domain separator bound into buyer signatures. Default "uep-marketplace-testnet". */
  marketplaceId?: string;
};

export type RegisteredIdentity = { identityId: string; publicKeyHex: string; registeredAt: number };

export type ValueAccounting = {
  asset: string;
  /** External value credited into marketplace accounts (testnet funding rail). */
  credited: bigint;
  available: bigint;
  lockedDeposits: bigint;
  held: bigint;
  marketplaceFees: bigint;
  gasCaptured: bigint;
  /** credited === available + lockedDeposits + held + marketplaceFees + gasCaptured */
  conserved: boolean;
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
  private readonly reservationQueue: Array<{ at: number; orderId: string }> = [];
  private readonly activeReservationsByIdentity = new Map<string, number>();
  private readonly deliveryValidator?: MarketplaceConfig["deliveryValidator"];
  readonly paymaster?: MarketplacePaymaster;
  readonly adminIdentity: string;
  private readonly adminAuthorizer?: (actorId: string) => boolean;
  readonly settlementArbiterId?: string;
  readonly deliveryDisputeWindowMs: number;
  /** Fixed per-order deposit if configured; otherwise the bps-based default applies. */
  readonly fixedReservationDeposit?: bigint;
  readonly reservationDepositBps: number;
  readonly maxActiveReservationsPerIdentity: number;
  readonly cancellationGraceMs: number;
  readonly marketplaceId: string;
  private readonly identities = new Map<string, RegisteredIdentity>();
  private readonly identityKeys = new Map<string, KeyObject>();
  private readonly accounts = new Map<string, bigint>();
  private readonly locked = new Map<string, bigint>();
  private readonly credited = new Map<string, bigint>();
  private readonly feesCollected = new Map<string, bigint>();
  private readonly gasCollected = new Map<string, bigint>();

  constructor(config: MarketplaceConfig = {}) {
    this.treasury = config.treasury ?? new MarketplaceTreasury();
    this.reputation = config.reputation ?? new MarketplaceReputation();
    this.now = config.now ?? (() => Date.now());
    this.reservationTtlMs = config.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
    this.maxListingsPerWindow = config.maxListingsPerWindow ?? 10;
    this.listingWindowMs = config.listingWindowMs ?? 60 * 60 * 1000;
    this.deliveryValidator = config.deliveryValidator;
    this.paymaster = config.paymaster;
    this.adminIdentity = config.adminIdentity ?? "uep:marketplace-admin";
    if (this.adminIdentity === "marketplace-admin") throw new Error("LEGACY_ADMIN_ID_RESERVED");
    this.adminAuthorizer = config.adminAuthorizer;
    this.settlementArbiterId = config.settlementArbiterId;
    this.deliveryDisputeWindowMs = config.deliveryDisputeWindowMs ?? 24 * 60 * 60 * 1000;
    this.fixedReservationDeposit = config.reservationDeposit;
    this.reservationDepositBps = config.reservationDepositBps ?? DEFAULT_RESERVATION_DEPOSIT_BPS;
    this.maxActiveReservationsPerIdentity = config.maxActiveReservationsPerIdentity ?? DEFAULT_MAX_ACTIVE_RESERVATIONS;
    this.cancellationGraceMs = config.cancellationGraceMs ?? DEFAULT_CANCELLATION_GRACE_MS;
    this.marketplaceId = config.marketplaceId ?? DEFAULT_MARKETPLACE_ID;
    if (!Number.isSafeInteger(this.reservationTtlMs) || this.reservationTtlMs <= 0 || !Number.isSafeInteger(this.cancellationGraceMs) || this.cancellationGraceMs < 0) throw new Error("INVALID_RESERVATION_LIMIT");
    if ((this.fixedReservationDeposit !== undefined && this.fixedReservationDeposit < 0n) || !Number.isInteger(this.reservationDepositBps) || this.reservationDepositBps < 0 || this.reservationDepositBps > 10_000 || !Number.isInteger(this.maxActiveReservationsPerIdentity) || this.maxActiveReservationsPerIdentity < 1) throw new Error("INVALID_RESERVATION_LIMIT");
  }

  /**
   * Reservation deposit for an order: locked from the buyer's balance at reserve(),
   * applied to the payment when funded, refunded on cancel within the grace window,
   * otherwise forfeited to the provider. Never more than the order total.
   */
  reservationDepositFor(grossAmount: bigint, gasFee = 0n): bigint {
    const base = this.fixedReservationDeposit !== undefined
      ? this.fixedReservationDeposit
      : (() => { const proportional = (grossAmount * BigInt(this.reservationDepositBps)) / BPS_DENOMINATOR; return proportional > MIN_RESERVATION_DEPOSIT ? proportional : MIN_RESERVATION_DEPOSIT; })();
    const total = grossAmount + gasFee;
    return base < total ? base : total;
  }

  /**
   * Register an identity's Ed25519 public key. Only registered identities can
   * reserve or receive testnet credits. Registration is first-come and immutable.
   */
  registerIdentity(identityId: string, publicKey: PublicKeyLike): RegisteredIdentity {
    if (!identityId || typeof identityId !== "string") throw new Error("IDENTITY_ID_REQUIRED");
    if (identityId === "marketplace-admin" || identityId === this.adminIdentity || identityId === this.settlementArbiterId) throw new Error("RESERVED_IDENTITY");
    if (this.identities.has(identityId)) throw new Error("IDENTITY_ALREADY_REGISTERED");
    let keyObject: KeyObject;
    try { keyObject = toPublicKey(publicKey); } catch { throw new Error("IDENTITY_PUBLIC_KEY_INVALID"); }
    const record: RegisteredIdentity = { identityId, publicKeyHex: publicKeyHexOf(keyObject), registeredAt: this.now() };
    this.identities.set(identityId, record);
    this.identityKeys.set(identityId, keyObject);
    return { ...record };
  }

  isIdentityRegistered(identityId: string): boolean {
    return this.identities.has(identityId);
  }

  registeredIdentity(identityId: string): RegisteredIdentity {
    const record = this.identities.get(identityId);
    if (!record) throw new Error("IDENTITY_NOT_REGISTERED");
    return { ...record };
  }

  /**
   * Testnet funding rail: credit external value to a registered identity's
   * marketplace account. Production custody / payment rails remain external.
   */
  creditAccount(identityId: string, asset: string, amount: bigint): bigint {
    if (!this.identities.has(identityId)) throw new Error("IDENTITY_NOT_REGISTERED");
    if (!asset) throw new Error("ASSET_REQUIRED");
    if (amount <= 0n) throw new Error("INVALID_CREDIT_AMOUNT");
    this.add(this.accounts, key(asset, identityId), amount);
    this.add(this.credited, asset, amount);
    return this.availableBalance(asset, identityId);
  }

  /** Spendable marketplace balance (provider earnings, refunds and credits). */
  availableBalance(asset: string, identityId: string): bigint {
    return this.accounts.get(key(asset, identityId)) ?? 0n;
  }

  /** Reservation deposits currently locked for an identity. */
  lockedDeposit(asset: string, identityId: string): bigint {
    return this.locked.get(key(asset, identityId)) ?? 0n;
  }

  /** Conservation check across every deposit / escrow path for one asset. */
  valueAccounting(asset: string): ValueAccounting {
    this.reapExpiredReservations();
    const sum = (m: Map<string, bigint>) => [...m.entries()].filter(([k]) => k.startsWith(`${asset}:`)).reduce((a, [, v]) => a + v, 0n);
    const credited = this.credited.get(asset) ?? 0n;
    const available = sum(this.accounts);
    const lockedDeposits = sum(this.locked);
    const held = sum(this.held);
    const marketplaceFees = this.feesCollected.get(asset) ?? 0n;
    const gasCaptured = this.gasCollected.get(asset) ?? 0n;
    return { asset, credited, available, lockedDeposits, held, marketplaceFees, gasCaptured, conserved: credited === available + lockedDeposits + held + marketplaceFees + gasCaptured };
  }

  publishListing(input: Omit<ServiceListing, "listingId" | "available" | "active" | "sellerBond" | "catalogFingerprint"> & { listingId?: string; sellerBond?: bigint }): ServiceListing {
    if (!input.providerId || !input.title || !input.asset) throw new Error("LISTING_METADATA_REQUIRED");
    if (input.providerId === "marketplace-admin" || input.providerId === this.adminIdentity) throw new Error("RESERVED_IDENTITY");
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

  /**
   * Reserve capacity. Fail-closed: the buyer must be a registered identity, the
   * request must carry the buyer's Ed25519 signature (see signReservation) and
   * the reservation deposit is locked from the buyer's available balance.
   */
  reserve(input: { listingId: string; buyerId: string; quantity: bigint; idempotencyKey: string; signature: string; orderId?: string; gasQuote?: GasQuote }): ServiceOrder {
    this.assertReservationAuthorized(input);
    // A signed request authorizes at most one reservation: replays return the same order.
    const previous = this.orderIdempotency.get(`${input.buyerId}:${input.idempotencyKey}`);
    if (previous) return { ...this.order(previous) };
    this.reapExpiredReservations();
    const listing = this.listings.get(input.listingId);
    if (!listing || !listing.active) throw new Error("LISTING_NOT_FOUND");
    if (input.quantity <= 0n || input.quantity > listing.available) throw new Error("INSUFFICIENT_CAPACITY");
    const activeReservations = this.activeReservationsByIdentity.get(input.buyerId) ?? 0;
    if (activeReservations >= this.maxActiveReservationsPerIdentity) throw new Error("RESERVATION_LIMIT_REACHED");
    // This synchronous state transition is atomic within the process: the availability check and decrement
    // happen in one turn. Production SQL adapters MUST use an atomic conditional UPDATE/SELECT FOR UPDATE.
    const grossAmount = input.quantity * listing.unitPrice;
    if (input.gasQuote && !this.paymaster) throw new Error("PAYMASTER_NOT_CONFIGURED");
    if (input.gasQuote && input.gasQuote.asset !== listing.asset) throw new Error("GAS_ASSET_MISMATCH");
    const orderId = input.orderId ?? makeId("ord", `${listing.listingId}|${input.buyerId}|${input.quantity}`, ++this.sequence);
    if (this.orders.has(orderId)) throw new Error("ORDER_ID_CONFLICT");
    const gasFee = input.gasQuote?.gasFee ?? 0n;
    const deposit = this.reservationDepositFor(grossAmount, gasFee);
    const buyerKey = key(listing.asset, input.buyerId);
    // No reservation without funds.
    if (this.availableBalance(listing.asset, input.buyerId) < deposit) throw new Error("INSUFFICIENT_FUNDS_FOR_DEPOSIT");
    listing.available -= input.quantity;
    this.add(this.accounts, buyerKey, -deposit);
    this.add(this.locked, buyerKey, deposit);
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
      reservationDeposit: deposit,
      fundingDue: grossAmount + gasFee - deposit,
      depositLocked: deposit,
      gasFee,
      gasQuoteId: input.gasQuote?.quoteId,
      marketplaceFeeEstimate: this.treasury.quote(grossAmount, listing.asset).marketplaceFee,
      providerNetEstimate: this.treasury.quote(grossAmount, listing.asset).providerNet,
      createdAt: now,
      updatedAt: now,
      reservationExpiresAt: now + this.reservationTtlMs,
    };
    this.orders.set(orderId, order);
    this.activeReservationsByIdentity.set(input.buyerId, activeReservations + 1);
    this.enqueueReservation(order);
    if (input.gasQuote && this.paymaster) {
      try {
        this.paymaster.sponsor(orderId, input.gasQuote, this.now());
      } catch (error) {
        listing.available += input.quantity;
        this.add(this.locked, buyerKey, -deposit);
        this.add(this.accounts, buyerKey, deposit);
        this.orders.delete(orderId);
        this.removeQueuedReservation(order);
        this.decrementActiveReservation(input.buyerId);
        throw error;
      }
    }
    this.orderIdempotency.set(`${input.buyerId}:${input.idempotencyKey}`, orderId);
    return { ...order };
  }

  /** Throws unless `buyerId` is registered and `signature` is its valid signReservation() signature. */
  assertReservationAuthorized(input: { listingId: string; buyerId: string; quantity: bigint; idempotencyKey: string; signature: string; orderId?: string; gasQuote?: GasQuote }): void {
    if (!input.buyerId) throw new Error("BUYER_REQUIRED");
    if (input.buyerId === "marketplace-admin" || input.buyerId === this.adminIdentity) throw new Error("RESERVED_IDENTITY");
    const identity = this.identities.get(input.buyerId);
    if (!identity) throw new Error("IDENTITY_NOT_REGISTERED");
    if (!input.idempotencyKey) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    const message = reservationMessage({ marketplaceId: this.marketplaceId, listingId: input.listingId, buyerId: input.buyerId, quantity: input.quantity, idempotencyKey: input.idempotencyKey, orderId: input.orderId, gasQuoteId: input.gasQuote?.quoteId });
    if (!verifyEd25519(message, input.signature, this.identityKeys.get(input.buyerId)!)) throw new Error("RESERVATION_SIGNATURE_INVALID");
  }

  /** Alias of reserve() (same signed, funded, fail-closed rules). */
  acceptOrder(input: { listingId: string; buyerId: string; quantity: bigint; idempotencyKey: string; signature: string; orderId?: string; gasQuote?: GasQuote }): ServiceOrder {
    return this.reserve(input);
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
    // The locked deposit counts toward the payment: the buyer funds the remainder.
    if (amount !== order.fundingDue) throw new Error("HOLD_AMOUNT_MISMATCH");
    const k = key(order.asset, order.buyerId);
    if (this.availableBalance(order.asset, order.buyerId) < amount) throw new Error("INSUFFICIENT_FUNDS");
    this.add(this.accounts, k, -amount);
    this.add(this.locked, k, -order.depositLocked);
    this.add(this.held, k, amount + order.depositLocked);
    order.heldAmount = amount + order.depositLocked;
    order.depositLocked = 0n;
    order.fundingDue = 0n;
    order.depositOutcome = "APPLIED_TO_PAYMENT";
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

  settle(orderId: string, actorId?: string): SettlementRecord {
    const order = this.order(orderId);
    this.assertActorAuthenticated(actorId);
    const isAdmin = this.isAdmin(actorId!);
    const isBuyer = actorId === order.buyerId;
    const isArbiter = !!this.settlementArbiterId && actorId === this.settlementArbiterId;
    const deadlinePassed = order.deliveryHash !== undefined && this.now() >= order.updatedAt + this.deliveryDisputeWindowMs;
    if (!isBuyer && !isArbiter && !(deadlinePassed && !isAdmin)) throw new Error("SETTLEMENT_NOT_AUTHORIZED");
    if (!isBuyer && !isArbiter && !isAdmin && !deadlinePassed) throw new Error("SETTLEMENT_DISPUTE_WINDOW_ACTIVE");
    if (isAdmin && !this.isAdmin(actorId!)) throw new Error("ADMIN_NOT_AUTHORIZED");
    if (order.status !== "DELIVERED") this.assertReservationLive(order);
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
    this.add(this.accounts, key(order.asset, order.providerId), quote.providerNet);
    this.add(this.feesCollected, order.asset, quote.marketplaceFee);
    this.add(this.gasCollected, order.asset, order.gasFee ?? 0n);
    order.heldAmount = 0n;
    order.settledFee = quote.marketplaceFee;
    order.providerPayout = quote.providerNet;
    order.status = "SETTLED";
    order.updatedAt = this.now();
    this.decrementActiveReservation(order.buyerId);
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

  /**
   * Cancel an open order.
   *  - Buyer (signature required, see signCancellation): within `cancellationGraceMs`
   *    of reserve() the deposit is refunded; afterwards it is forfeited to the provider.
   *    Any funded remainder is refunded.
   *  - Provider or authorized admin: the buyer is refunded in full.
   */
  cancel(orderId: string, actorId: string | undefined, options: string | { reason?: string; signature?: string } = "buyer_or_provider_cancelled"): ServiceOrder {
    const order = this.order(orderId);
    this.assertActorAuthenticated(actorId);
    const isAdmin = this.isAdmin(actorId!);
    const isBuyer = actorId === order.buyerId;
    if (!isAdmin && !isBuyer && actorId !== order.providerId) throw new Error("ORDER_ACCESS_FORBIDDEN");
    if (order.status === "SETTLED") throw new Error("ORDER_ALREADY_SETTLED");
    if (order.status === "DELIVERED") throw new Error("DELIVERED_ORDER_NOT_CANCELLABLE");
    if (order.status === "CANCELLED" || order.status === "EXPIRED") return { ...order };
    const forfeit = isBuyer && !isAdmin && actorId !== order.providerId;
    if (forfeit) {
      const signature = typeof options === "string" ? undefined : options.signature;
      const identity = this.identities.get(order.buyerId);
      if (!signature || !identity) throw new Error("BUYER_SIGNATURE_REQUIRED");
      if (!verifyEd25519(cancellationMessage({ marketplaceId: this.marketplaceId, orderId: order.orderId, buyerId: order.buyerId }), signature, this.identityKeys.get(order.buyerId)!)) throw new Error("CANCELLATION_SIGNATURE_INVALID");
    }
    const withinGrace = this.now() - order.createdAt <= this.cancellationGraceMs;
    this.closeOrder(order, "CANCELLED", forfeit && !withinGrace);
    return { ...order };
  }

  expire(orderId: string, actorId?: string): ServiceOrder {
    const order = this.order(orderId);
    this.assertActorAuthenticated(actorId);
    const isAdmin = this.isAdmin(actorId!);
    const isBuyer = actorId === order.buyerId;
    const isProvider = actorId === order.providerId;
    if (!isAdmin && !isBuyer && !isProvider) throw new Error("ORDER_ACTION_FORBIDDEN");
    if (order.status === "SETTLED") throw new Error("ORDER_ALREADY_SETTLED");
    if (order.status === "DELIVERED") throw new Error("DELIVERED_ORDER_NOT_EXPIRABLE");
    if (order.status === "CANCELLED" || order.status === "EXPIRED") return { ...order };
    // Expiry is a TTL outcome, never an early exit (it can forfeit the deposit).
    if (order.reservationExpiresAt === undefined || this.now() < order.reservationExpiresAt) throw new Error("RESERVATION_NOT_EXPIRED");
    this.closeOrder(order, "EXPIRED", order.status === "ACCEPTED");
    return { ...order };
  }

  getOrder(orderId: string, actorId?: string): ServiceOrder {
    const order = this.order(orderId);
    this.assertActorAuthenticated(actorId);
    if (!this.isAdmin(actorId!) && actorId !== order.buyerId && actorId !== order.providerId) throw new Error("ORDER_ACCESS_FORBIDDEN");
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
    while (this.reservationQueue.length > 0 && this.reservationQueue[0]!.at <= now) {
      const entry = this.reservationQueue.shift()!;
      const order = this.orders.get(entry.orderId);
      if (!order || order.reservationExpiresAt !== entry.at) continue;
      if (order.status !== "ACCEPTED" && order.status !== "HELD") continue;
      // Unfunded expiry forfeits the deposit to the provider; a funded order that the
      // provider did not deliver in time is refunded to the buyer in full.
      this.closeOrder(order, "EXPIRED", order.status === "ACCEPTED");
      expired++;
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
    return { listingId, quantity, asset: listing.asset, unitPrice: listing.unitPrice, grossAmount, marketplaceFee: quote.marketplaceFee, providerNet: quote.providerNet, feeBps: quote.feeBps, gasFee: gasQuote?.gasFee ?? 0n, reservationDeposit: this.reservationDepositFor(grossAmount, gasQuote?.gasFee ?? 0n), buyerTotal: grossAmount + (gasQuote?.gasFee ?? 0n), dueAtFunding: grossAmount + (gasQuote?.gasFee ?? 0n) - this.reservationDepositFor(grossAmount, gasQuote?.gasFee ?? 0n), gasQuote, reservationTtlMs: this.reservationTtlMs, cancellationGraceMs: this.cancellationGraceMs, maxActiveReservationsPerIdentity: this.maxActiveReservationsPerIdentity };
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

  private assertActorAuthenticated(actorId?: string): void {
    if (!actorId) throw new Error("AUTHENTICATED_IDENTITY_REQUIRED");
    if (actorId === "marketplace-admin") throw new Error("LEGACY_ADMIN_ID_RESERVED");
  }

  private isAdmin(actorId: string): boolean {
    return actorId === this.adminIdentity && (!!this.adminAuthorizer ? this.adminAuthorizer(actorId) : false);
  }

  private enqueueReservation(order: ServiceOrder): void {
    if (order.reservationExpiresAt === undefined) return;
    // Binary insertion keeps the queue ordered in O(log n) comparisons (no full re-sort per order).
    const entry = { at: order.reservationExpiresAt, orderId: order.orderId };
    let lo = 0, hi = this.reservationQueue.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.reservationQueue[mid]!.at <= entry.at) lo = mid + 1; else hi = mid; }
    this.reservationQueue.splice(lo, 0, entry);
  }

  /** Close an open (ACCEPTED / HELD) order, moving every unit of value exactly once. */
  private closeOrder(order: ServiceOrder, status: "CANCELLED" | "EXPIRED", forfeitDeposit: boolean): void {
    const buyerKey = key(order.asset, order.buyerId);
    const providerKey = key(order.asset, order.providerId);
    let refund = 0n;
    let deposit = 0n;
    if (order.status === "ACCEPTED") {
      if (this.lockedDeposit(order.asset, order.buyerId) < order.depositLocked) throw new Error("LOCKED_DEPOSIT_INSUFFICIENT");
      this.add(this.locked, buyerKey, -order.depositLocked);
      deposit = order.depositLocked;
      order.depositLocked = 0n;
    } else if (order.status === "HELD") {
      const held = this.held.get(buyerKey) ?? 0n;
      if (held < order.heldAmount) throw new Error("HELD_BALANCE_INSUFFICIENT");
      this.add(this.held, buyerKey, -order.heldAmount);
      deposit = order.reservationDeposit;
      refund = order.heldAmount - deposit;
      order.heldAmount = 0n;
    }
    if (forfeitDeposit) {
      this.add(this.accounts, providerKey, deposit);
      order.depositOutcome = "FORFEITED_TO_PROVIDER";
    } else {
      refund += deposit;
      order.depositOutcome = "REFUNDED";
    }
    if (refund > 0n) this.add(this.accounts, buyerKey, refund);
    order.fundingDue = 0n;
    this.releasePaymaster(order);
    this.listing(order.listingId).available += order.quantity;
    order.status = status;
    order.updatedAt = this.now();
    this.decrementActiveReservation(order.buyerId);
  }

  private add(map: Map<string, bigint>, k: string, delta: bigint): void {
    const next = (map.get(k) ?? 0n) + delta;
    if (next < 0n) throw new Error("ACCOUNTING_UNDERFLOW");
    if (next === 0n) map.delete(k);
    else map.set(k, next);
  }

  private removeQueuedReservation(order: ServiceOrder): void {
    const i = this.reservationQueue.findIndex((e) => e.orderId === order.orderId);
    if (i >= 0) this.reservationQueue.splice(i, 1);
  }

  private decrementActiveReservation(buyerId: string): void {
    const current = this.activeReservationsByIdentity.get(buyerId) ?? 0;
    if (current <= 1) this.activeReservationsByIdentity.delete(buyerId);
    else this.activeReservationsByIdentity.set(buyerId, current - 1);
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
      this.reapExpiredReservations();
      throw new Error("RESERVATION_EXPIRED");
    }
  }

  private order(orderId: string): ServiceOrder {
    const order = this.orders.get(orderId);
    if (!order) throw new Error("ORDER_NOT_FOUND");
    return order;
  }
}
