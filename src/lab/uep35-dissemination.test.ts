import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNodeIdentity } from "./node-identity.ts";
import { bootDissemMesh, DissemNode } from "./uep35-dissemination.ts";
import {
  proposalFromEnvelope,
  signCommitVote,
  assembleCommitCert,
} from "./uep34-commit-cert.ts";
import { signEnvelope, NODE_PROTOCOL_VERSION } from "./node-protocol.ts";
import { buildFinalityCertificate } from "./uep35-finality.ts";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("UEP-35.1 multi-host dissemination", () => {
  it("proposal gossips to all mesh nodes", async () => {
    const ids = [0, 1, 2, 3].map((i) => createNodeIdentity(`d${i}`));
    const keys: Record<string, string> = {};
    for (const id of ids) keys[id.nodeId] = id.publicKeyHex;
    const mesh = await bootDissemMesh({
      nodeIds: ids.map((x) => x.nodeId),
      publicKeyOf: (id) => keys[id],
    });
    try {
      const env = signEnvelope(ids[0]!, {
        protocolVersion: NODE_PROTOCOL_VERSION,
        networkId: "local",
        domainId: 1,
        sequence: 1,
        previousStateRoot: "GENESIS",
        newStateRoot: "R1",
        transitionId: "t1",
        nullifier: "n1",
        ts: 1,
      });
      const prop = proposalFromEnvelope(env);
      mesh[0]!.broadcast({ type: "proposal", proposal: prop });
      await sleep(50);
      for (const n of mesh) {
        assert.ok(n.proposalBoard.get(prop.digest), n.cfg.nodeId);
      }
    } finally {
      await Promise.all(mesh.map((n) => n.close()));
    }
  });

  it("commit cert disseminated → markCommitted on peers", async () => {
    const ids = [0, 1, 2, 3].map((i) => createNodeIdentity(`c${i}`));
    const keys: Record<string, string> = {};
    for (const id of ids) keys[id.nodeId] = id.publicKeyHex;
    const mesh = await bootDissemMesh({
      nodeIds: ids.map((x) => x.nodeId),
      publicKeyOf: (id) => keys[id],
    });
    try {
      const env = signEnvelope(ids[0]!, {
        protocolVersion: NODE_PROTOCOL_VERSION,
        networkId: "local",
        domainId: 1,
        sequence: 1,
        previousStateRoot: "GENESIS",
        newStateRoot: "R1",
        transitionId: "t1",
        nullifier: "n1",
        ts: 1,
      });
      const prop = proposalFromEnvelope(env);
      mesh[0]!.broadcast({ type: "proposal", proposal: prop });
      const votes = ids.map((id) => signCommitVote(id, prop.digest));
      const cert = assembleCommitCert(prop, votes);
      mesh[0]!.broadcast({ type: "commit_cert", cert });
      await sleep(50);
      for (const n of mesh) {
        const rec = n.finality.get(1);
        assert.ok(rec, n.cfg.nodeId);
        assert.ok(
          rec!.stage === "committed" || rec!.stage === "final",
          rec!.stage,
        );
      }
    } finally {
      await Promise.all(mesh.map((n) => n.close()));
    }
  });
});
