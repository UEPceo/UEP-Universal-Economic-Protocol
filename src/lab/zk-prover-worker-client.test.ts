import test from "node:test";
import assert from "node:assert/strict";
import { BrowserZkProverClient } from "./zk-prover-worker-client.ts";

test("browser ZK worker client rejects cleanly when WebWorker is unavailable", async () => {
  const client = new BrowserZkProverClient(new URL("./zk-prover.worker.ts", import.meta.url), "./browser-prover.js");
  await assert.rejects(() => client.prove({}), /WEBWORKER_UNAVAILABLE/);
});
