/**
 * v0.5.3 (external review 2026-10-08): run the ledger on a worker thread.
 *
 * A UepLedger submit costs hundreds of milliseconds of Poseidon BN254 / SMT
 * work (depth 254, measured in docs/PERFORMANCE.md) and is synchronous: in the
 * service process it would block HTTP I/O for that long. LedgerWorkerHost
 * keeps the ledger in a worker_threads Worker (node:worker_threads, no
 * dependency) and exposes an asynchronous submit / submitBatch, so the
 * service event loop stays responsive. Put a LedgerSubmitQueue in front of it
 * for ordering, bounds and backpressure (the worker also applies its messages
 * one at a time).
 *
 * The worker is built from plain options (`new`) or restored from a signed
 * snapshot (`restore`, the usual path: the trust check runs in the worker).
 * Keys passed in are in-memory KeyObjects or strings (cloned to the worker).
 *
 * Service-side adapter; never imported by a transition.
 */
import { Worker } from "node:worker_threads";
import { deserializeTx, serializeTx, type UepTransaction } from "../core/transaction.ts";
import type { BatchResult, SubmitResult, UepLedger, UepLedgerSnapshot } from "../testnet/ledger.ts";
import type { LedgerSubmitTarget } from "./ledger-submit-queue.ts";

export type LedgerWorkerInit =
  | { mode: "new"; options: ConstructorParameters<typeof UepLedger>[0] }
  | { mode: "restore"; snapshot: UepLedgerSnapshot; trust: Parameters<typeof UepLedger.restore>[1]; keys?: Parameters<typeof UepLedger.restore>[2] };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class LedgerWorkerHost implements LedgerSubmitTarget {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  private constructor(worker: Worker) {
    this.worker = worker;
    worker.on("message", (msg: { id: number; ok: boolean; value?: unknown; error?: string }) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error));
    });
    const failAll = (err: Error) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    worker.on("error", failAll);
    worker.on("exit", (code) => failAll(new Error(`LEDGER_WORKER_EXITED: ${code}`)));
  }

  /** Start the worker and wait until its ledger is built (construction or restore errors reject). */
  static start(init: LedgerWorkerInit): Promise<LedgerWorkerHost> {
    const worker = new Worker(new URL("./ledger-worker.ts", import.meta.url), { workerData: init });
    const host = new LedgerWorkerHost(worker);
    return new Promise((resolve, reject) => {
      host.pending.set(0, { resolve: () => resolve(host), reject: (e) => { void worker.terminate(); reject(e); } });
      worker.once("error", (e) => reject(e));
    });
  }

  private call<T>(op: string, ...args: unknown[]): Promise<T> {
    if (this.closed) return Promise.reject(new Error("LEDGER_WORKER_CLOSED"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, op, args });
    });
  }

  async submit(tx: UepTransaction): Promise<SubmitResult> {
    const r = await this.call<{ tx?: ReturnType<typeof serializeTx>; error?: unknown }>("submit", serializeTx(tx));
    return ("tx" in r && r.tx ? { tx: deserializeTx(r.tx) } : r) as SubmitResult;
  }

  async submitBatch(txs: UepTransaction[]): Promise<BatchResult> {
    const r = await this.call<{ txs?: ReturnType<typeof serializeTx>[] }>("submitBatch", txs.map(serializeTx));
    return (r.txs ? { txs: r.txs.map(deserializeTx) } : r) as BatchResult;
  }

  faucet(accountIdHex: string, asset: string, amount: bigint): Promise<true> {
    return this.call("faucet", accountIdHex, asset, amount.toString());
  }

  status(): Promise<{ height: number; stateRoot: string; txCount: number }> {
    return this.call("status");
  }

  snapshot(): Promise<UepLedgerSnapshot> {
    return this.call("snapshot");
  }

  advanceHeight(blocks: number): Promise<number> {
    return this.call("advanceHeight", blocks);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.worker.terminate();
  }
}
