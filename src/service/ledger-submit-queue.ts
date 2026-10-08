/**
 * v0.5.3 (external review 2026-10-08): bounded FIFO submit queue in front of
 * a ledger, with a queue-wait timeout and backpressure.
 *
 * UepLedger.submit() is synchronous and refuses re-entry (LEDGER_BUSY). A
 * service that receives many spends at once needs an explicit policy instead
 * of an unbounded backlog: this queue runs submissions one at a time in
 * arrival order, holds at most `maxDepth` waiting submissions, and answers
 * LEDGER_BUSY with a `retryAfterSeconds` hint when
 *   - the queue is full (reason "QUEUE_FULL", nothing is enqueued), or
 *   - a submission waited longer than `timeoutMs` before its turn
 *     (reason "QUEUE_TIMEOUT", it is not run).
 * A submission that has started is never interrupted (submit() is one
 * synchronous turn; check, nullifier insert and apply cannot be cut).
 * Between two submissions the queue yields to the event loop
 * (setImmediate), so HTTP I/O is served between ledger turns.
 * The HTTP adapter maps LEDGER_BUSY to 503 with a Retry-After header
 * (`ledgerBusyHttpStatus`).
 *
 * The target may be a UepLedger (synchronous) or a LedgerWorkerHost
 * (src/service/ledger-worker-host.ts, asynchronous: the ledger runs on a
 * worker thread so the Poseidon / SMT work does not block this event loop).
 *
 * Service-side adapter (src/service): uses timers; never called by a transition.
 */
import type { UepTransaction } from "../core/transaction.ts";
import type { BatchResult, SubmitResult } from "../testnet/ledger.ts";

export type LedgerBusyReason = "QUEUE_FULL" | "QUEUE_TIMEOUT";
export type LedgerBusyError = { error: { code: "LEDGER_BUSY"; message: string; reason: LedgerBusyReason; retryAfterSeconds: number } };

export type LedgerSubmitTarget = {
  submit(tx: UepTransaction): SubmitResult | Promise<SubmitResult>;
  submitBatch?(txs: UepTransaction[]): BatchResult | Promise<BatchResult>;
};

export type LedgerSubmitQueueOptions = {
  /** Most submissions waiting (not counting the running one). Default 256. */
  maxDepth?: number;
  /** Longest wait in the queue before a submission is answered QUEUE_TIMEOUT, ms. Default 30 000. */
  timeoutMs?: number;
  /** Upper bound of the Retry-After hint, seconds. Default 60. */
  maxRetryAfterSeconds?: number;
};

export type LedgerSubmitQueueStats = {
  depth: number;
  running: boolean;
  maxDepth: number;
  timeoutMs: number;
  accepted: number;
  completed: number;
  rejectedFull: number;
  timedOut: number;
  peakDepth: number;
  /** Moving average of the time one submission holds the ledger, ms. */
  avgServiceMs: number;
};

type Job = { run: () => unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void; enqueuedAt: number; timer?: ReturnType<typeof setTimeout>; done: boolean };

const DEFAULT_MAX_DEPTH = 256;
const DEFAULT_TIMEOUT_MS = 30_000;

export class LedgerSubmitQueue {
  readonly maxDepth: number;
  readonly timeoutMs: number;
  readonly maxRetryAfterSeconds: number;
  private readonly target: LedgerSubmitTarget;
  // Array with a moving head: O(1) dequeue amortized (compacted when half is consumed).
  private items: Job[] = [];
  private head = 0;
  private running = false;
  /** Waiting submissions that have not expired. */
  private live = 0;
  private stopped = false;
  private avgMs = 0;
  private readonly counters = { accepted: 0, completed: 0, rejectedFull: 0, timedOut: 0, peakDepth: 0 };

