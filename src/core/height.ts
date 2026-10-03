/**
 * Deterministic time for state transitions (ADR 0002).
 *
 * Inside a state transition, time is the block height of the ledger the
 * transition settles against. Transitions never read the wall clock and never
 * use a block header timestamp (the proposer chooses it). Durations that are
 * specified in seconds or minutes (for example the Earth–Mars light time) are
 * converted to heights ex ante with the reference block time below.
 *
 * `TransitionClock` is the only time source the Marketplace, the paymaster,
 * the treasury and the IoT / M2M service use:
 *  - "height": ticks are block heights from an injected `HeightSource`
 *    (for example `() => ledger.height`, advanced by a HeightProducer outside
 *    the transitions) or, with `testOnlyLocalHeight: true`, from a local
 *    `HeightCounter` that only advances when told to.
 *  - "legacy-ms" (test-only, removed in 0.6.0): a caller-injected
 *    millisecond counter (`testOnlyNowMs`, deprecated alias `now`). Nothing in
 *    the transition code reads a real clock in this mode either.
 * Without a source the clock fails closed (HEIGHT_SOURCE_REQUIRED).
 */
import { DEPRECATIONS, deprecate } from "./deprecation.ts";

/** Reference block time used to convert durations into heights (5 s). */
export const REFERENCE_BLOCK_TIME_MS = 5_000;
/** Heights per day at the reference block time (17_280). */
export const HEIGHTS_PER_DAY = (24 * 60 * 60 * 1000) / REFERENCE_BLOCK_TIME_MS;

/** Returns the current block height (a non-negative safe integer). */
export type HeightSource = () => number;

export type TimeUnit = "height" | "legacy-ms";

/** Smallest number of heights that covers `ms` at the reference block time (ceil). */
export function heightsForMs(ms: number): number {
  return Math.ceil(ms / REFERENCE_BLOCK_TIME_MS);
}

/** Nominal duration of `heights` blocks at the reference block time, in ms. */
export function msForHeights(heights: number): number {
  return heights * REFERENCE_BLOCK_TIME_MS;
}

export function assertHeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("HEIGHT_INVALID: a height is a non-negative safe integer");
  return value;
}

/**
 * Deterministic local height counter. It starts at `start` and only moves
 * through advance(); it never reads a clock. Used as the default height of a
 * stand-alone Marketplace and in tests and simulations.
 */
export class HeightCounter {
  private current: number;
  constructor(start = 0) {
    this.current = assertHeight(start);
  }
  height(): number {
    return this.current;
  }
  /** Advance by `blocks` (>= 0) heights; returns the new height. */
  advance(blocks = 1): number {
    if (!Number.isSafeInteger(blocks) || blocks < 0) throw new Error("HEIGHT_ADVANCE_INVALID");
    const next = this.current + blocks;
    if (!Number.isSafeInteger(next)) throw new Error("HEIGHT_ADVANCE_INVALID");
    this.current = next;
    return next;
  }
  /** Height source bound to this counter. */
  source(): HeightSource {
    return () => this.current;
  }
}

/** Time source of a transition component (see the module comment). */
export class TransitionClock {
  readonly unit: TimeUnit;
  /** Ticks per height: 1 in "height" mode, REFERENCE_BLOCK_TIME_MS in "legacy-ms" mode. */
  readonly ticksPerHeight: number;
  /** The local counter when no source was injected (height mode only). */
  readonly counter?: HeightCounter;
  private readonly source: () => number;
  private last = 0;

  private constructor(unit: TimeUnit, source: () => number, counter?: HeightCounter) {
    this.unit = unit;
    this.ticksPerHeight = unit === "height" ? 1 : REFERENCE_BLOCK_TIME_MS;
    this.source = source;
    this.counter = counter;
  }

