/**
 * Height producer for the single-node testnet (ADR 0002).
 *
 * Since v0.5.1 no state transition reads a clock: every window is a number of
 * block heights. This producer is the one place that turns real time into
 * heights. It runs OUTSIDE the state machine (it is node tooling, not a
 * transition), measures elapsed time with a MONOTONIC clock and seals one
 * block every `blockTimeMs` (default REFERENCE_BLOCK_TIME_MS = 5 s):
 *
 *   const producer = new HeightProducer({ ledger }).start();
 *   const height = heightOf(ledger);
 *   const m = new DigitalServicesMarketplace({ height });
 *   ...
 *   producer.stop();
 *
 * Rules (each one is tested in height-producer.test.ts):
 *  - Monotonic time: elapsed time comes from `performance.now()` (or an
 *    injected monotonic `clock`), never from the wall clock. A step of the
 *    system clock (NTP, a manual change) does not seal blocks; it is only
 *    logged (`wall-clock-jump`, compared against `wallClock`, default
 *    Date.now).
 *  - Real-time bound: after `t` ms of monotonic time since the producer was
 *    anchored, the height it allows is anchorHeight + floor(t / blockTimeMs).
 *    It never runs ahead of that.
 *  - Catch-up cap: one tick seals at most `maxBlocksPerTick` blocks
 *    (MAX_BLOCKS_PER_TICK = 12, one minute). After a longer gap (a stalled
 *    event loop, a suspended process) the rest of the gap is dropped and
 *    logged (`catch-up-capped`): windows freeze for that time instead of
 *    expiring at once.
 *  - Restart: a new producer anchors at the restored height and the current
 *    time. Downtime does not count: operator downtime extends every deadline
 *    in real time and never expires a party (docs/THREAT-MODEL.md).
 *  - Minimum block spacing: `blockTimeMs` may not be shorter than
 *    MIN_BLOCK_SPACING_MS (= the 5 s reference). Faster blocks would shorten
 *    every window in real time.
 *  - An injected clock that goes backwards seals nothing until it has caught up.
 *  - Height that was advanced by someone else (an operator calling
 *    `ledger.advanceHeight()` directly) is not added to: the producer waits
 *    until real time reaches it (the chain stands still for that long) and
 *    reports the lead (`aheadBy`).
 *  - Restore: `rebind(restoredLedger)` moves the producer to the restored
 *    ledger. A producer whose ledger was retired by a restore
 *    (`UepLedger.restore(..., { replaces })`) stops at its next tick.
 *
 * Trust: the single-node operator is the time authority. The producer
 * makes the honest path safe. v0.5.3: while it runs it holds the target's
 * height authority (`exclusive`, default true), so direct
 * `advanceHeight()` calls on the ledger are refused
 * (HEIGHT_AUTHORITY_REQUIRED) and a second producer cannot start
 * (HEIGHT_AUTHORITY_TAKEN); no HTTP route advances height. An operator who
 * controls the process can still build a ledger without a producer and
 * advance it (bounded to 12 blocks per call outside test mode): a
 * documented residual until heights come from distributed consensus. See
 * docs/THREAT-MODEL.md.
 */
import { HeightAuthorityGuard, MAX_BLOCKS_PER_TICK, REFERENCE_BLOCK_TIME_MS, assertHeight, type HeightAuthority } from "../core/height.ts";
import { isProductionEnvironment, testOnlyOption } from "../core/test-only.ts";

/** Shortest block time the producer accepts (the reference block time). */
export const MIN_BLOCK_SPACING_MS = REFERENCE_BLOCK_TIME_MS;
export { MAX_BLOCKS_PER_TICK };

export type HeightProducerTarget = {
  readonly height: number;
  advanceHeight(blocks?: number, authority?: HeightAuthority): number;
  /** v0.5.3 (optional): exclusive height authority (UepLedger, ProducedHeight). */
  claimHeightAuthority?(holder?: string): HeightAuthority;
  releaseHeightAuthority?(authority: HeightAuthority): void;
};

export type HeightProducerEvent =
  | { kind: "catch-up-capped"; due: number; sealed: number; dropped: number; height: number }
  | { kind: "wall-clock-jump"; jumpMs: number; wallElapsedMs: number; monotonicElapsedMs: number }
  | { kind: "stopped"; reason: string };

