import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_PROTOCOL_SWAP_FEE_PPM,
  DEFAULT_SWAP_FEE_PPM,
  LiquidityRegistry,
  seedTestnetLiquidity,
} from "./liquidity.ts";

describe("liquidity-pool lab fee split (simulation only)", () => {
  it("defaults: 0.3% total = 0.1% protocol + 0.2% liquidity providers", () => {
    assert.equal(DEFAULT_SWAP_FEE_PPM, 3_000n);
    assert.equal(DEFAULT_PROTOCOL_SWAP_FEE_PPM, 1_000n);
    const reg = new LiquidityRegistry();
    const pool = seedTestnetLiquidity(reg);
    const a0 = pool.reserveA;
    const b0 = pool.reserveB;
    const r = reg.swap(pool.poolId, pool.assetA, 100_000n);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.feePaid, 300n);
    assert.equal(r.protocolFee, 100n);
    assert.equal(r.lpFee, 200n);
    const live = reg.get(pool.poolId)!;
    // Input is conserved: reserves + protocol treasury share account for every unit.
    assert.equal(live.reserveA + live.protocolFeesA - a0, 100_000n);
    assert.equal(live.protocolFeesA, 100n);
    assert.equal(b0 - live.reserveB, r.amountOut);
    // The LP share stays in the pool, so k grows.
    assert.ok(live.reserveA * live.reserveB > a0 * b0);
  });

  it("fees are configurable per pool and validated", () => {
    const reg = new LiquidityRegistry();
    const p = reg.createPool({ poolId: "p", assetA: "a", assetB: "b", reserveA: 1_000_000n, reserveB: 1_000_000n, feePpm: 5_000n, protocolFeePpm: 0n, maxOracleSkewPpm: 100_000n });
    const r = reg.swap(p.poolId, "b", 10_000n);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.protocolFee, 0n);
      assert.equal(r.lpFee, 50n);
    }
    assert.throws(() => reg.createPool({ poolId: "x", assetA: "a", assetB: "b", feePpm: 1_000n, protocolFeePpm: 2_000n, maxOracleSkewPpm: 0n }), /SWAP_PROTOCOL_FEE_INVALID/);
    assert.throws(() => reg.createPool({ poolId: "y", assetA: "a", assetB: "b", feePpm: 1_000_000n, maxOracleSkewPpm: 0n }), /SWAP_FEE_INVALID/);
    assert.throws(() => reg.createPool({ poolId: "z", assetA: "a", assetB: "b", feePpm: -1n, maxOracleSkewPpm: 0n }), /SWAP_FEE_INVALID/);
  });

  it("simulateSwap does not move reserves or collected fees", () => {
    const reg = new LiquidityRegistry();
    const pool = seedTestnetLiquidity(reg);
    const before = { ...reg.get(pool.poolId)! };
    const r = reg.simulateSwap(pool.poolId, pool.assetB, 1_000n);
    assert.equal(r.ok, true);
    assert.deepEqual(reg.get(pool.poolId), before);
  });
});
