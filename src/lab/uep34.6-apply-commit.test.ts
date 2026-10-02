import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNodeIdentity, NodeRegistry, registryFromIdentity } from "./node-identity.ts";
import { LabNode, NODE_PROTOCOL_VERSION, signEnvelope } from "./node-protocol.ts";
import {
  ProposalBoard,
  proposalFromEnvelope,
  signCommitVote,
  assembleCommitCert,
  envelopeProposalDigest,
} from "./uep34-commit-cert.ts";
import { bootCommitLab } from "./uep34-commit-lab.ts";
import { envelopeBody } from "./node-protocol.ts";

describe("UEP-34.6 LabNode.apply requires CommitCert", () => {
  it("apply(env) alone fails when requireCommitCert=true", () => {
    const leader = createNodeIdentity("L");
    const rep = createNodeIdentity("R");
    const reg = new NodeRegistry();
    reg.register(registryFromIdentity(leader, { networkId: "local", domainId: 1, role: "sequencer" }));
    reg.register(registryFromIdentity(rep, { networkId: "local", domainId: 1, role: "replica" }));
    const board = new ProposalBoard();
    const node = new LabNode(rep, "local", 1, leader.publicKeyHex, leader.nodeId, {
      requireCommitCert: true,
      commitCandidates: [leader.nodeId, rep.nodeId],
      commitPublicKeyOf: (id) => reg.publicKeyHex(id),
      proposalBoard: board,
    });
    // Build envelope as leader
    const env = signEnvelope(leader, {
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
    const r = node.apply(env);
    assert.equal(r.ok, false);
    assert.equal((r as { error: string }).error, "COMMIT_CERT_REQUIRED");
  });

  it("apply with valid CommitCert succeeds", () => {
    const a = createNodeIdentity("a");
    const b = createNodeIdentity("b");
    const c = createNodeIdentity("c");
    const candidates = [a.nodeId, b.nodeId, c.nodeId];
    const reg = new NodeRegistry();
    for (const id of [a, b, c]) {
      reg.register(registryFromIdentity(id, { networkId: "local", domainId: 1, role: "sequencer" }));
    }
    const board = new ProposalBoard();
    const node = new LabNode(b, "local", 1, a.publicKeyHex, a.nodeId, {
      requireCommitCert: true,
      commitCandidates: candidates,
      commitPublicKeyOf: (id) => reg.publicKeyHex(id),
      proposalBoard: board,
    });
    const env = signEnvelope(a, {
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
    board.register(prop);
    const votes = [a, b, c].map((id) => signCommitVote(id, prop.digest));
    const cert = assembleCommitCert(prop, votes);
    const r = node.apply(env, { commitCert: cert });
    assert.equal(r.ok, true, (r as { error?: string }).error);
    assert.equal(node.stateRoot, "R1");
  });

  it("proposal digest covers full envelopeBody (proof/vk/pubs included)", () => {
    const leader = createNodeIdentity("L");
    const base = {
      protocolVersion: NODE_PROTOCOL_VERSION,
      networkId: "local",
      domainId: 1,
      sequence: 1,
      previousStateRoot: "GENESIS",
      newStateRoot: "R1",
      transitionId: "t1",
      nullifier: "n1",
      ts: 1,
    };
    const env1 = signEnvelope(leader, { ...base });
    const env2 = signEnvelope(leader, {
      ...base,
      proofHex: "aabb",
      publicInputsHex: ["01", "02"],
      vkHex: "ccdd",
    });
    const d1 = envelopeProposalDigest(env1);
    const d2 = envelopeProposalDigest(env2);
    assert.notEqual(d1, d2);
    assert.ok(d1.includes(envelopeBody(env1)));
    assert.ok(d2.includes("proof=aabb"));
  });

  it("CommitLab still works with enforced apply", () => {
    const lab = bootCommitLab({ n: 4 });
    // All nodes have requireCommitCert
    assert.ok(lab.nodes.every((n) => n.lab.requireCommitCert));
    const c1 = lab.commitTransition({
      newStateRoot: "R1",
      transitionId: "t1",
      nullifier: "n1",
    });
    assert.equal(c1.ok, true, (c1 as { error?: string }).error);
    // Direct apply without cert must fail
    const leader = lab.nodes.find((n) => n.id.nodeId === lab.leaderId())!;
    const env = leader.lab.propose({
      previousStateRoot: leader.lab.stateRoot,
      newStateRoot: "BYPASS",
      transitionId: "bypass",
      nullifier: "nbypass",
    });
    const bypass = leader.lab.apply(env);
    assert.equal(bypass.ok, false);
    assert.equal((bypass as { error: string }).error, "COMMIT_CERT_REQUIRED");
  });
});