export type HeightProducerConfig = {
  /** The ledger (or any target with `height` and `advanceHeight(n)`). */
  ledger: HeightProducerTarget;
  /** Block time in ms (default REFERENCE_BLOCK_TIME_MS); at least MIN_BLOCK_SPACING_MS. */
  blockTimeMs?: number;
  /**
   * Monotonic clock in ms (default performance.now). Simulations inject a
   * simulated clock. v0.5.3: refused under NODE_ENV=production (an injected
   * clock lets the caller fast-forward every window); `testOnlyClock` is
   * the explicit name.
   */
  clock?: () => number;
  /** v0.5.3 TEST-ONLY alias of `clock` (refused under NODE_ENV=production). */
  testOnlyClock?: () => number;
  /** Wall clock in Unix ms, only to detect and log jumps (default Date.now; none when `clock` is injected and this is not). Never used for heights. */
  wallClock?: () => number;
  /** Difference between wall and monotonic elapsed time that counts as a jump (default one block time). */
  wallClockJumpToleranceMs?: number;
  /** Most blocks one tick seals (1 to MAX_BLOCKS_PER_TICK; default MAX_BLOCKS_PER_TICK). */
  maxBlocksPerTick?: number;
  /** Called after each tick that sealed blocks. */
  onBlocks?: (event: { height: number; sealed: number }) => void;
  /** Log sink for capped catch-ups, wall-clock jumps and stops (default console.warn). */
  log?: (event: HeightProducerEvent) => void;
  /**
   * v0.5.3: claim the target's height authority at the first tick / start()
   * and keep it until stop(), so nobody else can advance the height while the
   * producer runs (default true; targets without the capability are driven as before).
   */
  exclusive?: boolean;
};

export type HeightProducerStatus = {
  height: number;
  /** Height real time allows now. */
  allowedHeight: number;
  /** Heights the target is ahead of real time (advanced outside the producer). */
  aheadBy: number;
  blockTimeMs: number;
  maxBlocksPerTick: number;
  running: boolean;
  /** Blocks not sealed because a gap exceeded the per-tick cap (frozen time). */
  droppedBlocks: number;
  /** Wall-clock jumps seen so far (logged, never sealed). */
  wallClockJumps: number;
  /** v0.5.3: message of the error that stopped the timer, if any (cleared by start()). */
  lastError?: string;
};

const defaultLog = (e: HeightProducerEvent) => console.warn(`[uep height-producer] ${JSON.stringify(e)}`);
const defaultMonotonic = () => performance.now();
const defaultWall = () => Date.now();

export class HeightProducer {
  readonly blockTimeMs: number;
  readonly maxBlocksPerTick: number;
  private ledger: HeightProducerTarget;
  private lastErrorMessage: string | undefined;
  private readonly clock: () => number;
  private readonly wallClock?: () => number;
  private readonly jumpToleranceMs: number;
  private readonly onBlocks?: HeightProducerConfig["onBlocks"];
  private readonly log: (event: HeightProducerEvent) => void;
  private anchorMs: number;
  private anchorHeight: number;
  private lastMono: number;
  private lastWall: number;
  private dropped = 0;
  private jumps = 0;
  private timer?: ReturnType<typeof setInterval>;
  private readonly exclusive: boolean;
  private authority: HeightAuthority | undefined;

