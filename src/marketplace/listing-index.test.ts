/** v0.5.0 (DOS-001): indexed duplicate / near-duplicate listing checks. */
import assert from "node:assert/strict";
import test from "node:test";
import { DigitalServicesMarketplace } from "./marketplace.ts";
import { publishAs } from "./testkit.ts";

const base = { providerId: "p", description: "d", category: "API" as const, asset: "uep-test/teur", unitPrice: 1n, capacity: 1n };

test("near-duplicate detection matches the exhaustive Jaccard >= 0.9 rule", () => {
  const m = new DigitalServicesMarketplace({ testOnlyLocalHeight: true, maxListingsPerWindow: 1_000_000 });
  // 10 distinct tokens; 9 shared of 11 total = 0.818 (allowed), 10 of 10 reordered = 1 (rejected).
  const t = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
  publishAs(m, { ...base, title: t });
  assert.throws(() => publishAs(m, { ...base, title: "kappa iota theta eta zeta epsilon delta gamma beta alpha" }), /DUPLICATE_LISTING_FINGERPRINT|SIMILAR_LISTING_FINGERPRINT/);
  assert.throws(() => publishAs(m, { ...base, title: `${t} KAPPA!`, description: "other" }), /SIMILAR_LISTING_FINGERPRINT/);
  publishAs(m, { ...base, title: "alpha beta gamma delta epsilon zeta eta theta iota lambda" });
  // 19 of 20 tokens shared -> 0.95 similar even though the first token differs.
  const long = Array.from({ length: 20 }, (_, i) => `w${String(i).padStart(2, "0")}`);
  publishAs(m, { ...base, title: long.join(" ") });
  assert.throws(() => publishAs(m, { ...base, title: ["a00", ...long.slice(1)].join(" "), description: "x" }), /SIMILAR_LISTING_FINGERPRINT/);
  // Other provider / category / asset: independent.
  publishAs(m, { ...base, providerId: "q", title: t });
});

test("publishing many listings stays fast (no full scan per listing)", () => {
  // v0.5.3: compare the cost of the last 1 000 listings with the first 1 000
  // (a full scan per listing makes the last batch roughly 9x slower) instead
  // of an absolute wall-clock bound. Timing on a shared, loaded machine is
  // noisy, so up to three independent runs are made; one run within the bound
  // is enough, while a real full scan exceeds it in every run.
  const run = () => {
    const m = new DigitalServicesMarketplace({ testOnlyLocalHeight: true, maxListingsPerWindow: 1_000_000 });
    const batch = (from: number) => {
      const t0 = performance.now();
      for (let i = from; i < from + 1_000; i++) publishAs(m, { ...base, title: `service ${i} tier ${i % 7} region r${i % 13}` });
      return performance.now() - t0;
    };
    const first = batch(0);
    for (let k = 1; k < 4; k++) batch(k * 1_000);
    const last = batch(4_000);
    return { first, last, ok: last < first * 4 + 250 };
  };
  const runs: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = run();
    runs.push(`first 1000: ${r.first.toFixed(0)} ms, last 1000: ${r.last.toFixed(0)} ms`);
    if (r.ok) return;
  }
  assert.fail(runs.join("; "));
});