  constructor(target: LedgerSubmitTarget, opts: LedgerSubmitQueueOptions = {}) {
    if (!target || typeof target.submit !== "function") throw new Error("LEDGER_QUEUE_TARGET_INVALID");
    const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetry = opts.maxRetryAfterSeconds ?? 60;
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) throw new Error("LEDGER_QUEUE_CONFIG_INVALID: maxDepth");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("LEDGER_QUEUE_CONFIG_INVALID: timeoutMs");
    if (!Number.isSafeInteger(maxRetry) || maxRetry < 1) throw new Error("LEDGER_QUEUE_CONFIG_INVALID: maxRetryAfterSeconds");
    this.target = target;
    this.maxDepth = maxDepth;
    this.timeoutMs = timeoutMs;
    this.maxRetryAfterSeconds = maxRetry;
  }

  /** Queue one spend. Resolves with the ledger's result, or LEDGER_BUSY (queue full / wait timeout). */
  submit(tx: UepTransaction): Promise<SubmitResult | LedgerBusyError> {
    return this.enqueue(() => this.target.submit(tx)) as Promise<SubmitResult | LedgerBusyError>;
  }

  /** Queue one atomic batch (target must support submitBatch). */
  submitBatch(txs: UepTransaction[]): Promise<BatchResult | LedgerBusyError> {
    const target = this.target;
    if (typeof target.submitBatch !== "function") return Promise.reject(new Error("LEDGER_QUEUE_BATCH_UNSUPPORTED"));
    return this.enqueue(() => target.submitBatch!(txs)) as Promise<BatchResult | LedgerBusyError>;
  }

  get depth(): number {
    return this.live;
  }

  /** Seconds a new client should wait before retrying (>= 1, bounded). */
  retryAfterSeconds(): number {
    const work = (this.depth + (this.running ? 1 : 0)) * Math.max(this.avgMs, 1);
    return Math.min(this.maxRetryAfterSeconds, Math.max(1, Math.ceil(work / 1000)));
  }

  stats(): LedgerSubmitQueueStats {
    return { depth: this.depth, running: this.running, maxDepth: this.maxDepth, timeoutMs: this.timeoutMs, ...this.counters, avgServiceMs: Math.round(this.avgMs * 10) / 10 };
  }

  /** Refuse new submissions and answer every waiting one with QUEUE_TIMEOUT (shutdown). */
  close(): void {
    this.stopped = true;
    while (this.head < this.items.length) this.expire(this.items[this.head++]!, "QUEUE_TIMEOUT", "The submit queue was closed.");
    this.items = [];
    this.head = 0;
  }

  private busy(reason: LedgerBusyReason, message: string): LedgerBusyError {
    return { error: { code: "LEDGER_BUSY", message, reason, retryAfterSeconds: this.retryAfterSeconds() } };
  }

  private enqueue(run: () => unknown): Promise<unknown> {
    if (this.stopped) return Promise.resolve(this.busy("QUEUE_FULL", "The submit queue is closed."));
    if (this.depth >= this.maxDepth) {
      this.counters.rejectedFull++;
      return Promise.resolve(this.busy("QUEUE_FULL", `The submit queue is full (${this.maxDepth} waiting); retry later.`));
    }
    return new Promise((resolve, reject) => {
      const job: Job = { run, resolve, reject, enqueuedAt: performance.now(), done: false };
      job.timer = setTimeout(() => this.expire(job, "QUEUE_TIMEOUT", `The submission waited more than ${this.timeoutMs} ms in the queue; retry later.`), this.timeoutMs);
      this.items.push(job);
      this.live++;
      this.counters.accepted++;
      this.counters.peakDepth = Math.max(this.counters.peakDepth, this.depth);
      if (!this.running) this.schedule();
    });
  }

  private expire(job: Job, reason: LedgerBusyReason, message: string): void {
    if (job.done) return;
    job.done = true;
    this.live--;
    if (job.timer) clearTimeout(job.timer);
    this.counters.timedOut++;
    job.resolve(this.busy(reason, message));
  }

  private schedule(): void {
    this.running = true;
    setImmediate(() => void this.drainOne());
  }

  private next(): Job | undefined {
    while (this.head < this.items.length) {
      const job = this.items[this.head++]!;
      if (this.head > 1024 && this.head * 2 > this.items.length) {
        this.items = this.items.slice(this.head);
        this.head = 0;
      }
      if (!job.done) {
        this.live--;
        return job;
      }
    }
    return undefined;
  }

  private async drainOne(): Promise<void> {
    const job = this.next();
    if (!job) {
      this.running = false;
      return;
    }
    job.done = true;
    if (job.timer) clearTimeout(job.timer);
    const started = performance.now();
    try {
      job.resolve(await job.run());
    } catch (err) {
      job.reject(err);
    } finally {
      const ms = performance.now() - started;
      this.avgMs = this.counters.completed === 0 ? ms : this.avgMs * 0.8 + ms * 0.2;
      this.counters.completed++;
    }
    // Yield to the event loop between ledger turns.
    if (this.depth > 0) setImmediate(() => void this.drainOne());
    else this.running = false;
  }
}

/** HTTP mapping of LEDGER_BUSY: 503 with Retry-After (seconds). */
export function ledgerBusyHttpStatus(result: unknown): { status: 503; retryAfterSeconds: number } | undefined {
  const e = (result as { error?: { code?: unknown; retryAfterSeconds?: unknown } } | undefined)?.error;
  if (!e || e.code !== "LEDGER_BUSY") return undefined;
  const s = typeof e.retryAfterSeconds === "number" && Number.isFinite(e.retryAfterSeconds) ? Math.max(1, Math.ceil(e.retryAfterSeconds)) : 1;
  return { status: 503, retryAfterSeconds: s };
}
