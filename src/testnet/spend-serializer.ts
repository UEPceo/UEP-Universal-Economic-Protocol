/**
 * v0.5.2 (attack battery, CRITICAL "double spend under concurrency"): a FIFO
 * lock for adapters that do asynchronous work before a ledger submit (for
 * example an HTTP handler that awaits an external proof verifier).
 *
 * UepLedger.submit() itself is synchronous: check, nullifier insert and apply
 * run in one turn, so two spends of the same note cannot interleave inside one
 * process. The race described in the battery appears only when an adapter
 * awaits between its own "is this nullifier spent?" read and the submit. Run
 * the whole read-verify-submit sequence inside `run()` and the sequences
 * execute one at a time, in arrival order; the second spend of a note then
 * sees the first one's nullifier and is refused (DOUBLE_SPEND).
 *
 * Process-local only. Several processes sharing one store need a transaction
 * or a conditional insert in that store (outside this reference code).
 * Adapter-side helper: not a transition, never called by one.
 */
export class SpendSerializer {
  private tail: Promise<void> = Promise.resolve();
  private active = 0;
  private peak = 0;

  /** Run `task` after every task queued before it has settled (resolved or rejected). */
  run<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      this.active++;
      this.peak = Math.max(this.peak, this.active);
      try {
        return await task();
      } finally {
        this.active--;
      }
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Largest number of tasks that ran at the same time (1 when the lock works). */
  get peakConcurrency(): number {
    return this.peak;
  }
}
