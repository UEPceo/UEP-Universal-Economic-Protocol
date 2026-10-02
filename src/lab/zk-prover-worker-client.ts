/**
 * Main-thread client for the browser Groth16 worker.
 * One request owns one promise; cancellation terminates the worker so a stale
 * checkout cannot keep CPU busy after navigation/cancel.
 */
import type { ZkWorkerRequest, ZkWorkerResponse } from "./zk-prover-worker.ts";

export class BrowserZkProverClient {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly workerUrl: URL;
  private readonly moduleUrl: string;

  constructor(workerUrl: URL, moduleUrl: string) {
    this.workerUrl = workerUrl;
    this.moduleUrl = moduleUrl;
  }

  prove<TPayload, TResult>(payload: TPayload, signal?: AbortSignal): Promise<TResult> {
    if (typeof Worker === "undefined") return Promise.reject(new Error("WEBWORKER_UNAVAILABLE"));
    this.worker?.terminate();
    const worker = new Worker(this.workerUrl, { type: "module" });
    this.worker = worker;
    const id = `zk_${++this.seq}`;
    const request: ZkWorkerRequest = { id, moduleUrl: this.moduleUrl, payload };
    return new Promise<TResult>((resolve, reject) => {
      const cleanup = () => {
        worker.onmessage = null;
        worker.onerror = null;
        signal?.removeEventListener("abort", abort);
        if (this.worker === worker) this.worker = null;
      };
      const abort = () => {
        cleanup();
        worker.terminate();
        reject(new Error("ZK_PROVING_CANCELLED"));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      worker.onmessage = (event: MessageEvent<ZkWorkerResponse>) => {
        const response = event.data;
        if (response.id !== id) return;
        cleanup();
        worker.terminate();
        if (response.ok) resolve(response.result as TResult);
        else reject(new Error(response.error));
      };
      worker.onerror = (event) => {
        cleanup();
        worker.terminate();
        reject(new Error(event.message || "ZK_WORKER_ERROR"));
      };
      worker.postMessage(request);
    });
  }

  cancel(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
