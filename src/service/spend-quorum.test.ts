import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorageProvider } from "./memory-storage.ts";
import { SpendInbox } from "./uep-service-backends.ts";
import { Groth16SpendQueue, SpendQuorum } from "./groth16-spend-queue.ts";
import { UepServiceApi } from "./uep-service-api.ts";
import { listenUepHttpApi } from "./uep-http-api.ts";

describe("UEP-API-001.4 spend quorum", () => {
  it("two votes do not finalize; three votes do", async () => {
    const q = new Groth16SpendQueue(32);
    const quorum = new SpendQuorum();
    const api = new UepServiceApi({
      storageProviders: new Map([["memory", new MemoryStorageProvider()]]),
      spends: new SpendInbox((input) => Promise.resolve(q.accept(input))),
      groth16: q,
      quorum,
    });
    const { server, port } = await listenUepHttpApi({ api });
    try {
      await fetch(`http://127.0.0.1:${port}/v1/spends`, {
        method: "POST",
        body: JSON.stringify({ sender: "alice", recipient: "bob", amount: "1000", nonce: "q1", domainId: "lab" }),
      });
      const proved = await fetch(`http://127.0.0.1:${port}/v1/spends/prove`, { method: "POST" });
      const provedBody = await proved.json() as { data: { spends: { spendId: string; newRoot: string; final: boolean }[] } };
      const row = provedBody.data.spends[0]!;
      assert.equal(row.final, false);
      const proof = q.proofOf(row.spendId)!;
      const votes = ["p4-0", "p4-1", "p4-2"].map((id) => quorum.vote(id, row.spendId, row.newRoot, proof));
      const short = await fetch(`http://127.0.0.1:${port}/v1/spends/commit`, {
        method: "POST",
        body: JSON.stringify({ spendId: row.spendId, votes: votes.slice(0, 2) }),
      });
      assert.equal(short.status, 403);
      const full = await fetch(`http://127.0.0.1:${port}/v1/spends/commit`, {
        method: "POST",
        body: JSON.stringify({ spendId: row.spendId, votes }),
      });
      const fullBody = await full.json() as { data: { final: boolean } };
      assert.equal(full.status, 200);
      assert.equal(fullBody.data.final, true);
      const forged = quorum.vote("p4-3", row.spendId, "00".repeat(32), proof);
      const bad = await fetch(`http://127.0.0.1:${port}/v1/spends/commit`, {
        method: "POST",
        body: JSON.stringify({ spendId: row.spendId, votes: [votes[0], votes[1], forged] }),
      });
      assert.equal(bad.status, 403);
    } finally {
      await new Promise((r) => server.close(() => r(undefined)));
    }
  });
});
