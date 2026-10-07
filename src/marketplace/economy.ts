/**
 * UEP Digital Marketplace Economy v0.1
 *
 * Business-layer accounting only. It does NOT create a native UEP token and
 * does not move real-world funds. A production payment rail/custodian must
 * settle the same ledger events externally.
 */
import type { HeightSource } from "../core/height.ts";

export const MARKETPLACE_ECONOMY_VERSION = "0.1" as const;
export const MARKETPLACE_FEE_BPS = 300; // 3.00% of SETTLED service value
export const BPS_DENOMINATOR = 10_000n;

export type TreasuryBucket =
  | "OPERATIONS"
  | "RISK_RESERVE"
  | "PRODUCT_DEVELOPMENT"
  | "DISTRIBUTABLE_PROFIT";

export const DEFAULT_TREASURY_ALLOCATION_BPS: Readonly<Record<TreasuryBucket, number>> = {
  OPERATIONS: 4_000,            // 40% of marketplace fees
  RISK_RESERVE: 2_500,          // 25%
  PRODUCT_DEVELOPMENT: 2_000,   // 20%
  DISTRIBUTABLE_PROFIT: 1_500,  // 15%
};

export type FeeQuote = {
  asset: string;
  grossAmount: bigint;
  marketplaceFee: bigint;
  providerNet: bigint;
  feeBps: number;
};

export type TreasuryEntry = {
  id: string;
  timestamp: number;
  orderId: string;
  asset: string;
  amount: bigint;
  bucket: TreasuryBucket;
  /**
   * v0.5.2: RISK_RESERVE_TRANSFER = treasury share of a slashed relay bond or a
   * forfeited dispute bond (category modules); DRIP_SUBSIDY = a drip subsidy paid
   * out of DISTRIBUTABLE_PROFIT within the administrator-signed drip budget.
   */
  reason: "SETTLED_MARKETPLACE_FEE" | "REVERSAL" | "WITHDRAWAL" | "RISK_RESERVE_TRANSFER" | "DRIP_SUBSIDY";
};

/** v0.5.2: capability for the drip budget, issued once (to the Marketplace). */
export type TreasuryDripCapability = { readonly kind: "treasury-drip-capability" };
/** v0.5.3: capability (issued once, to the settlement engine) to roll back a fee allocation of a failed settlement. */
export type TreasuryRollbackCapability = { readonly kind: "treasury-settlement-rollback-capability" };

export type TreasuryBalance = Record<TreasuryBucket, bigint>;

export type TreasurySnapshot = {
  treasuryId: string;
  version: string;
  asset: string;
  balances: TreasuryBalance;
  total: bigint;
};

export type TreasuryWithdrawal = {
  id: string;
  timestamp: number;
  bucket: TreasuryBucket;
  asset: string;
  amount: bigint;
  beneficiary: string;
  reason: string;
  authorizationRef: string;
};

/** Minimum Marketplace fee for any positive settled amount when the fee rate is non-zero (UEP-A16). */
export const MIN_MARKETPLACE_FEE = 1n;

/**
 * Marketplace fee: 3% of the settled amount, rounded down, but never below
 * MIN_MARKETPLACE_FEE (and never above the amount itself) when the rate is
 * non-zero. A configured rate of 0 bps stays fee-free.
 */
export function calculateMarketplaceFee(grossAmount: bigint, feeBps = MARKETPLACE_FEE_BPS, minFee: bigint = MIN_MARKETPLACE_FEE): bigint {
  if (grossAmount < 0n) throw new Error("NEGATIVE_AMOUNT");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new Error("INVALID_FEE_BPS");
  if (typeof minFee !== "bigint" || minFee < MIN_MARKETPLACE_FEE) throw new Error("INVALID_MIN_FEE");
  if (grossAmount === 0n || feeBps === 0) return 0n;
  const proportional = (grossAmount * BigInt(feeBps)) / BPS_DENOMINATOR;
  const floored = proportional < minFee ? minFee : proportional;
  return floored > grossAmount ? grossAmount : floored;
}

/** v0.4.7: `minFee` is the per-asset floor (default MIN_MARKETPLACE_FEE); the 3% rate is the same for every asset. */
export function quoteSettlement(grossAmount: bigint, asset: string, feeBps = MARKETPLACE_FEE_BPS, minFee: bigint = MIN_MARKETPLACE_FEE): FeeQuote {
  if (!asset) throw new Error("ASSET_REQUIRED");
  const fee = calculateMarketplaceFee(grossAmount, feeBps, minFee);
  return { asset, grossAmount, marketplaceFee: fee, providerNet: grossAmount - fee, feeBps };
}

function emptyBalance(): TreasuryBalance {
  return {
    OPERATIONS: 0n,
    RISK_RESERVE: 0n,
    PRODUCT_DEVELOPMENT: 0n,
    DISTRIBUTABLE_PROFIT: 0n,
  };
}