  constructor(config: HeightProducerConfig) {
    if (!config || !config.ledger || typeof config.ledger.advanceHeight !== "function") throw new Error("HEIGHT_PRODUCER_CONFIG_INVALID: a ledger with advanceHeight() is required");
    const blockTimeMs = config.blockTimeMs ?? REFERENCE_BLOCK_TIME_MS;
    if (!Number.isSafeInteger(blockTimeMs) || blockTimeMs <= 0) throw new Error("HEIGHT_PRODUCER_CONFIG_INVALID: blockTimeMs is a positive integer");
    if (blockTimeMs < MIN_BLOCK_SPACING_MS) throw new Error(`HEIGHT_PRODUCER_BLOCK_SPACING: blockTimeMs ${blockTimeMs} is below the minimum block spacing of ${MIN_BLOCK_SPACING_MS} ms`);
    const cap = config.maxBlocksPerTick ?? MAX_BLOCKS_PER_TICK;
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > MAX_BLOCKS_PER_TICK) throw new Error(`HEIGHT_PRODUCER_CONFIG_INVALID: maxBlocksPerTick is 1 to ${MAX_BLOCKS_PER_TICK}`);
    const tolerance = config.wallClockJumpToleranceMs ?? blockTimeMs;
    if (!Number.isFinite(tolerance) || tolerance <= 0) throw new Error("HEIGHT_PRODUCER_CONFIG_INVALID: wallClockJumpToleranceMs is positive");
    this.blockTimeMs = blockTimeMs;
    this.maxBlocksPerTick = cap;
    this.exclusive = config.exclusive ?? true;
    this.jumpToleranceMs = tolerance;
    this.ledger = config.ledger;
    if (config.clock !== undefined && config.testOnlyClock !== undefined) throw new Error("HEIGHT_PRODUCER_CONFIG_INVALID: pass clock or testOnlyClock, not both");
    const injected = config.testOnlyClock ?? config.clock;
    if (injected !== undefined) {
      if (typeof injected !== "function") throw new Error("HEIGHT_PRODUCER_CONFIG_INVALID: clock is a function");
      if (isProductionEnvironment()) throw new Error("HEIGHT_PRODUCER_CLOCK_TEST_ONLY: an injected producer clock is refused under NODE_ENV=production (it could fast-forward every window)");
    }
    this.clock = injected ?? defaultMonotonic;
    this.wallClock = config.wallClock ?? (injected ? undefined : defaultWall);
    this.onBlocks = config.onBlocks;
    this.log = config.log ?? defaultLog;
    this.anchorMs = this.readClock();
    this.anchorHeight = assertHeight(this.ledger.height);
    this.lastMono = this.anchorMs;
    this.lastWall = this.readWall();
  }

  private readClock(): number {
    const t = this.clock();
    if (typeof t !== "number" || !Number.isFinite(t)) throw new Error("HEIGHT_PRODUCER_CLOCK_INVALID");
    return t;
  }

  private readWall(): number {
    if (!this.wallClock) return Number.NaN;
    const t = this.wallClock();
    return typeof t === "number" && Number.isFinite(t) ? t : Number.NaN;
  }

  /** Height that real time allows at monotonic time `now`: anchorHeight + floor(elapsed / blockTimeMs); never below the anchor. */
  private allowedAt(now: number): number {
    const elapsed = now - this.anchorMs;
    return elapsed <= 0 ? this.anchorHeight : this.anchorHeight + Math.floor(elapsed / this.blockTimeMs);
  }

  /** Height that real time allows now. */
  allowedHeight(): number {
    return this.allowedAt(this.readClock());
  }

  /** Compare wall and monotonic elapsed time since the last tick; log a jump. Never seals. */
  private checkWallClock(now: number): void {
    const wall = this.readWall();
    const wallElapsed = wall - this.lastWall;
    const monoElapsed = now - this.lastMono;
    if (Number.isFinite(wallElapsed) && Math.abs(wallElapsed - monoElapsed) > this.jumpToleranceMs) {
      this.jumps++;
      this.log({ kind: "wall-clock-jump", jumpMs: wallElapsed - monoElapsed, wallElapsedMs: wallElapsed, monotonicElapsedMs: monoElapsed });
    }
    this.lastWall = wall;
    this.lastMono = now;
  }

  /** Seal the blocks real time allows (0 to maxBlocksPerTick). Returns the number sealed. */
  tick(): number {
    const now = this.readClock();
    this.checkWallClock(now);
    const allowed = this.allowedAt(now);
    const current = this.ledger.height;
    const due = allowed - current;
    if (due <= 0) return 0;
    const sealed = Math.min(due, this.maxBlocksPerTick);
    let height: number;
    try {
      this.claimAuthority();
      height = this.ledger.advanceHeight(sealed, this.authority);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.startsWith("LEDGER_RETIRED")) {
        this.stop();
        this.log({ kind: "stopped", reason: "ledger retired by a restore; rebind() the producer to the restored ledger" });
        return 0;
      }
      throw e;
    }
    if (due > sealed) {
      // Frozen time: the rest of the gap does not count (no catch-up beyond the cap).
      const dropped = due - sealed;
      this.anchorMs += dropped * this.blockTimeMs;
      this.dropped += dropped;
      this.log({ kind: "catch-up-capped", due, sealed, dropped, height });
    }
    this.onBlocks?.({ height, sealed });
    return sealed;
  }

  /**
   * Move the producer to another target (for example the ledger returned by
   * a restore). It anchors at that target's height and the current time, so
   * the time before the rebind does not count.
   */
  rebind(target: HeightProducerTarget): this {
    if (!target || typeof target.advanceHeight !== "function") throw new Error("HEIGHT_PRODUCER_CONFIG_INVALID: a ledger with advanceHeight() is required");
    this.releaseAuthority();
    this.ledger = target;
    this.anchorMs = this.readClock();
    this.anchorHeight = assertHeight(target.height);
    this.lastMono = this.anchorMs;
    this.lastWall = this.readWall();
    if (this.timer) this.claimAuthority();
    return this;
  }

  /** v0.5.3: take the target's height authority (exclusive mode, target with the capability). */
  private claimAuthority(): void {
    if (!this.exclusive || this.authority || typeof this.ledger.claimHeightAuthority !== "function") return;
    this.authority = this.ledger.claimHeightAuthority("height-producer");
  }

  private releaseAuthority(): void {
    const a = this.authority;
    this.authority = undefined;
    if (a && typeof this.ledger.releaseHeightAuthority === "function") {
      try { this.ledger.releaseHeightAuthority(a); } catch { /* already released or retired */ }
    }
  }

  /** v0.5.3: true while this producer holds the target's height authority. */
  get holdsHeightAuthority(): boolean {
    return this.authority !== undefined;
  }

  /** Start sealing on a timer (unref'ed, so it never keeps the process alive). */
  start(): this {
    if (this.timer) return this;
    // v0.5.3: refuse to start while someone else holds the height authority (HEIGHT_AUTHORITY_TAKEN).
    this.claimAuthority();
    this.lastErrorMessage = undefined;
    this.timer = setInterval(() => {
      try { this.tick(); } catch (e) { this.lastErrorMessage = e instanceof Error ? e.message : String(e); this.log({ kind: "stopped", reason: this.lastErrorMessage }); this.stop(); }
    }, this.blockTimeMs);
    this.timer.unref?.();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.releaseAuthority();
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  status(): HeightProducerStatus {
    const allowed = this.allowedHeight();
    const height = this.ledger.height;
    return { height, allowedHeight: allowed, aheadBy: Math.max(0, height - allowed), blockTimeMs: this.blockTimeMs, maxBlocksPerTick: this.maxBlocksPerTick, running: this.running, droppedBlocks: this.dropped, wallClockJumps: this.jumps, ...(this.lastErrorMessage !== undefined ? { lastError: this.lastErrorMessage } : {}) };
  }

  /** v0.5.3: the target this producer seals blocks on (the ledger, or a ProducedHeight). */
  get target(): HeightProducerTarget {
    return this.ledger;
  }
}

