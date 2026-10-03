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
  reason: "SETTLED_MARKETPLACE_FEE" | "REVERSAL" | "WITHDRAWAL";
};

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
  /** v0.5.0: default entry stamp (a height; the Marketplace passes its own). */
  private readonly height: HeightSource;

  constructor(opts?: {
    treasuryId?: string;
    feeBps?: number;
    allocationBps?: Record<TreasuryBucket, number>;
    authorizationVerifier?: (input: Omit<TreasuryWithdrawal, "timestamp">) => boolean;
    /** v0.4.7: per-asset fee floors in the asset's smallest unit (default MIN_MARKETPLACE_FEE for every asset). */
    minFeeByAsset?: Record<string, bigint>;
    /** v0.5.0 (ADR 0002): height stamped on entries when no timestamp is passed (default: height 0). */
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