function validateAllocation(allocation: Record<TreasuryBucket, number>): void {
  const total = Object.values(allocation).reduce((a, b) => a + b, 0);
  if (total !== 10_000) throw new Error(`INVALID_ALLOCATION_BPS:${total}`);
  for (const value of Object.values(allocation)) {
    if (!Number.isInteger(value) || value < 0) throw new Error("INVALID_ALLOCATION_BPS");
  }
}

export class MarketplaceTreasury {
  readonly treasuryId: string;
  readonly feeBps: number;
  readonly allocationBps: Readonly<Record<TreasuryBucket, number>>;
  private readonly balancesByAsset = new Map<string, TreasuryBalance>();
  readonly entries: TreasuryEntry[] = [];
  readonly withdrawals: TreasuryWithdrawal[] = [];
  private readonly settledOrders = new Set<string>();
  private readonly withdrawnRefs = new Set<string>();
  private readonly authorizationVerifier?: (input: Omit<TreasuryWithdrawal, "timestamp">) => boolean;
  /** v0.4.7: per-asset Marketplace fee floor (asset -> minimum, each >= MIN_MARKETPLACE_FEE). */
  private readonly minFeeByAsset = new Map<string, bigint>();
  /** v0.5.1: default entry stamp (a height; the Marketplace passes its own). */
  private readonly height: HeightSource;
  /** v0.5.2: ids of risk-reserve transfers already recorded (each accepted once). */
  private readonly transferRefs = new Set<string>();
  /** v0.5.2: drip budget per asset (an allowance on DISTRIBUTABLE_PROFIT, not a bucket). */
  private readonly dripBudget = new Map<string, bigint>();
  private readonly dripAllocationRefs = new Set<string>();
  private dripCapability?: TreasuryDripCapability;
  private rollbackCapability?: TreasuryRollbackCapability;

  constructor(opts?: {
    treasuryId?: string;
    feeBps?: number;
    allocationBps?: Record<TreasuryBucket, number>;
    authorizationVerifier?: (input: Omit<TreasuryWithdrawal, "timestamp">) => boolean;
    /** v0.4.7: per-asset fee floors in the asset's smallest unit (default MIN_MARKETPLACE_FEE for every asset). */
    minFeeByAsset?: Record<string, bigint>;
    /** v0.5.1 (ADR 0002): height stamped on entries when no timestamp is passed (default: height 0). */
    height?: HeightSource;
  }) {
    this.height = opts?.height ?? (() => 0);
    this.treasuryId = opts?.treasuryId ?? "marketplace-treasury";
    this.feeBps = opts?.feeBps ?? MARKETPLACE_FEE_BPS;
    this.allocationBps = opts?.allocationBps ?? DEFAULT_TREASURY_ALLOCATION_BPS;
    this.authorizationVerifier = opts?.authorizationVerifier;
    validateAllocation(this.allocationBps);
    calculateMarketplaceFee(0n, this.feeBps);
    for (const [asset, min] of Object.entries(opts?.minFeeByAsset ?? {})) {
      if (!asset || typeof min !== "bigint" || min < MIN_MARKETPLACE_FEE) throw new Error("INVALID_MIN_FEE");
      this.minFeeByAsset.set(asset, min);
    }
  }

  /** v0.4.7: Marketplace fee floor of one asset. */
  minFeeFor(asset: string): bigint {
    return this.minFeeByAsset.get(asset) ?? MIN_MARKETPLACE_FEE;
  }

  private balance(asset: string): TreasuryBalance {
    let b = this.balancesByAsset.get(asset);
    if (!b) {
      b = emptyBalance();
      this.balancesByAsset.set(asset, b);
    }
    return b;
  }

  quote(grossAmount: bigint, asset: string): FeeQuote {
    return quoteSettlement(grossAmount, asset, this.feeBps, this.minFeeFor(asset));
  }