/**
 * A height source with its own counter, for stand-alone Marketplaces driven
 * by a HeightProducer (no ledger). Like the ledger, advanceHeight(n) accepts
 * at most MAX_BLOCKS_PER_TICK per call unless built with the test-only
 * `testOnlyUnboundedHeightAdvance`.
 */
export class ProducedHeight implements HeightProducerTarget {
  private value = 0;
  private readonly unbounded: boolean;
  private readonly authorityGuard = new HeightAuthorityGuard();
  constructor(opts: { testOnlyUnboundedHeightAdvance?: boolean } = {}) {
    this.unbounded = testOnlyOption("testOnlyUnboundedHeightAdvance", opts.testOnlyUnboundedHeightAdvance);
  }
  get height(): number {
    return this.value;
  }
  claimHeightAuthority(holder = "height-producer"): HeightAuthority {
    return this.authorityGuard.claim(holder);
  }
  releaseHeightAuthority(authority: HeightAuthority): void {
    this.authorityGuard.release(authority);
  }
  advanceHeight(blocks = 1, authority?: HeightAuthority): number {
    this.authorityGuard.check(authority);
    if (!Number.isSafeInteger(blocks) || blocks < 0 || !Number.isSafeInteger(this.value + blocks)) throw new Error("HEIGHT_ADVANCE_INVALID");
    if (blocks > MAX_BLOCKS_PER_TICK && !this.unbounded) throw new Error(`HEIGHT_ADVANCE_CAP: at most ${MAX_BLOCKS_PER_TICK} blocks per call`);
    this.value += blocks;
    return this.value;
  }
}
