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
 *  - "height" (default): ticks are block heights from an injected
 *    `HeightSource` (for example `() => ledger.height`) or from a local
 *    `HeightCounter` that only advances when told to.
 *  - "legacy-ms" (test-only): a caller-injected millisecond counter (`now`),
 *    kept so existing tests and experiments that drive a fake clock keep
 *    working. Nothing in the transition code reads a real clock in this mode
 *    either: the caller supplies every value.
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
   * Build a clock from a component config: `height` (a HeightSource) or the
   * test-only legacy millisecond counter `now`, never both. Without either,
   * a local HeightCounter at height 0 is used.
   */
  static from(config: { height?: HeightSource; now?: () => number }): TransitionClock {
    if (config.height !== undefined && config.now !== undefined) throw new Error("CLOCK_CONFIG_CONFLICT: pass either `height` or the test-only `now`, not both");
    if (config.height !== undefined) {
      if (typeof config.height !== "function") throw new Error("HEIGHT_SOURCE_INVALID");
      return new TransitionClock("height", config.height);
    }
    if (config.now !== undefined) {
      if (typeof config.now !== "function") throw new Error("CLOCK_CONFIG_INVALID");
      deprecate(DEPRECATIONS.NOW_OPTION, "the millisecond `now` option is deprecated since v0.5.0 (test-only counter); pass `height` (e.g. () => ledger.height) instead");
      return new TransitionClock("legacy-ms", config.now);
    }
    const counter = new HeightCounter(0);
    return new TransitionClock("height", counter.source(), counter);
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