  /** `timestamp` is the settlement height (ADR 0002); default: the treasury's height source. */
  settleMarketplaceFee(orderId: string, grossAmount: bigint, asset: string, timestamp = this.height()): FeeQuote {
    if (!orderId) throw new Error("ORDER_ID_REQUIRED");
    if (this.settledOrders.has(orderId)) throw new Error("FEE_ALREADY_SETTLED");
    const quote = this.quote(grossAmount, asset);
    const b = this.balance(asset);

    (Object.keys(this.allocationBps) as TreasuryBucket[]).forEach((bucket) => {
      const amount = (quote.marketplaceFee * BigInt(this.allocationBps[bucket])) / BPS_DENOMINATOR;
      b[bucket] += amount;
      this.entries.push({
        id: `${this.treasuryId}:${orderId}:${bucket}`,
        timestamp,
        orderId,
        asset,
        amount,
        bucket,
        reason: "SETTLED_MARKETPLACE_FEE",
      });
    });

    // Integer rounding must never leak value. Any remainder stays in Operations.
    const allocated = (Object.keys(this.allocationBps) as TreasuryBucket[])
      .reduce((sum, bucket) => sum + (quote.marketplaceFee * BigInt(this.allocationBps[bucket])) / BPS_DENOMINATOR, 0n);
    const remainder = quote.marketplaceFee - allocated;
    if (remainder > 0n) {
      b.OPERATIONS += remainder;
      this.entries.push({
        id: `${this.treasuryId}:${orderId}:rounding`,
        timestamp,
        orderId,
        asset,
        amount: remainder,
        bucket: "OPERATIONS",
        reason: "SETTLED_MARKETPLACE_FEE",
      });
    }

    this.settledOrders.add(orderId);
    return quote;
  }

  /** v0.5.3: issue the settlement rollback capability (once; the settlement engine takes it at construction). */
  issueSettlementRollbackCapability(): TreasuryRollbackCapability {
    if (this.rollbackCapability) throw new Error("TREASURY_CAPABILITY_ALREADY_ISSUED");
    this.rollbackCapability = Object.freeze({ kind: "treasury-settlement-rollback-capability" as const });
    return this.rollbackCapability;
  }