  /**
   * Build a clock from a component config. Exactly one of:
   *  - `height`: a HeightSource, e.g. `() => ledger.height` (the ledger's
   *    height is advanced by a HeightProducer outside the transitions);
   *  - `testOnlyLocalHeight: true`: a local HeightCounter at 0 that only
   *    moves through advanceHeight() (tests and offline simulations);
   *  - `testOnlyNowMs`: the test-only millisecond counter. `now` is its
   *    deprecated alias. The millisecond mode is scheduled for removal in
   *    0.6.0 (docs/COMPATIBILITY.md).
   * Without any of them the clock fails closed (HEIGHT_SOURCE_REQUIRED):
   * a silently frozen height would stop every expiry and rate window.
   */
  static from(config: { height?: HeightSource; testOnlyNowMs?: () => number; now?: () => number; testOnlyLocalHeight?: boolean }): TransitionClock {
    if (config.testOnlyNowMs !== undefined && config.now !== undefined) throw new Error("CLOCK_CONFIG_CONFLICT: `now` is the deprecated alias of `testOnlyNowMs`; pass one");
    const nowMs = config.testOnlyNowMs ?? config.now;
    const local = config.testOnlyLocalHeight === true;
    if (config.testOnlyLocalHeight !== undefined && typeof config.testOnlyLocalHeight !== "boolean") throw new Error("CLOCK_CONFIG_INVALID: testOnlyLocalHeight is a boolean");
    if ([config.height !== undefined, nowMs !== undefined, local].filter(Boolean).length > 1) throw new Error("CLOCK_CONFIG_CONFLICT: pass exactly one of `height`, `testOnlyLocalHeight` or the test-only `testOnlyNowMs`");
    if (config.height !== undefined) {
      if (typeof config.height !== "function") throw new Error("HEIGHT_SOURCE_INVALID");
      return new TransitionClock("height", config.height);
    }
    if (nowMs !== undefined) {
      if (typeof nowMs !== "function") throw new Error("CLOCK_CONFIG_INVALID");
      if (config.now !== undefined) deprecate(DEPRECATIONS.NOW_OPTION, "`now` is deprecated since v0.5.0: it is the test-only millisecond counter, renamed `testOnlyNowMs`; the millisecond mode is removed in 0.6.0. Pass `height: () => ledger.height` (with a HeightProducer) instead");
      return new TransitionClock("legacy-ms", nowMs);
    }
    if (local) {
      const counter = new HeightCounter(0);
      return new TransitionClock("height", counter.source(), counter);
    }
    throw new Error("HEIGHT_SOURCE_REQUIRED: pass `height: () => ledger.height` (advanced by a HeightProducer, src/service/height-producer.ts), or `testOnlyLocalHeight: true` in tests and offline simulations");
  }

  /** Current tick. In height mode: a validated height that never goes backwards. */
  tick(): number {
    const value = this.source();
    if (this.unit === "legacy-ms") {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("CLOCK_VALUE_INVALID");
      return value;
    }
    assertHeight(value);
    if (value < this.last) throw new Error("HEIGHT_REGRESSED: the height source went backwards");
    this.last = value;
    return value;
  }

  /** Ticks for a number of heights. */
  fromHeights(heights: number): number {
    return heights * this.ticksPerHeight;
  }

  /** Ticks for a duration in ms (ceil to whole heights in height mode; negative or non-finite values pass through for the caller's range check). */
  fromMs(ms: number): number {
    if (this.unit === "legacy-ms" || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return ms;
    return heightsForMs(ms);
  }

  /** Nominal ms of a tick count (heights at the reference block time). */
  toNominalMs(ticks: number): number {
    return this.unit === "legacy-ms" ? ticks : msForHeights(ticks);
  }

  /** Heights of a tick count (exact in height mode; ceil in legacy-ms mode). */
  toHeights(ticks: number): number {
    return this.unit === "height" ? ticks : heightsForMs(ticks);
  }

  /**
   * Resolve one window option: `heights` or legacy `ms` (never both), else
   * `defaultHeights`. Returns ticks. Range checks stay with the caller.
   */
  window(name: string, heights: number | undefined, ms: number | undefined, defaultHeights: number): number {
    if (heights !== undefined && ms !== undefined) throw new Error(`CLOCK_CONFIG_CONFLICT: ${name} is given both in heights and in ms`);
    if (heights !== undefined) return this.fromHeights(heights);
    if (ms !== undefined) {
      deprecate(DEPRECATIONS.MS_OPTION, `${name}: millisecond options (*Ms) are deprecated since v0.5.0 and converted to heights (ceil, 5 s blocks); use the *Heights option`);
      return this.fromMs(ms);
    }
    return this.fromHeights(defaultHeights);
  }
}

/**
 * v0.5.0 compatibility (docs/COMPATIBILITY.md): the height that corresponds
 * to a legacy Unix-ms timestamp, given the current height and the current
 * Unix-ms time of the caller. Pure: boundary adapters (service API, HTTP)
 * pass their own wall-clock reading; transitions never call this.
 * Past timestamps round their age up (older), future ones round down.
 */
export function legacyMsToHeight(timestampMs: number, currentHeight: number, wallNowMs: number): number {
  assertHeight(currentHeight);
  if (!Number.isFinite(timestampMs) || !Number.isFinite(wallNowMs)) throw new Error("CLOCK_VALUE_INVALID");
  const delta = wallNowMs - timestampMs;
  return delta >= 0 ? currentHeight - Math.ceil(delta / REFERENCE_BLOCK_TIME_MS) : currentHeight + Math.floor(-delta / REFERENCE_BLOCK_TIME_MS);
}
