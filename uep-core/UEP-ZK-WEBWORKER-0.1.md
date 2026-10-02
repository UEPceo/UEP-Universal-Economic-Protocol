# UEP Browser ZK Worker v0.1

The checkout proving boundary now supports a browser WebWorker. The UI thread creates a `BrowserZkProverClient`, which launches `zk-prover-worker.ts` and dynamically loads a browser-compatible Groth16 prover module.

The worker protocol is intentionally separate from the Node `child_process` bridge used by the current local Rust prover. This prevents Node-only code from entering the browser bundle.

A production browser prover module must export:

```ts
export async function prove(payload: unknown): Promise<unknown>;
```

The worker returns a structured success/error response and can be terminated on checkout cancellation. The current repository does not falsely claim that the existing Rust CLI is browser-compatible; the boundary is ready for a future, separately reviewed WASM prover artifact.
