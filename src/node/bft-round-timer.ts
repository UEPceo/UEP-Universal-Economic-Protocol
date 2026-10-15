/**
 * 0.5.81 item 3: deterministic, height-based round-change timeout.
 *
 * "Ticks" are heights of the node's height producer (block clock), never wall-clock time. A BFT
 * height that stays undecided for timeoutTicks(round) ticks after its round started times out and
 * the validator signs a round change to round + 1. Timeouts grow with the round
 * (base * 2^min(round, maxDoublings)) so slow networks eventually get long enough rounds. A validator
 * that sees f + 1 round changes for a higher round joins it (at least one honest validator timed out).
 * Pure state machine: the same inputs give the same outputs.
 */
export type RoundTimerConfig = { baseTicks: number; maxDoublings: number };
export const DEFAULT_ROUND_TIMER: RoundTimerConfig = Object.freeze({ baseTicks: 4, maxDoublings: 8 });

export function timeoutTicks(round: number, c: RoundTimerConfig = DEFAULT_ROUND_TIMER): number {
  return c.baseTicks * 2 ** Math.min(round, c.maxDoublings);
}

export class BftRoundTimer {
  private height = 0;
  private round = 0;
  private startTick: number | undefined;
  readonly config: RoundTimerConfig;
  constructor(config: RoundTimerConfig = DEFAULT_ROUND_TIMER) {
    if (!Number.isSafeInteger(config.baseTicks) || config.baseTicks < 1 || !Number.isSafeInteger(config.maxDoublings) || config.maxDoublings < 0) throw new Error("BFT_ROUND_TIMER_CONFIG");
    this.config = config;
  }

  current(): { height: number; round: number; startTick: number | undefined } { return { height: this.height, round: this.round, startTick: this.startTick }; }

  /**
   * Called on every producer tick with the open (undecided) BFT height. Returns the round to move to
   * when the current round timed out, else undefined. A new open height resets to round 0.
   */
  onTick(tick: number, openHeight: number): number | undefined {
    if (!Number.isSafeInteger(tick) || tick < 0) throw new Error("BFT_ROUND_TIMER_TICK");
    if (openHeight !== this.height) { this.height = openHeight; this.round = 0; this.startTick = tick; return undefined; }
    if (this.startTick === undefined) { this.startTick = tick; return undefined; }
    if (tick < this.startTick) return undefined; // a producer that went backwards never fires a timeout
    if (tick - this.startTick < timeoutTicks(this.round, this.config)) return undefined;
    this.round += 1; this.startTick = tick;
    return this.round;
  }

  /** Join a higher round (f + 1 round changes seen, or a valid proposal for it). */
  join(openHeight: number, round: number, tick: number): boolean {
    if (openHeight !== this.height || round <= this.round) return false;
    this.round = round; this.startTick = tick;
    return true;
  }
}
