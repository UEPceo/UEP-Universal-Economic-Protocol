/**
 * Height producer for the single-node testnet (ADR 0002).
 *
 * Since v0.5.0 no state transition reads a clock: every window is a number of
 * block heights. This producer is the one place that turns real time into
 * heights. It runs OUTSIDE the state machine (it is node tooling, not a
 * transition), reads the wall clock and seals one block every
 * `blockTimeMs` (default REFERENCE_BLOCK_TIME_MS = 5 s):
 *
 *   const producer = new HeightProducer({ ledger }).start();
 *   const m = new DigitalServicesMarketplace({ height: () => ledger.height });
 *   ...
 *   producer.stop();
 *
 * Rules (each one is tested in height-producer.test.ts):
 *  - Real-time bound: after `t` ms of wall-clock time since the producer was
 *    anchored, the height it allows is anchorHeight + floor(t / blockTimeMs).
 *    It seals blocks only up to that height. After a pause (a slow event
 *    loop, a suspended process) it catches up n blocks only when n x
 *    blockTimeMs have really passed; it never runs ahead of the clock.
 *  - Minimum block spacing: `blockTimeMs` may not be shorter than
 *    MIN_BLOCK_SPACING_MS (= the 5 s reference). Faster blocks would shorten
 *    every window in real time (the MARS round trip needs blocks of at least
 *    3.34 s; telemetry alone 1.82 s). Slower blocks only lengthen windows.
 *  - A wall clock that goes backwards seals nothing until it has caught up.
 *  - Height that was advanced by someone else (an operator calling
 *    `ledger.advanceHeight()` directly) is not added to: the producer waits
 *    until real time reaches it, and reports the lead (`aheadBy`).
 *
 * Trust: the single-node operator is the time authority. The producer
 * makes the honest path safe; it cannot stop the operator from calling
 * `advanceHeight()` on the ledger object. See docs/THREAT-MODEL.md.
 */
import { REFERENCE_BLOCK_TIME_MS, assertHeight } from "../core/height.ts";

/** Shortest block time the producer accepts (the reference block time). */
export const MIN_BLOCK_SPACING_MS = REFERENCE_BLOCK_TIME_MS;

export type HeightProducerTarget = { readonly height: number; advanceHeight(blocks?: number): number };

export type HeightProducerConfig = {
  /** The ledger (or any target with `height` and `advanceHeight(n)`). */
  ledger: HeightProducerTarget;
  /** Block time in ms (default REFERENCE_BLOCK_TIME_MS); at least MIN_BLOCK_SPACING_MS. */
  blockTimeMs?: number;
  /** Wall clock in Unix ms (default Date.now). Simulations inject a simulated clock. */
  clock?: () => number;
  /** Called after each tick that sealed blocks. */
  onBlocks?: (event: { height: number; sealed: number }) => void;
};

export type HeightProducerStatus = {
  height: number;
  /** Height real time allows now. */
  allowedHeight: number;
  /** Heights the target is ahead of real time (advanced outside the producer). */
  aheadBy: number;
  blockTimeMs: number;
  running: boolean;
};

export class HeightProducer {
  readonly blockTimeMs: number;
  private readonly ledger: HeightProducerTarget;
  private readonly clock: () => number;
  private readonly onBlocks?: HeightProducerConfig["onBlocks"];
  private readonly anchorMs: number;
  private readonly anchorHeight: number;
  private timer?: ReturnType<typeof setInterval>;

  constructor(config: HeightProducerConfig) {
    if (!config || !config.ledger || typeof config.ledger.advanceHeight !== "function") throw new Error("HEIGHT_PRODUCER_CONFIG_INVALID: a ledger with advanceHeight() is required");
    const blockTimeMs = config.blockTimeMs ?? REFERENCE_BLOCK_TIME_MS;
    if (!Number.isSafeInteger(blockTimeMs) || blockTimeMs <= 0) throw new Error("HEIGHT_PRODUCER_CONFIG_INVALID: blockTimeMs is a positive integer");
    if (blockTimeMs < MIN_BLOCK_SPACING_MS) throw new Error(`HEIGHT_PRODUCER_BLOCK_SPACING: blockTimeMs ${blockTimeMs} is below the minimum block spacing of ${MIN_BLOCK_SPACING_MS} ms`);
    this.blockTimeMs = blockTimeMs;
    this.ledger = config.ledger;
    this.clock = config.clock ?? (() => Date.now());
    this.onBlocks = config.onBlocks;
    this.anchorMs = this.readClock();
    this.anchorHeight = assertHeight(this.ledger.height);
  }

  private readClock(): number {
    const t = this.clock();
    if (typeof t !== "number" || !Number.isFinite(t)) throw new Error("HEIGHT_PRODUCER_CLOCK_INVALID");
    return t;
  }

  /** Height that real time allows now: anchorHeight + floor(elapsed / blockTimeMs); never below the anchor. */
  allowedHeight(): number {
    const elapsed = this.readClock() - this.anchorMs;
    return elapsed <= 0 ? this.anchorHeight : this.anchorHeight + Math.floor(elapsed / this.blockTimeMs);
  }

  /** Seal the blocks real time allows (0 or more). Returns the number sealed. */
  tick(): number {
    const allowed = this.allowedHeight();
    const current = this.ledger.height;
    const due = allowed - current;
    if (due <= 0) return 0;
    const height = this.ledger.advanceHeight(due);
    this.onBlocks?.({ height, sealed: due });
    return due;
  }

  /** Start sealing on a timer (unref'ed, so it never keeps the process alive). */
  start(): this {
    if (this.timer) return this;
    this.timer = setInterval(() => this.tick(), this.blockTimeMs);
    this.timer.unref?.();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  status(): HeightProducerStatus {
    const allowed = this.allowedHeight();
    const height = this.ledger.height;
    return { height, allowedHeight: allowed, aheadBy: Math.max(0, height - allowed), blockTimeMs: this.blockTimeMs, running: this.running };
  }
}

/** A height source with its own counter, for stand-alone Marketplaces driven by a HeightProducer (no ledger). */
export class ProducedHeight implements HeightProducerTarget {
  private value = 0;
  get height(): number {
    return this.value;
  }
  advanceHeight(blocks = 1): number {
    if (!Number.isSafeInteger(blocks) || blocks < 0 || !Number.isSafeInteger(this.value + blocks)) throw new Error("HEIGHT_ADVANCE_INVALID");
    this.value += blocks;
    return this.value;
  }
}
