import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SecurityPolicy } from "../core/security-policy.ts";
import { OracleAggregator, seedTestnetOracles, PRICE_SCALE } from "./oracle.ts";
import { LiquidityRegistry, seedTestnetLiquidity } from "./liquidity.ts";
import { SPEND_PUBLIC_INPUT_NAMES } from "../core/spend-proof.ts";

describe("security policy", () => {
  it("allows normal spend and rate-limits", () => {
    const p = new SecurityPolicy({
      maxTransferAmount: 1000n,
      maxTxPerWindow: 2,
      maxTransferPerWindow: 1500n,
      windowMs: 60_000,
    });
    const base = {
      accountHex: "abc",
      assetId: "asset:test:energy",
      fee: 0n,
      nowMs: 1_000,
    };
    assert.equal(p.check({ ...base, amount: 500n }, true).ok, true);
    assert.equal(p.check({ ...base, amount: 500n }, true).ok, true);
    const third = p.check({ ...base, amount: 1n }, true);
    assert.equal(third.ok, false);
    if (!third.ok) assert.equal(third.code, "RATE_LIMIT");
  });

  it("pauses and halts assets", () => {
    const p = new SecurityPolicy();
    p.setPaused(true);
    const r = p.check({
      accountHex: "x",
      assetId: "asset:test:energy",
      amount: 1n,
      fee: 0n,
      nowMs: 0,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "PAUSED");
    p.setPaused(false);
    p.setAssetTier("asset:test:energy", "halted");
    const h = p.check({
      accountHex: "x",
      assetId: "asset:test:energy",
      amount: 1n,
      fee: 0n,
      nowMs: 0,
    });
    assert.equal(h.ok, false);
    if (!h.ok) assert.equal(h.code, "ASSET_HALTED");
  });
});

describe("oracle aggregator", () => {
  it("aggregates median and rejects stale", () => {
    const o = new OracleAggregator({ maxStalenessMs: 1000, minSources: 2 });
    seedTestnetOracles(o, 10_000);
    const ok = o.read("asset:test:energy", "asset:test:eur", 10_500);
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.quote.sourcesUsed, 2);
      assert.ok(ok.quote.priceE6 > 0n);
    }
    const stale = o.read("asset:test:energy", "asset:test:eur", 20_000);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, "STALE");
  });

  it("rejects high deviation", () => {
    const o = new OracleAggregator({
      maxDeviationPpm: 1000n,
      minSources: 2,
      maxStalenessMs: 60_000,
    });
    o.publish({
      baseAssetId: "a",
      quoteAssetId: "b",
      priceE6: 100n * PRICE_SCALE,
      source: "s1",
      observedAtMs: 0,
    });
    o.publish({
      baseAssetId: "a",
      quoteAssetId: "b",
      priceE6: 200n * PRICE_SCALE,
      source: "s2",
      observedAtMs: 0,
    });
    const r = o.read("a", "b", 0);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "DEVIATION");
  });
});

describe("liquidity AMM", () => {
  it("simulate then swap; oracle skew rejects", () => {
    const reg = new LiquidityRegistry();
    seedTestnetLiquidity(reg);
    const o = new OracleAggregator({ minSources: 1, maxStalenessMs: 60_000 });
    seedTestnetOracles(o, 0);
    const q = o.read("asset:test:energy", "asset:test:eur", 0);
    assert.equal(q.ok, true);

    const sim = reg.simulateSwap(
      "pool:test:energy-eur",
      "asset:test:energy",
      10_000n,
      q.ok ? q.quote : null,
    );
    assert.equal(sim.ok, true);
    const before = reg.get("pool:test:energy-eur")!.reserveA;
    const swap = reg.swap(
      "pool:test:energy-eur",
      "asset:test:energy",
      10_000n,
      q.ok ? q.quote : null,
    );
    assert.equal(swap.ok, true);
    assert.notEqual(reg.get("pool:test:energy-eur")!.reserveA, before);

    o.publish({
      baseAssetId: "asset:test:energy",
      quoteAssetId: "asset:test:eur",
      priceE6: 1n,
      source: "sim-feed-a",
      observedAtMs: 0,
    });
    o.publish({
      baseAssetId: "asset:test:energy",
      quoteAssetId: "asset:test:eur",
      priceE6: 1n,
      source: "sim-feed-b",
      observedAtMs: 0,
    });
    const badQ = o.read("asset:test:energy", "asset:test:eur", 0);
    const skewed = reg.simulateSwap(
      "pool:test:energy-eur",
      "asset:test:energy",
      100n,
      badQ.ok ? badQ.quote : null,
    );
    assert.equal(skewed.ok, false);
    if (!skewed.ok) assert.equal(skewed.code, "ORACLE_SKEW");
  });
});

describe("public input schema", () => {
  it("has 12 names aligned with Rust", () => {
    assert.equal(SPEND_PUBLIC_INPUT_NAMES.length, 12);
    assert.equal(SPEND_PUBLIC_INPUT_NAMES[6], "treasury_id");
    assert.equal(SPEND_PUBLIC_INPUT_NAMES[7], "asset_id");
  });
});
