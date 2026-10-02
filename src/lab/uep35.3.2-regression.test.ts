import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNodeIdentity } from "./node-identity.ts";
import { bootDissemMesh, DissemNode } from "./uep35-dissemination.ts";
import { proposalFromEnvelope } from "./uep34-commit-cert.ts";
import { signEnvelope, NODE_PROTOCOL_VERSION } from "./node-protocol.ts";
import { buildFinalityCertificate } from "./uep35-finality.ts";
import { verifyCommitCert, assembleCommitCert, signCommitVote } from "./uep34-commit-cert.ts";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("UEP-35.3.2 BFT + catch-up regression", () => {
  it("verifyCommitCert BFT-CLASSIC rejects N=5", () => {
    const ids = [0, 1, 2, 3, 4].map((i) => createNodeIdentity(`x${i}`));
    const keys: Record<string, string> = {};
    for (const id of ids) keys[id.nodeId] = id.publicKeyHex;
    const leader = ids[0]!;
    const env = signEnvelope(leader, {
      protocolVersion: NODE_PROTOCOL_VERSION,
      networkId: "local",
      domainId: 1,
      sequence: 1,
      previousStateRoot: "GENESIS",
      newStateRoot: "R",
      transitionId: "t",
      nullifier: "n",
      ts: 1,
    });
    const prop = proposalFromEnvelope(env);
    // 3 votes would be majority of 5 but not 2f+1 with classic (invalid N)
    const votes = ids.slice(0, 3).map((id) => signCommitVote(id, prop.digest));
    const cert = assembleCommitCert(prop, votes);
    const r = verifyCommitCert(
      cert,
      ids.map((x) => x.nodeId),
      (id) => keys[id],
      undefined,
      { bftProfile: "BFT-CLASSIC" },
    );
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /BFT_CONFIG|NON_CLASSIC/);
  });

  it("partition → advance → heal → catch-up → same finals", async () => {
    const ids = [0, 1, 2, 3].map((i) => createNodeIdentity(`r${i}`));
    const keys: Record<string, string> = {};
    const idMap = new Map(ids.map((id) => [id.nodeId, id]));
    for (const id of ids) keys[id.nodeId] = id.publicKeyHex;
    const mesh = await bootDissemMesh({
      nodeIds: ids.map((x) => x.nodeId),
      publicKeyOf: (id) => keys[id],
      identities: idMap,
      bftProfile: "BFT-CLASSIC",
    });
    try {
      const lag = mesh[3]!;
      lag.enterPartition();
      for (const seq of [1, 2]) {
        const env = signEnvelope(ids[0]!, {
          protocolVersion: NODE_PROTOCOL_VERSION,
          networkId: "local",
          domainId: 1,
          sequence: seq,
          previousStateRoot: seq === 1 ? "GENESIS" : `R${seq - 1}`,
          newStateRoot: `R${seq}`,
          transitionId: `t${seq}`,
          nullifier: `n${seq}`,
          ts: seq,
        });
        const prop = proposalFromEnvelope(env);
        mesh[0]!.broadcast({ type: "proposal", proposal: prop });
        await sleep(100);
        const cert = mesh[0]!.getCommitCert(prop.digest);
        if (cert) {
          const fc = buildFinalityCertificate(prop, cert, {
            networkId: "local",
            domainId: 1,
            epoch: 0,
            finalizers: ids,
          });
          mesh[0]!.broadcast({ type: "finality_cert", cert: fc });
          await sleep(40);
        }
      }
      assert.equal(mesh[0]!.finality.isFinal(2), true);
      assert.equal(lag.finality.isFinal(2), false);
      lag.healAndCatchup();
      await sleep(200);
      assert.equal(lag.finality.isFinal(1), true);
      assert.equal(lag.finality.isFinal(2), true);
      assert.equal(lag.finality.get(2)!.stateRoot, mesh[0]!.finality.get(2)!.stateRoot);
    } finally {
      await Promise.all(mesh.map((n) => n.close()));
    }
  });
});
