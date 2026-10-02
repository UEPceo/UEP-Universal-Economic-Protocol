import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNodeIdentity } from "./node-identity.ts";
import { DissemNode } from "./uep35-dissemination.ts";
import {
  proposalFromEnvelope,
  signCommitVote,
  assembleCommitCert,
} from "./uep34-commit-cert.ts";
import { signEnvelope, NODE_PROTOCOL_VERSION } from "./node-protocol.ts";
import { buildFinalityCertificate } from "./uep35-finality.ts";
import { assertBftConfig } from "./uep35-bft-gate.ts";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Boot two partitions of a 4-node classic BFT set: A={0,1} B={2,3}.
 * Full connect within partition only.
 */
async function bootPartitioned4(): Promise<{
  ids: ReturnType<typeof createNodeIdentity>[];
  keys: Record<string, string>;
  nodes: DissemNode[];
  partA: DissemNode[];
  partB: DissemNode[];
}> {
  const ids = [0, 1, 2, 3].map((i) => createNodeIdentity(`p${i}`));
  const keys: Record<string, string> = {};
  for (const id of ids) keys[id.nodeId] = id.publicKeyHex;
  const gate = assertBftConfig(4, "BFT-CLASSIC");
  assert.equal(gate.ok, true);

  const nodes: DissemNode[] = [];
  for (const id of ids) {
    const n = new DissemNode({
      nodeId: id.nodeId,
      networkId: "local",
      domainId: 1,
      candidates: ids.map((x) => x.nodeId),
      publicKeyOf: (x) => keys[x],
    });
    await n.listen(0);
    nodes.push(n);
  }
  const partA = [nodes[0]!, nodes[1]!];
  const partB = [nodes[2]!, nodes[3]!];
  // Intra-partition mesh only
  for (const group of [partA, partB]) {
    for (let i = 0; i < group.length; i++) {
      for (let j = 0; j < group.length; j++) {
        if (i === j) continue;
        await group[i]!.connect("127.0.0.1", group[j]!.listenPort);
      }
    }
  }
  await sleep(40);
  return { ids, keys, nodes, partA, partB };
}

