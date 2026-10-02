/**
 * Browser WebWorker boundary for Groth16 proving.
 *
 * The worker deliberately loads a browser-compatible prover module dynamically.
 * The module must export `prove(payload)`. This keeps the heavy proving work
 * off the UI thread without importing Node-only child_process code into Vite.
 */
export type ZkWorkerRequest = {
  id: string;
  moduleUrl: string;
  payload: unknown;
};

export type ZkWorkerResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

self.onmessage = async (event: MessageEvent<ZkWorkerRequest>) => {
  const req = event.data;
  try {
    if (!req?.id || !req.moduleUrl) throw new Error("INVALID_WORKER_REQUEST");
    const mod = await import(/* @vite-ignore */ req.moduleUrl) as { prove?: (payload: unknown) => unknown | Promise<unknown> };
    if (typeof mod.prove !== "function") throw new Error("BROWSER_PROVER_EXPORT_MISSING");
    const result = await mod.prove(req.payload);
    const response: ZkWorkerResponse = { id: req.id, ok: true, result };
    self.postMessage(response);
  } catch (error) {
    const response: ZkWorkerResponse = { id: req?.id ?? "unknown", ok: false, error: error instanceof Error ? error.message : String(error) };
    self.postMessage(response);
  }
};
