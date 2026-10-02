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
import { DEFAULT_MARKETPLACE_ID, actionMessage, disputeReasonHash, listingTerms, reservationMessage, type ActorAuth, type MarketplaceAction } from "./identity.ts";

export const MARKETPLACE_VERSION = "0.4" as const;

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
/** Default time the arbiter has to resolve an open dispute (7 days). */
export const DEFAULT_DISPUTE_RESOLUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Default validity of a signed read / list authorization (5 minutes, either direction). */
export const DEFAULT_READ_AUTHORIZATION_TTL_MS = 5 * 60 * 1000;
/** Identity strings that can never be registered, listed or used as a buyer (UEP-A09/B12). */
export const RESERVED_IDENTITIES = ["marketplace-admin", "marketplace-system"] as const;

export type DisputeOutcome = "RELEASE" | "REFUND_BUYER" | "SPLIT";
export type DisputeResolution = { outcome: DisputeOutcome; /** SPLIT: part of grossAmount paid to the provider (before the Marketplace fee). */ providerAmount?: bigint };
/** Hooks a category service (e.g. IoT / M2M) attaches to the marketplace. */
export type CategoryServiceHooks = {
  /** Throws to block the normal settle() path (buyer release / provider claim) of an order in this category. */
  settlementGuard?: (order: ServiceOrder) => void;
};
/** Capability returned to the category service: read orders of its own category only. */
export type CategoryServiceAccess = { readOrder(orderId: string): ServiceOrder };

