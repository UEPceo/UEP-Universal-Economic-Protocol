/**
 * UEP liquidity layer — local TESTNET pools (constant-product AMM). Simulation only.
 * Status: IMPLEMENTED / TESTED. Production markets: CONCEPTUAL.
 *
 * Swap fee (configurable per pool, parts per million of the input amount):
 * - `feePpm` is the total swap fee, default 3_000 (0.3%);
 * - `protocolFeePpm` is the part routed to the protocol treasury, default 1_000 (0.1%,
 *   the same rate as the protocol fee); it leaves the pool;
 * - the rest (default 2_000 = 0.2%) stays in the reserves for liquidity providers.
 * Rationale: docs/LABS.md ("Liquidity-pool lab fee").
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
  /** Total swap fee in ppm of the input (protocol share + liquidity-provider share). */
  feePpm: bigint;
  /** Protocol share of the swap fee in ppm of the input (<= feePpm). */
  protocolFeePpm: bigint;
  maxOracleSkewPpm: bigint;
  /** Protocol fees collected by this pool, per asset (paid to the treasury). */
  protocolFeesA: bigint;
  protocolFeesB: bigint;
};

export const PPM = 1_000_000n;
/** Default total swap fee: 0.3%. */
export const DEFAULT_SWAP_FEE_PPM = 3_000n;
/** Default protocol share: 0.1% of the input, same rate as the protocol fee. */
export const DEFAULT_PROTOCOL_SWAP_FEE_PPM = 1_000n;

export function validateSwapFees(feePpm: bigint, protocolFeePpm: bigint): void {
  if (typeof feePpm !== "bigint" || typeof protocolFeePpm !== "bigint") throw new Error("SWAP_FEE_INVALID");
  if (feePpm < 0n || feePpm >= PPM) throw new Error("SWAP_FEE_INVALID");
  if (protocolFeePpm < 0n || protocolFeePpm > feePpm) throw new Error("SWAP_PROTOCOL_FEE_INVALID");
}

export type SwapResult =
  | {
      ok: true;
      amountIn: bigint;
      amountOut: bigint;
      /** Total swap fee (protocolFee + lpFee). */
      feePaid: bigint;
      /** Part of the fee paid to the protocol treasury (leaves the pool). */
      protocolFee: bigint;
      /** Part of the fee kept in the reserves for liquidity providers. */
      lpFee: bigint;
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

  const feePaid = (amountIn * pool.feePpm) / PPM;
  const protocolFee = (amountIn * pool.protocolFeePpm) / PPM;
  const lpFee = feePaid - protocolFee;
  const amountInLessFee = amountIn - feePaid;
  if (amountInLessFee <= 0n) {
    return { ok: false, code: "ZERO_AMOUNT", message: "Fee consumes entire input." };
  }

  // Price on the input net of the whole fee; the reserves keep the LP share.
  // The output is rounded down (pool-favourable) so k never decreases.
  const k = pool.reserveA * pool.reserveB;
  const ceilDiv = (x: bigint, y: bigint) => (x + y - 1n) / y;
  let amountOut: bigint;
  let newA = pool.reserveA;
  let newB = pool.reserveB;
  if (inIsA) {
    amountOut = pool.reserveB - ceilDiv(k, pool.reserveA + amountInLessFee);
    if (amountOut <= 0n || amountOut >= pool.reserveB) {
      return { ok: false, code: "INSUFFICIENT_LIQUIDITY", message: "Insufficient reserve B." };
    }
    newA = pool.reserveA + amountIn - protocolFee;
    newB = pool.reserveB - amountOut;
  } else {
    amountOut = pool.reserveA - ceilDiv(k, pool.reserveB + amountInLessFee);
    if (amountOut <= 0n || amountOut >= pool.reserveA) {
      return { ok: false, code: "INSUFFICIENT_LIQUIDITY", message: "Insufficient reserve A." };
    }
    newB = pool.reserveB + amountIn - protocolFee;
    newA = pool.reserveA - amountOut;
  }

  const next: LiquidityPool = {
    ...pool,
    reserveA: newA,
    reserveB: newB,
    protocolFeesA: pool.protocolFeesA + (inIsA ? protocolFee : 0n),
    protocolFeesB: pool.protocolFeesB + (inIsB ? protocolFee : 0n),
  };
  if (commit && live) {
    live.reserveA = next.reserveA;
    live.reserveB = next.reserveB;
    live.protocolFeesA = next.protocolFeesA;
    live.protocolFeesB = next.protocolFeesB;
  }
  const spot =
    next.reserveA === 0n ? 0n : (next.reserveB * PRICE_SCALE) / next.reserveA;
  return {
    ok: true,
    amountIn,
    amountOut,
    feePaid,
    protocolFee,
    lpFee,
    pool: next,
    spotPriceE6: spot,
  };
}

export class LiquidityRegistry {
  private pools = new Map<PoolId, LiquidityPool>();

  createPool(
    p: Omit<LiquidityPool, "reserveA" | "reserveB" | "feePpm" | "protocolFeePpm" | "protocolFeesA" | "protocolFeesB"> & {
      reserveA?: bigint;
      reserveB?: bigint;
      feePpm?: bigint;
      protocolFeePpm?: bigint;
    },
  ) {
    const feePpm = p.feePpm ?? DEFAULT_SWAP_FEE_PPM;
    const protocolFeePpm = p.protocolFeePpm ?? (feePpm < DEFAULT_PROTOCOL_SWAP_FEE_PPM ? feePpm : DEFAULT_PROTOCOL_SWAP_FEE_PPM);
    validateSwapFees(feePpm, protocolFeePpm);
    const pool: LiquidityPool = {
      poolId: p.poolId,
      assetA: p.assetA,
      assetB: p.assetB,
      reserveA: p.reserveA ?? 0n,
      reserveB: p.reserveB ?? 0n,
      feePpm,
      protocolFeePpm,
      maxOracleSkewPpm: p.maxOracleSkewPpm,
      protocolFeesA: 0n,
      protocolFeesB: 0n,
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
    assetA: "uep-test/tenergy",
    assetB: "uep-test/teur",
    reserveA: 1_000_000n,
    reserveB: 120_000n,
    feePpm: DEFAULT_SWAP_FEE_PPM,
    protocolFeePpm: DEFAULT_PROTOCOL_SWAP_FEE_PPM,
    maxOracleSkewPpm: 100_000n,
  });
  return reg.get("pool:test:energy-eur")!;
}

export const defaultLiquidity = new LiquidityRegistry();