  /**
   * v0.5.3: undo settleMarketplaceFee(orderId) while the settlement that
   * allocated it is being rolled back (same execute call). Removes exactly the
   * bucket entries of that allocation and the settled flag, so a retry of the
   * same settlement id is accepted again.
   */
  revertMarketplaceFee(cap: TreasuryRollbackCapability, orderId: string): void {
    if (!this.rollbackCapability || cap !== this.rollbackCapability) throw new Error("TREASURY_CAPABILITY_INVALID");
    if (!this.settledOrders.has(orderId)) throw new Error("FEE_NOT_SETTLED");
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.orderId !== orderId || e.reason !== "SETTLED_MARKETPLACE_FEE") continue;
      const b = this.balance(e.asset);
      if (b[e.bucket] < e.amount) throw new Error("TREASURY_ROLLBACK_UNDERFLOW");
      b[e.bucket] -= e.amount;
      this.entries.splice(i, 1);
    }
    this.settledOrders.delete(orderId);
  }

  /** v0.5.2: true once the Marketplace fee of `orderId` was allocated (settleMarketplaceFee would throw). */
  hasSettled(orderId: string): boolean {
    return this.settledOrders.has(orderId);
  }

  /**
   * v0.5.2: record a non-fee amount already paid into the treasury (treasury
   * share of a slashed relay bond or a forfeited dispute bond). It goes to
   * RISK_RESERVE, which exists to absorb abuse. Each `refId` is accepted once.
   */
  creditRiskReserve(refId: string, asset: string, amount: bigint, timestamp = this.height()): TreasuryEntry {
    if (!refId || !asset) throw new Error("TREASURY_TRANSFER_INVALID");
    if (typeof amount !== "bigint" || amount <= 0n) throw new Error("TREASURY_TRANSFER_INVALID");
    if (this.transferRefs.has(refId)) throw new Error("TREASURY_TRANSFER_REPLAY");
    this.balance(asset).RISK_RESERVE += amount;
    this.transferRefs.add(refId);
    const entry: TreasuryEntry = { id: `${this.treasuryId}:transfer:${refId}`, timestamp, orderId: refId, asset, amount, bucket: "RISK_RESERVE", reason: "RISK_RESERVE_TRANSFER" };
    this.entries.push(entry);
    return { ...entry };
  }

  /** v0.5.2: issue the drip capability (once). The Marketplace takes it on first use. */
  issueDripCapability(): TreasuryDripCapability {
    if (this.dripCapability) throw new Error("TREASURY_CAPABILITY_ALREADY_ISSUED");
    this.dripCapability = Object.freeze({ kind: "treasury-drip-capability" as const });
    return this.dripCapability;
  }

  private assertDripCapability(cap: TreasuryDripCapability): void {
    if (!this.dripCapability || cap !== this.dripCapability) throw new Error("TREASURY_CAPABILITY_INVALID");
  }

  /** v0.5.2: drip budget left for an asset. */
  dripBudgetOf(asset: string): bigint {
    return this.dripBudget.get(asset) ?? 0n;
  }

  /**
   * v0.5.2: raise the drip budget of an asset by `amount` (administrator
   * decision, checked by the Marketplace). The budget can never exceed the
   * DISTRIBUTABLE_PROFIT bucket. Each `allocationId` is accepted once.
   */
  allocateDripBudget(cap: TreasuryDripCapability, allocationId: string, asset: string, amount: bigint): bigint {
    this.assertDripCapability(cap);
    if (!allocationId || !asset || typeof amount !== "bigint" || amount <= 0n) throw new Error("DRIP_BUDGET_INVALID");
    if (this.dripAllocationRefs.has(allocationId)) throw new Error("DRIP_BUDGET_REPLAY");
    const next = this.dripBudgetOf(asset) + amount;
    if (next > this.balance(asset).DISTRIBUTABLE_PROFIT) throw new Error("DRIP_BUDGET_EXCEEDS_DISTRIBUTABLE");
    this.dripBudget.set(asset, next);
    this.dripAllocationRefs.add(allocationId);
    return next;
  }

  /**
   * v0.5.2: pay a drip subsidy out of DISTRIBUTABLE_PROFIT within the budget.
   * Only the bucket and the budget change here; the Marketplace credits the
   * node's account in the same call.
   */
  spendDripBudget(cap: TreasuryDripCapability, claimId: string, asset: string, amount: bigint, timestamp = this.height()): TreasuryEntry {
    this.assertDripCapability(cap);
    if (!claimId || !asset || typeof amount !== "bigint" || amount <= 0n) throw new Error("DRIP_BUDGET_INVALID");
    const budget = this.dripBudgetOf(asset);
    const b = this.balance(asset);
    if (budget < amount) throw new Error("DRIP_BUDGET_EXHAUSTED");
    if (b.DISTRIBUTABLE_PROFIT < amount) throw new Error("INSUFFICIENT_TREASURY_BALANCE");
    b.DISTRIBUTABLE_PROFIT -= amount;
    this.dripBudget.set(asset, budget - amount);
    const entry: TreasuryEntry = { id: `${this.treasuryId}:drip:${claimId}`, timestamp, orderId: claimId, asset, amount, bucket: "DISTRIBUTABLE_PROFIT", reason: "DRIP_SUBSIDY" };
    this.entries.push(entry);
    return { ...entry };
  }

  balanceOf(asset: string): TreasuryBalance {
    const b = this.balance(asset);
    return { ...b };
  }

  totalOf(asset: string): bigint {
    const b = this.balance(asset);
    return Object.values(b).reduce((sum, n) => sum + n, 0n);
  }

  withdraw(opts: {
    withdrawalId: string;
    bucket: TreasuryBucket;
    asset: string;
    amount: bigint;
    beneficiary: string;
    reason: string;
    authorizationRef: string;
    timestamp?: number;
  }): TreasuryWithdrawal {
    if (!opts.withdrawalId || !opts.beneficiary || !opts.authorizationRef) throw new Error("WITHDRAWAL_METADATA_REQUIRED");
    if (!this.authorizationVerifier) throw new Error("TREASURY_AUTHORIZER_NOT_CONFIGURED");
    if (!opts.authorizationRef.startsWith("auth:")) throw new Error("INVALID_AUTHORIZATION_REF");
    if (opts.amount <= 0n) throw new Error("INVALID_WITHDRAWAL_AMOUNT");
    const authRecord = { withdrawalId: opts.withdrawalId, bucket: opts.bucket, asset: opts.asset, amount: opts.amount, beneficiary: opts.beneficiary, reason: opts.reason, authorizationRef: opts.authorizationRef };
    if (!this.authorizationVerifier(authRecord)) throw new Error("TREASURY_WITHDRAWAL_UNAUTHORIZED");
    if (this.withdrawnRefs.has(opts.withdrawalId)) throw new Error("WITHDRAWAL_REPLAY");
    const b = this.balance(opts.asset);
    if (b[opts.bucket] < opts.amount) throw new Error("INSUFFICIENT_TREASURY_BALANCE");

    b[opts.bucket] -= opts.amount;
    const row: TreasuryWithdrawal = {
      id: opts.withdrawalId,
      timestamp: opts.timestamp ?? this.height(),
      bucket: opts.bucket,
      asset: opts.asset,
      amount: opts.amount,
      beneficiary: opts.beneficiary,
      reason: opts.reason,
      authorizationRef: opts.authorizationRef,
    };
    this.withdrawals.push(row);
    this.withdrawnRefs.add(opts.withdrawalId);
    this.entries.push({
      id: `${this.treasuryId}:withdrawal:${opts.withdrawalId}`,
      timestamp: row.timestamp,
      orderId: opts.withdrawalId,
      asset: opts.asset,
      amount: opts.amount,
      bucket: opts.bucket,
      reason: "WITHDRAWAL",
    });
    return row;
  }

  snapshot(asset: string): TreasurySnapshot {
    return {
      treasuryId: this.treasuryId,
      version: MARKETPLACE_ECONOMY_VERSION,
      asset,
      balances: this.balanceOf(asset),
      total: this.totalOf(asset),
    };
  }
}