export type ServiceCategory = "COMPUTE" | "STORAGE" | "API" | "DATA" | "IOT_M2M";
export type OrderStatus = "ACCEPTED" | "HELD" | "DELIVERED" | "DISPUTED" | "SETTLED" | "REFUNDED" | "CANCELLED" | "EXPIRED";

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
  /** v0.4.4: amount returned to the buyer by a refund or split outcome. */
  buyerRefund?: bigint;
  /** v0.4.4: when the provider delivered (start of the dispute window). */
  deliveredAt?: number;
  /** v0.4.4: dispute state (hash of the buyer's reason; the text is not stored). */
  disputedAt?: number;
  disputeReasonHash?: string;
  disputeDeadline?: number;
  disputeOutcome?: DisputeOutcome | "WITHDRAWN" | "PROVIDER_REFUND" | "TIMEOUT_REFUND" | "TIMEOUT_RELEASE";
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
  /** v0.4.4: how the order closed (normal release, arbiter split or a refund). */
  outcome?: DisputeOutcome;
  /** v0.4.4: amount returned to the buyer (refund / split), including refunded gas. */
  buyerRefund?: bigint;
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
  /** v0.4.4: Ed25519 public key of `adminIdentity`. Without it no admin action is possible (fail closed). */
  adminPublicKey?: PublicKeyLike;
  /** Optional extra gate evaluated after the admin signature verifies. */
  adminAuthorizer?: (actorId: string) => boolean;
  settlementArbiterId?: string;
  /** v0.4.4: Ed25519 public key of the settlement arbiter (required when settlementArbiterId is set). */
  settlementArbiterPublicKey?: PublicKeyLike;
  /** Buyer dispute window after delivery; the provider can claim only after it (default 24 h). */
  deliveryDisputeWindowMs?: number;
  /** v0.4.4: time the arbiter has to resolve a dispute (default 7 days). */
  disputeResolutionWindowMs?: number;
  /** v0.4.4: outcome applied when a dispute is not resolved in time (default REFUND_BUYER). */
  disputeTimeoutOutcome?: "REFUND_BUYER" | "RELEASE";
  /** v0.4.4: validity window of signed read / list authorizations (default 5 min). */
  readAuthorizationTtlMs?: number;
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
  private readonly adminKey?: KeyObject;
  readonly settlementArbiterId?: string;
  private readonly arbiterKey?: KeyObject;
  readonly deliveryDisputeWindowMs: number;
  readonly disputeResolutionWindowMs: number;
  readonly disputeTimeoutOutcome: "REFUND_BUYER" | "RELEASE";
  readonly readAuthorizationTtlMs: number;
  private readonly categoryServices = new Map<ServiceCategory, CategoryServiceHooks>();
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
    if ((RESERVED_IDENTITIES as readonly string[]).includes(this.adminIdentity)) throw new Error("LEGACY_ADMIN_ID_RESERVED");
    this.adminAuthorizer = config.adminAuthorizer;
    if (config.adminPublicKey !== undefined) {
      try { this.adminKey = toPublicKey(config.adminPublicKey); } catch { throw new Error("ADMIN_PUBLIC_KEY_INVALID"); }
    }
    this.settlementArbiterId = config.settlementArbiterId;
    if (this.settlementArbiterId !== undefined) {
      if (!this.settlementArbiterId || (RESERVED_IDENTITIES as readonly string[]).includes(this.settlementArbiterId) || this.settlementArbiterId === this.adminIdentity) throw new Error("ARBITER_ID_INVALID");
      if (config.settlementArbiterPublicKey === undefined) throw new Error("ARBITER_PUBLIC_KEY_REQUIRED");
      try { this.arbiterKey = toPublicKey(config.settlementArbiterPublicKey); } catch { throw new Error("ARBITER_PUBLIC_KEY_INVALID"); }
    }
    this.deliveryDisputeWindowMs = config.deliveryDisputeWindowMs ?? 24 * 60 * 60 * 1000;
    this.disputeResolutionWindowMs = config.disputeResolutionWindowMs ?? DEFAULT_DISPUTE_RESOLUTION_WINDOW_MS;
    this.disputeTimeoutOutcome = config.disputeTimeoutOutcome ?? "REFUND_BUYER";
    this.readAuthorizationTtlMs = config.readAuthorizationTtlMs ?? DEFAULT_READ_AUTHORIZATION_TTL_MS;
    if (!Number.isSafeInteger(this.deliveryDisputeWindowMs) || this.deliveryDisputeWindowMs < 0 || !Number.isSafeInteger(this.disputeResolutionWindowMs) || this.disputeResolutionWindowMs <= 0 || !Number.isSafeInteger(this.readAuthorizationTtlMs) || this.readAuthorizationTtlMs <= 0) throw new Error("INVALID_DISPUTE_CONFIG");
    if (this.disputeTimeoutOutcome !== "REFUND_BUYER" && this.disputeTimeoutOutcome !== "RELEASE") throw new Error("INVALID_DISPUTE_CONFIG");
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
    if (this.isReservedIdentity(identityId)) throw new Error("RESERVED_IDENTITY");
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

  /**
   * Publish a listing. v0.4.4: the provider must be a registered identity and
   * `auth` must be its "publish" signature over the listing terms (see listingTerms()).
   */
  publishListing(input: Omit<ServiceListing, "listingId" | "available" | "active" | "sellerBond" | "catalogFingerprint"> & { listingId?: string; sellerBond?: bigint }, auth?: ActorAuth): ServiceListing {
    if (!input.providerId || !input.title || !input.asset) throw new Error("LISTING_METADATA_REQUIRED");
    if (this.isReservedIdentity(input.providerId)) throw new Error("RESERVED_IDENTITY");
    if (!this.identities.has(input.providerId)) throw new Error("IDENTITY_NOT_REGISTERED");
    const actor = this.authenticateActor(auth, "publish", input.listingId ?? "", listingTerms(input));
    if (actor !== input.providerId) throw new Error("PROVIDER_NOT_AUTHORIZED");
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
    if (this.isReservedIdentity(input.buyerId)) throw new Error("RESERVED_IDENTITY");
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

  /** Buyer funds the remainder of an order (v0.4.4: buyer "fund" signature over { amount }). */
  fundOrder(orderId: string, amount: bigint, auth: ActorAuth | undefined, idempotencyKey?: string): ServiceOrder {
    const actor = this.authenticateActor(auth, "fund", orderId, { amount });
    const order = this.order(orderId);
    if (actor !== order.buyerId) throw new Error("ORDER_ACCESS_FORBIDDEN");
    if (idempotencyKey) {
      const previous = this.operationIdempotency.get(`fund:${orderId}:${idempotencyKey}`);
      if (previous) {
        if (previous !== `${orderId}:${amount.toString()}`) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
        return { ...order };
      }
    }
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

  /** Provider delivers (v0.4.4: provider "deliver" signature over { deliveryHash }). */
  deliver(orderId: string, auth: ActorAuth | undefined, bytes: Uint8Array | Buffer, idempotencyKey?: string): ServiceOrder {
    const hash = contentHash(bytes);
    const actor = this.authenticateActor(auth, "deliver", orderId, { deliveryHash: hash });
    const order = this.order(orderId);
    if (actor !== order.providerId) throw new Error("PROVIDER_NOT_AUTHORIZED");
    if (idempotencyKey) {
      const previous = this.operationIdempotency.get(`deliver:${orderId}:${idempotencyKey}`);
      if (previous) {
        if (previous !== orderId) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
        return { ...order };
      }
    }
    this.assertReservationLive(order);
    if (order.status !== "HELD") throw new Error("ORDER_NOT_DELIVERABLE");
    if (this.deliveryValidator) {
      const validation = this.deliveryValidator(order, bytes);
      if (!validation.ok) throw new Error(`DELIVERY_VALIDATION_FAILED:${validation.reason ?? "INVALID_DELIVERY"}`);
    }
    order.deliveryHash = hash;
    order.status = "DELIVERED";
    order.deliveredAt = this.now();
    order.updatedAt = order.deliveredAt;
    if (idempotencyKey) this.operationIdempotency.set(`deliver:${orderId}:${idempotencyKey}`, orderId);
    return { ...order };
  }

  deliverWithExpectedHash(orderId: string, auth: ActorAuth | undefined, bytes: Uint8Array | Buffer, expectedHash: string, idempotencyKey?: string): ServiceOrder {
    const check = verifyContentHash(bytes, expectedHash);
    if (!check.ok) throw new Error(check.reason);
    return this.deliver(orderId, auth, bytes, idempotencyKey);
  }

  /**
   * Release a delivered order to the provider (v0.4.4, "settle" signature).
   *  - Buyer: any time after delivery (also withdraws an open dispute).
   *  - Provider: only after `deliveryDisputeWindowMs` and only if no dispute is open.
   *  - Arbiter: may release a DELIVERED order; open disputes go through resolveDispute().
   *  - Administrator and anyone else: not authorized.
   * A DISPUTED order past its resolution deadline closes with `disputeTimeoutOutcome`
   * when the buyer, provider or arbiter calls settle().
   * Category settlement guards (e.g. IoT verified telemetry) apply to the release paths.
   */
  settle(orderId: string, auth: ActorAuth | undefined): SettlementRecord {
    const actor = this.authenticateActor(auth, "settle", orderId);
    const order = this.order(orderId);
    const isBuyer = actor === order.buyerId;
    const isProvider = actor === order.providerId;
    const isArbiter = this.isArbiter(actor);
    if (!isBuyer && !isProvider && !isArbiter) throw new Error("SETTLEMENT_NOT_AUTHORIZED");
    if (order.status === "SETTLED" || order.status === "REFUNDED") {
      const existing = this.settlements.get(orderId);
      if (existing) return { ...existing };
      throw new Error("SETTLEMENT_RECORD_MISSING");
    }
    if (order.status === "DISPUTED") {
      if (this.now() >= (order.disputeDeadline ?? Number.POSITIVE_INFINITY)) {
        return this.timeoutDispute(order);
      }
      if (!isBuyer) throw new Error("DISPUTE_PENDING");
      // The buyer withdraws its own dispute and releases payment.
      this.runSettlementGuard(order);
      return this.payout(order, order.grossAmount, "RELEASE", "WITHDRAWN");
    }
    if (order.status !== "DELIVERED") {
      this.assertReservationLive(order);
      throw new Error("ORDER_NOT_SETTLEABLE");
    }
    if (isProvider && !isBuyer && !isArbiter && this.now() < (order.deliveredAt ?? order.updatedAt) + this.deliveryDisputeWindowMs) throw new Error("SETTLEMENT_DISPUTE_WINDOW_ACTIVE");
    this.runSettlementGuard(order);
    return this.payout(order, order.grossAmount, "RELEASE");
  }

  /**
   * Buyer opens a dispute on a DELIVERED order within `deliveryDisputeWindowMs`
   * ("dispute" signature over { reasonHash }). Requires a configured arbiter.
   * Funds stay in escrow until the arbiter resolves, the buyer withdraws, the
   * provider refunds, or the resolution deadline passes.
   */
  openDispute(orderId: string, auth: ActorAuth | undefined, reason: string): ServiceOrder {
    if (typeof reason !== "string" || !reason) throw new Error("DISPUTE_REASON_REQUIRED");
    const reasonHash = disputeReasonHash(reason);
    const actor = this.authenticateActor(auth, "dispute", orderId, { reasonHash });
    const order = this.order(orderId);
    if (actor !== order.buyerId) throw new Error("DISPUTE_NOT_AUTHORIZED");
    if (!this.settlementArbiterId || !this.arbiterKey) throw new Error("DISPUTE_ARBITER_NOT_CONFIGURED");
    if (order.status === "DISPUTED") return { ...order };
    if (order.status !== "DELIVERED") throw new Error("ORDER_NOT_DISPUTABLE");
    const now = this.now();
    if (now >= (order.deliveredAt ?? order.updatedAt) + this.deliveryDisputeWindowMs) throw new Error("DISPUTE_WINDOW_CLOSED");
    order.status = "DISPUTED";
    order.disputedAt = now;
    order.disputeReasonHash = reasonHash;
    order.disputeDeadline = now + this.disputeResolutionWindowMs;
    order.updatedAt = now;
    return { ...order };
  }

  /**
   * Arbiter resolves an open dispute ("resolve" signature over { outcome, providerAmount }).
   *  - RELEASE: normal settlement to the provider.
   *  - REFUND_BUYER: gross amount and gas returned to the buyer; no fee.
   *  - SPLIT: `providerAmount` (0 < x < gross) goes to the provider minus the
   *    Marketplace fee on x; gross - x returns to the buyer; gas is captured.
   */
  resolveDispute(orderId: string, auth: ActorAuth | undefined, resolution: DisputeResolution): SettlementRecord {
    if (!resolution || !["RELEASE", "REFUND_BUYER", "SPLIT"].includes(resolution.outcome)) throw new Error("DISPUTE_OUTCOME_INVALID");
    const providerAmount = resolution.outcome === "SPLIT" ? resolution.providerAmount : undefined;
    if (resolution.outcome === "SPLIT" && typeof providerAmount !== "bigint") throw new Error("DISPUTE_SPLIT_INVALID");
    const actor = this.authenticateActor(auth, "resolve", orderId, { outcome: resolution.outcome, providerAmount: providerAmount ?? null });
    const order = this.order(orderId);
    if (!this.isArbiter(actor)) throw new Error("DISPUTE_RESOLUTION_NOT_AUTHORIZED");
    if (order.status === "SETTLED" || order.status === "REFUNDED") {
      const existing = this.settlements.get(orderId);
      if (existing) return { ...existing };
    }
    if (order.status !== "DISPUTED") throw new Error("DISPUTE_NOT_OPEN");
    if (resolution.outcome === "RELEASE") return this.payout(order, order.grossAmount, "RELEASE");
    if (resolution.outcome === "REFUND_BUYER") return this.payout(order, 0n, "REFUND_BUYER");
    if (providerAmount! < 0n || providerAmount! > order.grossAmount) throw new Error("DISPUTE_SPLIT_INVALID");
    if (providerAmount === 0n) return this.payout(order, 0n, "REFUND_BUYER");
    if (providerAmount === order.grossAmount) return this.payout(order, order.grossAmount, "RELEASE");
    return this.payout(order, providerAmount!, "SPLIT");
  }

  /** Provider refunds the buyer in full for a DELIVERED or DISPUTED order ("refund" signature). */
  refundBuyer(orderId: string, auth: ActorAuth | undefined): SettlementRecord {
    const actor = this.authenticateActor(auth, "refund", orderId);
    const order = this.order(orderId);
    if (actor !== order.providerId) throw new Error("REFUND_NOT_AUTHORIZED");
    if (order.status === "REFUNDED") return { ...this.settlements.get(orderId)! };
    if (order.status !== "DELIVERED" && order.status !== "DISPUTED") throw new Error("ORDER_NOT_REFUNDABLE");
    return this.payout(order, 0n, "REFUND_BUYER", "PROVIDER_REFUND");
  }

  /**
   * Cancel an open order ("cancel" signature).
   *  - Buyer: within `cancellationGraceMs` of reserve() the deposit is refunded;
   *    afterwards it is forfeited to the provider. Any funded remainder is refunded.
   *  - Provider or authenticated admin: the buyer is refunded in full.
   */
  cancel(orderId: string, auth: ActorAuth | undefined, _reason = "buyer_or_provider_cancelled"): ServiceOrder {
    const actor = this.authenticateActor(auth, "cancel", orderId);
    const order = this.order(orderId);
    const isAdmin = this.isAdmin(actor);
    const isBuyer = actor === order.buyerId;
    const isProvider = actor === order.providerId;
    if (!isAdmin && !isBuyer && !isProvider) throw new Error("ORDER_ACCESS_FORBIDDEN");
    if (order.status === "SETTLED" || order.status === "REFUNDED") throw new Error("ORDER_ALREADY_SETTLED");
    if (order.status === "DELIVERED" || order.status === "DISPUTED") throw new Error("DELIVERED_ORDER_NOT_CANCELLABLE");
    if (order.status === "CANCELLED" || order.status === "EXPIRED") return { ...order };
    const forfeit = isBuyer && !isAdmin && !isProvider;
    const withinGrace = this.now() - order.createdAt <= this.cancellationGraceMs;
    this.closeOrder(order, "CANCELLED", forfeit && !withinGrace);
    return { ...order };
  }

  /** Close an order whose reservation TTL has passed ("expire" signature; party or admin). */
  expire(orderId: string, auth: ActorAuth | undefined): ServiceOrder {
    const actor = this.authenticateActor(auth, "expire", orderId);
    const order = this.order(orderId);
    if (!this.isAdmin(actor) && actor !== order.buyerId && actor !== order.providerId) throw new Error("ORDER_ACTION_FORBIDDEN");
    if (order.status === "SETTLED" || order.status === "REFUNDED") throw new Error("ORDER_ALREADY_SETTLED");
    if (order.status === "DELIVERED" || order.status === "DISPUTED") throw new Error("DELIVERED_ORDER_NOT_EXPIRABLE");
    if (order.status === "CANCELLED" || order.status === "EXPIRED") return { ...order };
    // Expiry is a TTL outcome, never an early exit (it can forfeit the deposit).
    if (order.reservationExpiresAt === undefined || this.now() < order.reservationExpiresAt) throw new Error("RESERVATION_NOT_EXPIRED");
    this.closeOrder(order, "EXPIRED", order.status === "ACCEPTED");
    return { ...order };
  }

  /**
   * Read one order ("read" signature with `issuedAt`). Allowed for the buyer,
   * the provider, the administrator, and the arbiter once a dispute was opened.
   */
  getOrder(orderId: string, auth: ActorAuth | undefined): ServiceOrder {
    const actor = this.authenticateRead(auth, "read", orderId);
    const order = this.order(orderId);
    const arbiterView = this.isArbiter(actor) && order.disputedAt !== undefined;
    if (!this.isAdmin(actor) && !arbiterView && actor !== order.buyerId && actor !== order.providerId) throw new Error("ORDER_ACCESS_FORBIDDEN");
    return { ...order };
  }

  /** Buyer review of a settled order ("review" signature over { rating }). */
  recordSellerReview(input: { orderId: string; rating: 1 | 2 | 3 | 4 | 5 }, auth: ActorAuth | undefined): SellerReputation {
    const actor = this.authenticateActor(auth, "review", input.orderId, { rating: input.rating });
    const order = this.order(input.orderId);
    if (actor !== order.buyerId) throw new Error("REVIEW_NOT_AUTHORIZED");
    if (order.status !== "SETTLED") throw new Error("REVIEW_REQUIRES_SETTLEMENT");
    this.reputation.record({ sellerId: order.providerId, buyerId: order.buyerId, orderId: order.orderId, rating: input.rating, settledAmount: order.grossAmount, sellerBond: this.listing(order.listingId).sellerBond, createdAt: order.updatedAt });
    return this.reputation.score(order.providerId, this.now());
  }

  sellerReputation(providerId: string): SellerReputation {
    return this.reputation.score(providerId, this.now());
  }

  /** Orders visible to the signer ("list" signature with `issuedAt`): own orders, or all for the admin. */
  listOrders(auth: ActorAuth | undefined): ServiceOrder[] {
    return this.visibleOrders(auth).map((o) => ({ ...o }));
  }

  listOrdersPage(offset = 0, limit = 50, auth?: ActorAuth): ServiceOrder[] {
    const start = Math.max(0, offset);
    return this.visibleOrders(auth).slice(start, start + Math.min(200, Math.max(1, limit))).map((o) => ({ ...o }));
  }

  /** Public keys (SPKI DER hex) configured for the administrator and the settlement arbiter. */
  authorityPublicKeys(): { admin?: string; arbiter?: string } {
    return { admin: this.adminKey ? publicKeyHexOf(this.adminKey) : undefined, arbiter: this.arbiterKey ? publicKeyHexOf(this.arbiterKey) : undefined };
  }

  /** Number of orders (aggregate statistic, no order data). */
  orderCount(): number {
    return this.orders.size;
  }

  /** Marketplace clock (used by clients to stamp read / list authorizations). */
  clock(): number {
    return this.now();
  }

  /**
   * Attach the service module of a category (once per category). The module
   * gets a capability to read orders of that category only, and may install a
   * settlement guard for the normal release path.
   */
  attachCategoryService(category: ServiceCategory, hooks: CategoryServiceHooks = {}): CategoryServiceAccess {
    if (this.categoryServices.has(category)) throw new Error("CATEGORY_SERVICE_ALREADY_ATTACHED");
    this.categoryServices.set(category, hooks);
    return {
      readOrder: (orderId: string) => {
        const order = this.order(orderId);
        if (this.listing(order.listingId).category !== category) throw new Error("ORDER_ACCESS_FORBIDDEN");
        return { ...order };
      },
    };
  }

  private visibleOrders(auth: ActorAuth | undefined): ServiceOrder[] {
    const actor = this.authenticateRead(auth, "list", "orders");
    const all = [...this.orders.values()];
    return this.isAdmin(actor) ? all : all.filter((o) => o.buyerId === actor || o.providerId === actor);
  }

  private runSettlementGuard(order: ServiceOrder): void {
    const category = this.listing(order.listingId).category;
    const hooks = this.categoryServices.get(category);
    // IoT / M2M orders settle only against verified telemetry: no attached IoT service, no normal release.
    if (category === "IOT_M2M" && !hooks?.settlementGuard) throw new Error("IOT_SETTLEMENT_GUARD_REQUIRED");
    if (hooks?.settlementGuard) hooks.settlementGuard({ ...order });
  }

  private timeoutDispute(order: ServiceOrder): SettlementRecord {
    return this.disputeTimeoutOutcome === "RELEASE"
      ? this.payout(order, order.grossAmount, "RELEASE", "TIMEOUT_RELEASE")
      : this.payout(order, 0n, "REFUND_BUYER", "TIMEOUT_REFUND");
  }

  /**
   * Close a funded, delivered order, moving the escrowed amount exactly once:
   *   providerAmount = gross  -> provider net + fee + gas (RELEASE)
   *   0 < providerAmount < gross -> provider net(x) + fee(x) + gas, buyer gross - x (SPLIT)
   *   providerAmount = 0      -> buyer gross + gas, paymaster sponsorship released (REFUND_BUYER)
   */
  private payout(order: ServiceOrder, providerAmount: bigint, outcome: DisputeOutcome, disputeOutcome?: ServiceOrder["disputeOutcome"]): SettlementRecord {
    const gas = order.gasFee ?? 0n;
    const required = order.grossAmount + gas;
    if (order.heldAmount !== required) throw new Error("HOLD_NOT_COMPLETE");
    const heldKey = key(order.asset, order.buyerId);
    const held = this.held.get(heldKey) ?? 0n;
    if (held < order.heldAmount) throw new Error("HELD_BALANCE_INSUFFICIENT");
    if (providerAmount < 0n || providerAmount > order.grossAmount) throw new Error("PAYOUT_AMOUNT_INVALID");
    let fee = 0n;
    let providerNet = 0n;
    let gasCaptured = 0n;
    if (providerAmount > 0n) {
      if (gas > 0n) {
        if (!this.paymaster || !order.gasQuoteId) throw new Error("PAYMASTER_STATE_MISSING");
        const gasQuote = this.paymaster.sponsoredQuote(order.orderId, order.gasQuoteId);
        if (gasQuote.asset !== order.asset || gasQuote.gasFee !== gas) throw new Error("GAS_QUOTE_MISMATCH");
        this.paymaster.capture(order.orderId, gasQuote, this.now());
        gasCaptured = gas;
      }
      const quote = this.treasury.settleMarketplaceFee(order.orderId, providerAmount, order.asset, this.now());
      fee = quote.marketplaceFee;
      providerNet = quote.providerNet;
    } else {
      this.releasePaymaster(order);
    }
    const buyerRefund = order.heldAmount - providerNet - fee - gasCaptured;
    if (buyerRefund < 0n || buyerRefund !== order.grossAmount - providerAmount + (gas - gasCaptured)) throw new Error("PAYOUT_NOT_CONSERVED");
    this.held.set(heldKey, held - order.heldAmount);
    if (held - order.heldAmount === 0n) this.held.delete(heldKey);
    if (providerNet > 0n) this.add(this.accounts, key(order.asset, order.providerId), providerNet);
    if (buyerRefund > 0n) this.add(this.accounts, heldKey, buyerRefund);
    this.add(this.feesCollected, order.asset, fee);
    this.add(this.gasCollected, order.asset, gasCaptured);
    order.heldAmount = 0n;
    order.settledFee = fee;
    order.providerPayout = providerNet;
    order.buyerRefund = buyerRefund;
    order.status = providerAmount > 0n ? "SETTLED" : "REFUNDED";
    if (disputeOutcome || order.disputedAt !== undefined) order.disputeOutcome = disputeOutcome ?? outcome;
    order.updatedAt = this.now();
    this.decrementActiveReservation(order.buyerId);
    const record: SettlementRecord = {
      orderId: order.orderId,
      asset: order.asset,
      grossAmount: order.grossAmount,
      marketplaceFee: fee,
      providerPayout: providerNet,
      treasuryId: this.treasury.treasuryId,
      settledAt: order.updatedAt,
      gasFee: gasCaptured,
      outcome,
      buyerRefund,
    };
    this.settlements.set(order.orderId, record);
    return { ...record };
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

  /**
   * Verify `auth` for one action and return the authenticated actor id.
   * Registered identities sign with their registered key; the administrator
   * and the settlement arbiter sign with the keys configured on the
   * marketplace. Signature verification only: no state is changed.
   */
  authenticateActor(auth: ActorAuth | undefined, action: MarketplaceAction, target: string, details: Record<string, unknown> = {}): string {
    if (!auth || typeof auth !== "object" || typeof auth.actorId !== "string" || !auth.actorId || typeof auth.signature !== "string") throw new Error("ACTOR_SIGNATURE_REQUIRED");
    if (auth.actorId === "marketplace-admin") throw new Error("LEGACY_ADMIN_ID_RESERVED");
    if (auth.actorId === "marketplace-system") throw new Error("RESERVED_IDENTITY");
    const publicKey = auth.actorId === this.adminIdentity ? this.adminKey : auth.actorId === this.settlementArbiterId ? this.arbiterKey : this.identityKeys.get(auth.actorId);
    if (!publicKey) throw new Error(auth.actorId === this.adminIdentity ? "ADMIN_NOT_CONFIGURED" : "IDENTITY_NOT_REGISTERED");
    if (!verifyEd25519(actionMessage({ marketplaceId: this.marketplaceId, action, actorId: auth.actorId, target, details }), auth.signature, publicKey)) throw new Error("ACTOR_SIGNATURE_INVALID");
    if (auth.actorId === this.adminIdentity && this.adminAuthorizer && !this.adminAuthorizer(auth.actorId)) throw new Error("ADMIN_NOT_AUTHORIZED");
    return auth.actorId;
  }

  /** Read / list authorizations carry `issuedAt` and expire after `readAuthorizationTtlMs`. */
  private authenticateRead(auth: ActorAuth | undefined, action: "read" | "list", target: string): string {
    const issuedAt = auth?.issuedAt;
    if (typeof issuedAt !== "number" || !Number.isFinite(issuedAt)) throw new Error("ACTOR_AUTH_ISSUED_AT_REQUIRED");
    if (Math.abs(this.now() - issuedAt) > this.readAuthorizationTtlMs) throw new Error("ACTOR_AUTH_EXPIRED");
    return this.authenticateActor(auth, action, target, { issuedAt });
  }

  private isAdmin(actorId: string): boolean {
    return actorId === this.adminIdentity && !!this.adminKey;
  }

  private isArbiter(actorId: string): boolean {
    return !!this.settlementArbiterId && actorId === this.settlementArbiterId && !!this.arbiterKey;
  }

  private isReservedIdentity(identityId: string): boolean {
    return (RESERVED_IDENTITIES as readonly string[]).includes(identityId) || identityId === this.adminIdentity || identityId === this.settlementArbiterId;
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
