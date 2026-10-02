/**
 * UEP liquidity layer — local TESTNET pools (constant-product AMM).
 * Status: IMPLEMENTED / TESTED. Production markets: CONCEPTUAL.
 */
import type { AggregatedQuote } from "./oracle.ts";
import { PRICE_SCALE } from "./oracle.ts";

export type PoolId = string;

export type LiquidityPool = {
  poolId: PoolId;
  assetA: string;
  assetB: string;
  reserveA: bigint;
  reserveB: bigint;
  feePpm: bigint;
  maxOracleSkewPpm: bigint;
};

export type SwapResult =
  | {
      ok: true;
      amountIn: bigint;
      amountOut: bigint;
      feePaid: bigint;
      pool: LiquidityPool;
      spotPriceE6: bigint;
    }
  | { ok: false; code: SwapRejectCode; message: string };

export type SwapRejectCode =
  | "EMPTY_POOL"
  | "ZERO_AMOUNT"
  | "INSUFFICIENT_LIQUIDITY"
  | "ORACLE_SKEW"
  | "ORACLE_REQUIRED"
  | "UNKNOWN_POOL"
  | "BAD_ASSET";

function applySwapOn(
  pool: LiquidityPool,
  tokenIn: string,
  amountIn: bigint,
  oracleMidAinB: AggregatedQuote | null | undefined,
  commit: boolean,
  live?: LiquidityPool,
): SwapResult {
  if (amountIn <= 0n) return { ok: false, code: "ZERO_AMOUNT", message: "amountIn must be > 0." };
  if (pool.reserveA === 0n || pool.reserveB === 0n) {
    return { ok: false, code: "EMPTY_POOL", message: "Pool has no liquidity." };
  }
  const inIsA = tokenIn === pool.assetA;
  const inIsB = tokenIn === pool.assetB;
  if (!inIsA && !inIsB) {
    return { ok: false, code: "BAD_ASSET", message: "tokenIn is not a pool asset." };
  }

  if (oracleMidAinB) {
    if (
      oracleMidAinB.baseAssetId !== pool.assetA ||
      oracleMidAinB.quoteAssetId !== pool.assetB
    ) {
      return {
        ok: false,
        code: "ORACLE_REQUIRED",
        message: "Oracle pair must be assetA/assetB.",
      };
    }
    const spot =
      pool.reserveA === 0n ? 0n : (pool.reserveB * PRICE_SCALE) / pool.reserveA;
    const mid = oracleMidAinB.priceE6;
    if (mid > 0n) {
      const diff = spot > mid ? spot - mid : mid - spot;
      const skewPpm = (diff * 1_000_000n) / mid;
      if (skewPpm > pool.maxOracleSkewPpm) {
        return {
          ok: false,
          code: "ORACLE_SKEW",
          message: `Pool skew ${skewPpm} ppm exceeds max ${pool.maxOracleSkewPpm}.`,
        };
      }
    }
  }

  const feePaid = (amountIn * pool.feePpm) / 1_000_000n;
  const amountInLessFee = amountIn - feePaid;
  if (amountInLessFee <= 0n) {
    return { ok: false, code: "ZERO_AMOUNT", message: "Fee consumes entire input." };
  }

  let amountOut: bigint;
  let newA = pool.reserveA;
  let newB = pool.reserveB;
  if (inIsA) {
    newA = pool.reserveA + amountInLessFee;
    const k = pool.reserveA * pool.reserveB;
    newB = k / newA;
    amountOut = pool.reserveB - newB;
    if (amountOut <= 0n || amountOut >= pool.reserveB) {
      return { ok: false, code: "INSUFFICIENT_LIQUIDITY", message: "Insufficient reserve B." };
    }
  } else {
    newB = pool.reserveB + amountInLessFee;
    const k = pool.reserveA * pool.reserveB;
    newA = k / newB;
    amountOut = pool.reserveA - newA;
    if (amountOut <= 0n || amountOut >= pool.reserveA) {
      return { ok: false, code: "INSUFFICIENT_LIQUIDITY", message: "Insufficient reserve A." };
    }
  }

  const next: LiquidityPool = { ...pool, reserveA: newA, reserveB: newB };
  if (commit && live) {
    live.reserveA = newA;
    live.reserveB = newB;
  }
  const spot =
    next.reserveA === 0n ? 0n : (next.reserveB * PRICE_SCALE) / next.reserveA;
  return {
    ok: true,
    amountIn,
    amountOut,
    feePaid,
    pool: next,
    spotPriceE6: spot,
  };
}

export class LiquidityRegistry {
  private pools = new Map<PoolId, LiquidityPool>();

  createPool(
    p: Omit<LiquidityPool, "reserveA" | "reserveB"> & {
      reserveA?: bigint;
      reserveB?: bigint;
    },
  ) {
    const pool: LiquidityPool = {
      poolId: p.poolId,
      assetA: p.assetA,
      assetB: p.assetB,
      reserveA: p.reserveA ?? 0n,
      reserveB: p.reserveB ?? 0n,
      feePpm: p.feePpm,
      maxOracleSkewPpm: p.maxOracleSkewPpm,
    };
    this.pools.set(pool.poolId, pool);
    return pool;
  }

  get(poolId: PoolId): LiquidityPool | undefined {
    return this.pools.get(poolId);
  }

  fund(poolId: PoolId, amountA: bigint, amountB: bigint): LiquidityPool {
    const pool = this.pools.get(poolId);
    if (!pool) throw new Error("UNKNOWN_POOL");
    pool.reserveA += amountA;
    pool.reserveB += amountB;
    return pool;
  }

  spotPriceAinB(pool: LiquidityPool): bigint {
    if (pool.reserveA === 0n) return 0n;
    return (pool.reserveB * PRICE_SCALE) / pool.reserveA;
  }

  simulateSwap(
    poolId: PoolId,
    tokenIn: string,
    amountIn: bigint,
    oracleMidAinB?: AggregatedQuote | null,
  ): SwapResult {
    const pool = this.pools.get(poolId);
    if (!pool) return { ok: false, code: "UNKNOWN_POOL", message: "Pool not found." };
    return applySwapOn({ ...pool }, tokenIn, amountIn, oracleMidAinB, false);
  }

  swap(
    poolId: PoolId,
    tokenIn: string,
    amountIn: bigint,
    oracleMidAinB?: AggregatedQuote | null,
  ): SwapResult {
    const pool = this.pools.get(poolId);
    if (!pool) return { ok: false, code: "UNKNOWN_POOL", message: "Pool not found." };
    return applySwapOn({ ...pool }, tokenIn, amountIn, oracleMidAinB, true, pool);
  }
}

export function seedTestnetLiquidity(reg: LiquidityRegistry) {
  reg.createPool({
    poolId: "pool:test:energy-eur",
    assetA: "asset:test:energy",
    assetB: "asset:test:eur",
    reserveA: 1_000_000n,
    reserveB: 120_000n,
    feePpm: 3_000n,
    maxOracleSkewPpm: 100_000n,
  });
  return reg.get("pool:test:energy-eur")!;
}

export const defaultLiquidity = new LiquidityRegistry();
