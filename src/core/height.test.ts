import assert from "node:assert/strict";
import { test } from "node:test";
import { HEIGHTS_PER_DAY, HeightCounter, REFERENCE_BLOCK_TIME_MS, TransitionClock, assertHeight, heightsForMs, msForHeights } from "./height.ts";
import { DOMAIN_PROFILES, delayHeightsFor, domainProfile, isDomainProfileId } from "./domain-profiles.ts";

test("height: counter is deterministic, starts at 0 and only advances on request", () => {
  const c = new HeightCounter();
  assert.equal(c.height(), 0);
  assert.equal(c.advance(), 1);
  assert.equal(c.advance(5), 6);
  assert.equal(c.advance(0), 6);
  assert.throws(() => c.advance(-1), /HEIGHT_ADVANCE_INVALID/);
  assert.throws(() => c.advance(1.5), /HEIGHT_ADVANCE_INVALID/);
  assert.throws(() => new HeightCounter(-1), /HEIGHT_INVALID/);
  assert.equal(assertHeight(0), 0);
  assert.throws(() => assertHeight(Number.NaN), /HEIGHT_INVALID/);
});

test("height: reference block time 5 s; conversions round up to whole heights", () => {
  assert.equal(REFERENCE_BLOCK_TIME_MS, 5_000);
  assert.equal(HEIGHTS_PER_DAY, 17_280);
  assert.equal(heightsForMs(10 * 60_000), 120);
  assert.equal(heightsForMs(1), 1);
  assert.equal(heightsForMs(0), 0);
  assert.equal(heightsForMs(1_203_600), 241);
  assert.equal(msForHeights(602), 3_010_000);
});

test("transition clock: height mode validates the source, refuses regressions and conflicting config", () => {
  let h = 10;
  const clock = TransitionClock.from({ height: () => h });
  assert.equal(clock.unit, "height");
  assert.equal(clock.tick(), 10);
  h = 12;
  assert.equal(clock.tick(), 12);
  h = 11;
  assert.throws(() => clock.tick(), /HEIGHT_REGRESSED/);
  h = 1.5;
  assert.throws(() => clock.tick(), /HEIGHT_INVALID/);
  assert.throws(() => TransitionClock.from({ height: () => 0, now: () => 0 }), /CLOCK_CONFIG_CONFLICT/);
  assert.equal(clock.window("w", undefined, 600_000, 1), 120);
  assert.equal(clock.window("w", 7, undefined, 1), 7);
  assert.equal(clock.window("w", undefined, undefined, 3), 3);
  assert.throws(() => clock.window("w", 1, 1, 1), /CLOCK_CONFIG_CONFLICT/);
  assert.equal(clock.fromMs(-1), -1); // range checks stay with the caller
  // Default: a local counter at height 0.
  const local = TransitionClock.from({});
  assert.equal(local.tick(), 0);
  local.counter!.advance(3);
  assert.equal(local.tick(), 3);
});

test("transition clock: the test-only legacy ms counter keeps ms windows (heights x 5000)", () => {
  let now = 1_000;
  const clock = TransitionClock.from({ now: () => now });
  assert.equal(clock.unit, "legacy-ms");
  assert.equal(clock.tick(), 1_000);
  now = 0;
  assert.equal(clock.tick(), 0); // no monotonicity rule for injected test counters
  assert.equal(clock.window("w", undefined, 600_000, 1), 600_000);
  assert.equal(clock.window("w", 120, undefined, 1), 600_000);
  assert.equal(clock.toNominalMs(600_000), 600_000);
  assert.equal(clock.counter, undefined);
});

test("domain profiles: fixed delays EARTH 0, MOON 1, MARS 602 heights (25 % margin over one round trip)", () => {
  assert.deepEqual(Object.keys(DOMAIN_PROFILES), ["EARTH", "MOON", "MARS"]);
  assert.equal(DOMAIN_PROFILES.EARTH.delayHeights, 0);
  assert.equal(DOMAIN_PROFILES.MOON.delayHeights, 1);
  assert.equal(DOMAIN_PROFILES.MARS.delayHeights, 602);
  // ceil(1.25 * 2 * LT / 5 s)
  assert.equal(delayHeightsFor(1_203_600), Math.ceil((1.25 * 2 * 1_203.6) / 5));
  assert.equal(delayHeightsFor(1_357), 1);
  // The MARS delay covers the maximum one-way light time (20.06 min) and a full round trip.
  const marsMs = msForHeights(DOMAIN_PROFILES.MARS.delayHeights);
  assert.ok(marsMs >= 20.1 * 60_000, "covers 20.1 min one-way");
  assert.ok(marsMs >= 2 * DOMAIN_PROFILES.MARS.oneWayLightTimeMaxMs * 1.25, "covers 1.25 round trips");
  assert.ok(msForHeights(DOMAIN_PROFILES.MOON.delayHeights) >= 2 * 1_300 * 1.25);
  assert.ok(Object.isFrozen(DOMAIN_PROFILES) && Object.isFrozen(DOMAIN_PROFILES.MARS));
  assert.equal(domainProfile(undefined).id, "EARTH");
  assert.throws(() => domainProfile("VENUS" as never), /DOMAIN_PROFILE_INVALID/);
  assert.equal(isDomainProfileId("MARS"), true);
  assert.throws(() => delayHeightsFor(-1), /DOMAIN_DELAY_INVALID/);
});
