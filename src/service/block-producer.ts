/**
 * Local block producer for the single-node testnet (ADR 0002, docs/COMPATIBILITY.md).
 *
 * Since v0.5.0 no state transition reads a clock: every window is a number of
 * block heights. A node operator who wants windows to pass in real time (as
 * the wall-clock defaults did before v0.5.0) advances the height from outside
 * the state machine, for example every 5 s:
 *
 *   const producer = startBlockProducer({ advance: () => ledger.advanceHeight() });
 *   const m = new DigitalServicesMarketplace({ height: () => ledger.height });
 *   ...
 *   producer.stop();
 *
 * This is operator tooling, not a transition: the timer decides when a block
 * is sealed; every replica that replays the same heights reaches the same state.
 */
import { REFERENCE_BLOCK_TIME_MS } from "../core/height.ts";

export type BlockProducer = { stop(): void; readonly running: boolean };

export function startBlockProducer(opts: { advance: () => number; intervalMs?: number; onBlock?: (height: number) => void }): BlockProducer {
  const intervalMs = opts.intervalMs ?? REFERENCE_BLOCK_TIME_MS;
  if (typeof opts.advance !== "function" || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new Error("BLOCK_PRODUCER_CONFIG_INVALID");
  let running = true;
  const timer = setInterval(() => {
    const h = opts.advance();
    opts.onBlock?.(h);
  }, intervalMs);
  timer.unref?.();
  return {
    stop() { if (running) { clearInterval(timer); running = false; } },
    get running() { return running; },
  };
}