describe("UEP-35.2 partition adversarial suite", () => {
  it("minority partition cannot finalize (only 2 of 4 < quorum 3)", async () => {
    const { ids, keys, nodes, partA } = await bootPartitioned4();
    try {
      const leader = ids[0]!;
      const env = signEnvelope(leader, {
        protocolVersion: NODE_PROTOCOL_VERSION,
        networkId: "local",
        domainId: 1,
        sequence: 1,
        previousStateRoot: "GENESIS",
        newStateRoot: "ROOT-A",
        transitionId: "ta",
        nullifier: "na",
        ts: 1,
      });
      const prop = proposalFromEnvelope(env);
      // Only partition A votes (2 nodes) — insufficient for quorum 3
      const votes = partA.map((n) => {
        const id = ids.find((x) => x.nodeId === n.cfg.nodeId)!;
        return signCommitVote(id, prop.digest);
      });
      const cert = assembleCommitCert(prop, votes);
      // Even if we try to build finality with only A finalizers
      const fc = buildFinalityCertificate(prop, cert, {
        networkId: "local",
        domainId: 1,
        epoch: 0,
        finalizers: ids.slice(0, 2),
      });
      for (const n of partA) {
        n.broadcast({ type: "proposal", proposal: prop });
      }
      await sleep(30);
      const r = partA[0]!.finality.acceptFinal(
        fc,
        ids.map((x) => x.nodeId),
        (id) => keys[id],
        { requireClassicBft: true },
      );
      // CommitCert itself lacks quorum
      assert.equal(r.ok, false);
      assert.match((r as { reason: string }).reason, /COMMIT_CERT|QUORUM/);
    } finally {
      await Promise.all(nodes.map((n) => n.close()));
    }
  });

  it("two partitions cannot both finalize conflicting roots", async () => {
    const { ids, keys, nodes, partA, partB } = await bootPartitioned4();
    try {
      const envA = signEnvelope(ids[0]!, {
        protocolVersion: NODE_PROTOCOL_VERSION,
        networkId: "local",
        domainId: 1,
        sequence: 1,
        previousStateRoot: "GENESIS",
        newStateRoot: "FORK-A",
        transitionId: "fa",
        nullifier: "nfa",
        ts: 1,
      });
      const envB = signEnvelope(ids[0]!, {
        protocolVersion: NODE_PROTOCOL_VERSION,
        networkId: "local",
        domainId: 1,
        sequence: 1,
        previousStateRoot: "GENESIS",
        newStateRoot: "FORK-B",
        transitionId: "fb",
        nullifier: "nfb",
        ts: 2,
      });
      const propA = proposalFromEnvelope(envA);
      const propB = proposalFromEnvelope(envB);

      // Each partition only has 2 voters — neither can form classic quorum alone
      const votesA = partA.map((n) =>
        signCommitVote(ids.find((x) => x.nodeId === n.cfg.nodeId)!, propA.digest),
      );
      const votesB = partB.map((n) =>
        signCommitVote(ids.find((x) => x.nodeId === n.cfg.nodeId)!, propB.digest),
      );
      const certA = assembleCommitCert(propA, votesA);
      const certB = assembleCommitCert(propB, votesB);
      const fcA = buildFinalityCertificate(propA, certA, {
        networkId: "local",
        domainId: 1,
        epoch: 0,
        finalizers: ids.slice(0, 2),
      });
      const fcB = buildFinalityCertificate(propB, certB, {
        networkId: "local",
        domainId: 1,
        epoch: 0,
        finalizers: ids.slice(2, 4),
      });

      const rA = partA[0]!.finality.acceptFinal(
        fcA,
        ids.map((x) => x.nodeId),
        (id) => keys[id],
        { requireClassicBft: true },
      );
      const rB = partB[0]!.finality.acceptFinal(
        fcB,
        ids.map((x) => x.nodeId),
        (id) => keys[id],
        { requireClassicBft: true },
      );
      assert.equal(rA.ok, false);
      assert.equal(rB.ok, false);
    } finally {
      await Promise.all(nodes.map((n) => n.close()));
    }
  });

  it("after heal, full quorum can finalize one root", async () => {
    const { ids, keys, nodes } = await bootPartitioned4();
    try {
      // Heal: connect all partitions into full mesh
      for (let i = 0; i < nodes.length; i++) {
        for (let j = 0; j < nodes.length; j++) {
          if (i === j) continue;
          try {
            await nodes[i]!.connect("127.0.0.1", nodes[j]!.listenPort);
          } catch {
            /* may already be connected */
          }
        }
      }
      await sleep(40);

      const env = signEnvelope(ids[0]!, {
        protocolVersion: NODE_PROTOCOL_VERSION,
        networkId: "local",
        domainId: 1,
        sequence: 1,
        previousStateRoot: "GENESIS",
        newStateRoot: "HEALED",
        transitionId: "th",
        nullifier: "nh",
        ts: 1,
      });
      const prop = proposalFromEnvelope(env);
      const votes = ids.map((id) => signCommitVote(id, prop.digest));
      const cert = assembleCommitCert(prop, votes);
      const fc = buildFinalityCertificate(prop, cert, {
        networkId: "local",
        domainId: 1,
        epoch: 0,
        finalizers: ids,
      });
      nodes[0]!.broadcast({ type: "proposal", proposal: prop });
      nodes[0]!.broadcast({ type: "commit_cert", cert });
      nodes[0]!.broadcast({ type: "finality_cert", cert: fc });
      await sleep(60);
      // All should see FINAL
      for (const n of nodes) {
        assert.equal(n.finality.isFinal(1), true, n.cfg.nodeId);
        assert.equal(n.finality.get(1)!.stateRoot, "HEALED");
      }
    } finally {
      await Promise.all(nodes.map((n) => n.close()));
    }
  });

  it("enterPartition drops dissemination", async () => {
    const ids = [0, 1].map((i) => createNodeIdentity(`x${i}`));
    const keys: Record<string, string> = {};
    for (const id of ids) keys[id.nodeId] = id.publicKeyHex;
    const a = new DissemNode({
      nodeId: ids[0]!.nodeId,
      networkId: "local",
      domainId: 1,
      candidates: ids.map((x) => x.nodeId),
      publicKeyOf: (id) => keys[id],
      bftProfile: "LAB-MAJORITY",
    });
    const b = new DissemNode({
      nodeId: ids[1]!.nodeId,
      networkId: "local",
      domainId: 1,
      candidates: ids.map((x) => x.nodeId),
      publicKeyOf: (id) => keys[id],
      bftProfile: "LAB-MAJORITY",
    });
    await a.listen(0);
    await b.listen(0);
    await a.connect("127.0.0.1", b.listenPort);
    await b.connect("127.0.0.1", a.listenPort);
    await sleep(30);
    b.enterPartition();
    const env = signEnvelope(ids[0]!, {
      protocolVersion: NODE_PROTOCOL_VERSION,
      networkId: "local",
      domainId: 1,
      sequence: 1,
      previousStateRoot: "GENESIS",
      newStateRoot: "DROP",
      transitionId: "td",
      nullifier: "nd",
      ts: 1,
    });
    const prop = proposalFromEnvelope(env);
    a.broadcast({ type: "proposal", proposal: prop });
    await sleep(40);
    // a has it; b partitioned should not process
    assert.ok(a.proposalBoard.get(prop.digest));
    assert.equal(b.proposalBoard.get(prop.digest), undefined);
    b.healPartition();
    a.broadcast({ type: "proposal", proposal: prop });
    await sleep(40);
    assert.ok(b.proposalBoard.get(prop.digest));
    await a.close();
    await b.close();
  });
});
